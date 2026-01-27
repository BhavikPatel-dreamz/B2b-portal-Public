import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCreditSummary } from "../services/creditService";
import {
  getCompanyDashboardData,
  updateCredit,
} from "../services/company.server";
import {
  parseForm,
  parseCredit,
  syncShopifyUsers,
} from "../utils/company.server";
import { useEffect, useState } from "react";
import { getCompanyOrdersCount } from "app/utils/b2b-customer.server";
import {
  recalculateCompanyCredit,
  previewCreditRecalculation,
} from "../services/creditRecalculation.server";

type LoaderData = {
  company: {
    paymentTermsTemplateId: string;
    id: string;
    name: string;
    contactName: string | null;
    contactEmail: string | null;
    shopifyCompanyId: string | null;
    isDisable: boolean;
  };
  creditLimit: number;
  availableCredit: number;
  usedCredit: number;
  pendingCredit: number;
  creditPercentageUsed: number;
  pendingOrderCount: number;
  recentOrders: Array<{
    id: string;
    shopifyOrderId: string | null;
    orderTotal: number;
    paidAmount: number;
    remainingBalance: number;
    creditUsed: number;
    paymentStatus: string;
    orderStatus: string;
    createdAt: string;
    createdBy: string;
  }>;
  orderStats: {
    total: number;
    paid: number;
    unpaid: number;
    pending: number;
  };
  users: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    companyRole: string | null;
    status: string;
    createdAt: string;
  }>;
  totalUsers: number;
};

const buildUserErrorList = (payload: any): string[] => {
  const errors: string[] = [];

  /* 1️⃣ Top-level GraphQL errors */
  if (Array.isArray(payload?.errors)) {
    for (const err of payload.errors) {
      if (typeof err === "string") {
        errors.push(err);
      } else if (err?.message) {
        errors.push(err.message);
      }
    }
  }

  /* 2️⃣ Shopify userErrors (generic, mutation-agnostic) */
  const data = payload?.data;
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const node = data[key];
      if (Array.isArray(node?.userErrors) && node.userErrors.length) {
        for (const err of node.userErrors) {
          if (err?.message) {
            errors.push(err.message);
          } else if (Array.isArray(err?.field)) {
            errors.push(err.field.join("."));
          } else {
            errors.push("Unknown error");
          }
        }
      }
    }
  }

  return errors;
};

async function fetchOrdersCount(
  shopName: string,
  accessToken: string,
  queryString: string,
): Promise<number> {
  const query = `
    query OrdersCount($query: String!) {
      ordersCount(query: $query) {
        count
      }
    }
  `;

  const response = await fetch(
    `https://${shopName}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { query: queryString },
      }),
    },
  );

  const data = await response.json();

  if (data.errors) {
    console.error("OrdersCount error:", data.errors);
    return 0;
  }

  return data.data?.ordersCount?.count ?? 0;
}

export async function getCompanyOrderStats(
  shopName: string,
  accessToken: string,
  baseQuery: string,
) {
  const [total, paid, unpaid, pending] = await Promise.all([
    fetchOrdersCount(shopName, accessToken, baseQuery),
    fetchOrdersCount(
      shopName,
      accessToken,
      `${baseQuery} financial_status:paid`,
    ),
    fetchOrdersCount(
      shopName,
      accessToken,
      `${baseQuery} financial_status:unpaid`,
    ),
    fetchOrdersCount(
      shopName,
      accessToken,
      `${baseQuery} financial_status:pending`,
    ),
  ]);

  return {
    total,
    paid,
    unpaid,
    pending,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { intent: "unknown", success: false, errors: ["Store not found"] },
      { status: 404 },
    );
  }

  const form = await parseForm(request);
  const intent = (form.intent as string) || "";

  switch (intent) {
    case "updateCredit": {
      const formData = new FormData();
      formData.append("id", (form.id as string) || "");
      formData.append("creditLimit", (form.creditLimit as string) || "0");

      const result = await updateCredit(formData, admin);
      return Response.json(result);
    }
    case "updatepaymentTerm": {
      const companyId = (form.id as string)?.trim();
      const paymentTermsTemplateId = (form.paymentTerm as string)?.trim();

      if (!companyId) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company id is required"],
        });
      }
      if (!paymentTermsTemplateId) {
        return Response.json({
          intent,
          success: false,
          errors: ["Payment terms is required"],
        });
      }

      /* 1️⃣ Fetch ALL company locations from Shopify */
      const locationsResponse = await admin.graphql(
        `#graphql
    query GetCompanyLocations($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 50) {
          nodes {
            id
            name
          }
        }
      }
    }`,
        {
          variables: { companyId },
        },
      );

      const locationsPayload = await locationsResponse.json();
      const locations = locationsPayload?.data?.company?.locations?.nodes || [];

      if (!locations.length) {
        return Response.json({
          intent,
          success: false,
          errors: ["No company locations found"],
        });
      }

      /* 2️⃣ Assign payment terms to EACH location */
      for (const location of locations) {
        const updateLocationResponse = await admin.graphql(
          `#graphql
      mutation UpdateCompanyLocation(
        $companyLocationId: ID!
        $paymentTermsTemplateId: ID!
      ) {
        companyLocationUpdate(
          companyLocationId: $companyLocationId
          input: {
            buyerExperienceConfiguration: {
              paymentTermsTemplateId: $paymentTermsTemplateId
            }
          }
        ) {
          companyLocation { id }
          userErrors { field message }
        }
      }`,
          {
            variables: {
              companyLocationId: location.id,
              paymentTermsTemplateId,
            },
          },
        );

        const updatePayload = await updateLocationResponse.json();
        const errors = buildUserErrorList(updatePayload);

        if (errors.length) {
          return Response.json({
            intent,
            success: false,
            errors,
          });
        }
      }

      /* 3️⃣ Sync payment terms in Prisma */
      const companyData = await prisma.companyAccount.findFirst({
        where: { shopifyCompanyId: companyId },
      });
      if (companyData) {
      await prisma.companyAccount.update({
        where: { id: companyData.id },
        data: { paymentTerm: paymentTermsTemplateId },
      });
    }

      /* 4️⃣ Success response */
      return Response.json({
        intent,
        success: true,
        message: "Payment terms updated for all company locations",
      });
    }

    case "createCompany": {
      const name = (form.name as string)?.trim();
      const shopifyCompanyId =
        (form.shopifyCompanyId as string)?.trim() || null;
      const contactName = (form.contactName as string)?.trim() || null;
      const contactEmail = (form.contactEmail as string)?.trim() || null;
      const credit = parseCredit((form.creditLimit as string) || undefined);

      if (!name) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company name is required"],
        });
      }
      if (!credit) {
        return Response.json({
          intent,
          success: false,
          errors: ["Credit must be a number"],
        });
      }

      if (shopifyCompanyId) {
        await prisma.companyAccount.upsert({
          where: {
            shopId_shopifyCompanyId: {
              shopId: store.id,
              shopifyCompanyId,
            },
          },
          update: {
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
          create: {
            shopId: store.id,
            shopifyCompanyId,
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
        });
      } else {
        await prisma.companyAccount.create({
          data: {
            shopId: store.id,
            shopifyCompanyId: null,
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
        });
      }

      return Response.json({ intent, success: true, message: "Company saved" });
    }

    case "syncUsers": {
      try {
        const companyId = (form.companyId as string)?.trim();
        if (!companyId) {
          return Response.json(
            {
              intent,
              success: false,
              errors: ["Company ID is required"],
            },
            { status: 400 },
          );
        }
        const result = await syncShopifyUsers(admin, store, companyId);
        return Response.json({
          intent,
          success: result.success,
          message: result.message,
          syncedCount: result.syncedCount,
          errors: result.errors,
        });
      } catch (error) {
        return Response.json(
          {
            intent,
            success: false,
            message: "Failed to sync users",
            errors: [error instanceof Error ? error.message : "Unknown error"],
          },
          { status: 500 },
        );
      }
    }
    case "deactivateCompany": {
      const id = (form.id as string)?.trim();

      if (!id) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company id is required"],
        });
      }
      const orderData = await prisma.b2BOrder.findMany({
        where: {
          companyId: id,
          orderStatus: { in: ["unfulfilled"] },
          paymentStatus: { in: ["pending", "unpaid"] },
        },
      });
      if (orderData.length > 0) {
       
        return Response.json({
          intent,
          success: false,
          errors: [
            "You can't deactivate this company because it has pending orders",
          ],
        });
      }

      const companyData = await prisma.companyAccount.update({
        where: { id },
        data: { isDisable: true },
      });
      const registrationData = await prisma.registrationSubmission.findFirst({
        where: { companyName: companyData.name },
      });
      if (!registrationData) {
        return Response.json({
          intent,
          success: false,
          errors: ["Registration data not found"],
        });
      }
      await prisma.registrationSubmission.update({
        where: { id: registrationData.id },
        data: { isDisable: true },
      });
      const userData = await prisma.user.findMany({
        where: { companyId: companyData.id },
      });
      if (!userData.length) {
        return Response.json({
          intent,
          success: false,
          errors: ["User data not found"],
        });
      }
      await prisma.user.updateMany({
        where: {
          id: {
            in: userData.map((user) => user.id),
          },
        },
        data: { isActive: false },
      });

      return Response.json({
        intent,
        success: true,
        message: "Company deactivated",
      });
    }
    case "reActivateCompany": {
      const id = (form.id as string)?.trim();

      if (!id) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company id is required"],
        });
      }

      const companyData = await prisma.companyAccount.update({
        where: { id },
        data: { isDisable: false },
      });
      const registrationData = await prisma.registrationSubmission.findFirst({
        where: { companyName: companyData.name },
      });
      if (!registrationData) {
        return Response.json({
          intent,
          success: false,
          errors: ["Registration data not found"],
        });
      }
      await prisma.registrationSubmission.update({
        where: { id: registrationData.id },
        data: { isDisable: false },
      });
      const userData = await prisma.user.findMany({
        where: { companyId: companyData.id },
      });
      if (!userData.length) {
        return Response.json({
          intent,
          success: false,
          errors: ["User data not found"],
        });
      }
      await prisma.user.updateMany({
        where: {
          id: {
            in: userData.map((user) => user.id),
          },
        },
        data: { isActive: true },
      });
      return Response.json({
        intent,
        success: true,
        message: "Company reactivated",
      });
    }
    case "orderCount": {
      const query = (form.query as string)?.trim();

      if (!query) {
        return Response.json({
          intent,
          success: false,
          errors: ["Query is required"],
        });
      }

      if (!session.accessToken) {
        return Response.json({
          intent,
          success: false,
          errors: ["Access token is required"],
        });
      }

      const orderStats = await getCompanyOrdersCount(
        session.shop,
        session.accessToken,
        query,
      );

      return Response.json({
        intent,
        success: true,
        orderStats,
      });
    }

    case "recalculateCredit": {
      const companyId = (form.companyId as string)?.trim();

      if (!companyId) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company ID is required"],
        });
      }

      try {
        console.log(
          `🔄 Starting credit recalculation for company ${companyId}`,
        );

        const result = await recalculateCompanyCredit(companyId, admin);

        if (result.success) {
          return Response.json({
            intent,
            success: true,
            message: result.message,
            data: {
              unpaidOrdersCount: result.unpaidOrdersCount,
              unpaidOrdersTotal: result.unpaidOrdersTotal.toNumber(),
              transactionsRecreated: result.transactionsRecreated,
              newCreditUsed: result.newCreditUsed.toNumber(),
            },
          });
        } else {
          return Response.json({
            intent,
            success: false,
            errors: [result.message],
          });
        }
      } catch (error) {
        console.error(`❌ Error in recalculateCredit action:`, error);
        return Response.json({
          intent,
          success: false,
          errors: [
            `Failed to recalculate credit: ${error instanceof Error ? error.message : "Unknown error"}`,
          ],
        });
      }
    }

    case "previewRecalculation": {
      const companyId = (form.companyId as string)?.trim();

      if (!companyId) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company ID is required"],
        });
      }

      try {
        const preview = await previewCreditRecalculation(companyId);

        if (preview) {
          return Response.json({
            intent,
            success: true,
            data: preview,
          });
        } else {
          return Response.json({
            intent,
            success: false,
            errors: ["Failed to generate preview"],
          });
        }
      } catch (error) {
        console.error(`❌ Error in previewRecalculation action:`, error);
        return Response.json({
          intent,
          success: false,
          errors: [
            `Failed to preview recalculation: ${error instanceof Error ? error.message : "Unknown error"}`,
          ],
        });
      }
    }

    default:
      return Response.json({
        intent,
        success: false,
        errors: ["Unknown intent"],
      });
  }
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const companyId = params.companyId;
  if (!companyId) {
    throw new Response("Company ID is required", { status: 400 });
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

    if (!session.accessToken) {
    throw new Response("Access token is required", { status: 401 });
  }

  // Get company dashboard data from service
  const dashboardData = await getCompanyDashboardData(
    companyId,
    store.id,
    session.shop,
    session.accessToken,
  );

  if (!dashboardData) {
    throw new Response("Company not found", { status: 404 });
  }

  // Get credit summary
  const creditSummary = await getCreditSummary(companyId);

  if (!creditSummary) {
    throw new Response("Unable to fetch credit summary", { status: 500 });
  }

  const creditPercentageUsed =
    creditSummary.creditLimit.toNumber() > 0
      ? (creditSummary.usedCredit.toNumber() /
          creditSummary.creditLimit.toNumber()) *
        100
      : 0;

  const availableCredit = Math.max(
    0,
    creditSummary.creditLimit.toNumber() - creditSummary.usedCredit.toNumber(),
  );

  return Response.json({
    company: {
      id: dashboardData.company.id,
      name: dashboardData.company.name,
      contactName: dashboardData.company.contactName,
      contactEmail: dashboardData.company.contactEmail,
      shopifyCompanyId: dashboardData.company.shopifyCompanyId,
      paymentTermsTemplateId: dashboardData.company.paymentTerm || "",
      isDisable: dashboardData.company.isDisable ?? false,
    },
    creditLimit: creditSummary.creditLimit.toNumber(),
    availableCredit: availableCredit,
    usedCredit: creditSummary.usedCredit.toNumber(),
    pendingCredit: creditSummary.pendingCredit.toNumber(),
    creditPercentageUsed,
    recentOrders: dashboardData.recentOrders.map((order) => ({
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      orderTotal: order.orderTotal.toNumber(),
      paidAmount: order.paidAmount.toNumber(),
      remainingBalance: order.remainingBalance.toNumber(),
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      creditUsed: order.creditUsed.toNumber(),
      createdAt: order.createdAt.toISOString(),
      createdBy:
        [order.createdByUser.firstName, order.createdByUser.lastName]
          .filter(Boolean)
          .join(" ") || order.createdByUser.email,
    })),
    orderStats: dashboardData.orderStats,
    users: dashboardData.users.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      companyRole: user.companyRole,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      shopifyCustomer: user.shopifyCustomer,
      existsInShopify: user.existsInShopify,
    })),
    totalUsers: dashboardData.totalUsers,
    pendingOrderCount: 0,
  } satisfies LoaderData);
};

function getCreditStatusColor(
  percentageUsed: number,
): "success" | "warning" | "critical" {
  if (percentageUsed < 70) return "success";
  if (percentageUsed < 90) return "warning";
  return "critical";
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ActionResponse {
  intent: string;
  success: boolean;
  message?: string;
  errors?: string[];
}

export default function CompanyDashboard() {
  const data = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [isEditingCredit, setIsEditingCredit] = useState(false);
  const [creditLimitValue, setCreditLimitValue] = useState(
    data.creditLimit.toString(),
  );
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const updateFetcher = useFetcher<ActionResponse>();
  const [isEditingPaymentTerms, setIsEditingPaymentTerms] = useState(false);
  const [selectedPaymentTerms, setSelectedPaymentTerms] = useState(
    data.company.paymentTermsTemplateId || "",
  );
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [showRecalculateConfirm, setShowRecalculateConfirm] = useState(false);
  const [recalculationPreview, setRecalculationPreview] = useState<{
    unpaidOrders: Array<{
      id: string;
      shopifyOrderId?: string;
      remainingBalance: number;
      createdBy?: string;
      createdAt?: string;
    }>;
    totalPendingCredit: number;
    newCreditUsed: number;
    creditAvailable: number;
    companyName?: string;
    creditLimit?: { toNumber(): number } | number;
    unpaidOrdersCount?: number;
    unpaidOrdersTotal?: { toNumber(): number } | number;
    currentTransactionsCount?: number;
  } | null>(null);
  const recalculateFetcher = useFetcher<ActionResponse>();
  // const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Update the useEffect to handle fetcher data
  useEffect(() => {
    if (updateFetcher.data) {
      if (
        updateFetcher.data.intent === "deactivateCompany" ||
        updateFetcher.data.intent === "reActivateCompany"
      ) {
        if (!updateFetcher.data.success && updateFetcher.data.errors) {
          setDeactivateError(updateFetcher.data.errors[0]);
        } else if (updateFetcher.data.success) {
          setDeactivateError(null);
        }
        setDeactivatingId(null);
      }
    }
  }, [updateFetcher.data]);

  const creditStatus = getCreditStatusColor(data.creditPercentageUsed);
  const creditStatusColor =
    creditStatus === "success"
      ? "#008060"
      : creditStatus === "warning"
        ? "#b98900"
        : "#d72c0d";

  const handleCreditUpdate = () => {
    const formData = new FormData();
    formData.append("intent", "updateCredit");
    formData.append("id", data.company.id);
    formData.append("creditLimit", creditLimitValue);

    fetcher.submit(formData, { method: "POST" });
    setIsEditingCredit(false);
  };

  const handleCancelEdit = () => {
    setCreditLimitValue(data.creditLimit.toString());
    setIsEditingCredit(false);
  };

  const handlePaymentTermsUpdate = () => {
    const formData = new FormData();
    formData.append("intent", "updatepaymentTerm");
    if (data.company.shopifyCompanyId) {
      formData.append("id", data.company.shopifyCompanyId);
    }

    // ✅ FIXED KEY
    formData.append("paymentTerm", selectedPaymentTerms);

    fetcher.submit(formData, { method: "POST" });
    setIsEditingPaymentTerms(false);
  };

  const handleCancelPaymentTermsEdit = () => {
    setSelectedPaymentTerms(data.company.paymentTermsTemplateId || "");
    setIsEditingPaymentTerms(false);
  };

  // Payment terms options
  const paymentTermsOptions = [
    { value: "", label: "No payment terms" },
    {
      value: "gid://shopify/PaymentTermsTemplate/1",
      label: "Due on fulfillment",
    },
    {
      value: "gid://shopify/PaymentTermsTemplate/2",
      label: "Net 7",
    },
    {
      value: "gid://shopify/PaymentTermsTemplate/3",
      label: "Net 15",
    },
    {
      value: "gid://shopify/PaymentTermsTemplate/4",
      label: "Net 30",
    },
    {
      value: "gid://shopify/PaymentTermsTemplate/5",
      label: "Net 45",
    },
    {
      value: "gid://shopify/PaymentTermsTemplate/6",
      label: "Net 60",
    },
    {
      value: "gid://shopify/PaymentTermsTemplate/7",
      label: "Net 90",
    },
  ];

  const getPaymentTermsLabel = (value: string) => {
    const option = paymentTermsOptions.find((opt) => opt.value === value);
    return option ? option.label : "No payment terms";
  };

  const handlePreviewRecalculation = () => {
    const formData = new FormData();
    formData.append("intent", "previewRecalculation");
    formData.append("companyId", data.company.id);

    recalculateFetcher.submit(formData, { method: "POST" });
  };

  const handleRecalculateCredit = () => {
    setIsRecalculating(true);
    const formData = new FormData();
    formData.append("intent", "recalculateCredit");
    formData.append("companyId", data.company.id);

    recalculateFetcher.submit(formData, { method: "POST" });
  };

  const handleShowRecalculateModal = () => {
    setShowRecalculateConfirm(true);
    handlePreviewRecalculation();
  };

  const handleCancelRecalculate = () => {
    setShowRecalculateConfirm(false);
    setRecalculationPreview(null);
    setIsRecalculating(false);
  };

  useEffect(() => {
    if (updateFetcher.state === "idle") {
      setDeactivatingId(null);
    }
  }, [updateFetcher.state]);

  useEffect(() => {
    if (fetcher.data?.intent === "updatepaymentTerm" && fetcher.data?.success) {
      window.location.reload();
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (recalculateFetcher.state === "idle" && recalculateFetcher.data) {
      const response = recalculateFetcher.data as ActionResponse & {
        data?: Record<string, unknown>;
      };

      if (
        response.intent === "previewRecalculation" &&
        response.success &&
        response.data
      ) {
        setRecalculationPreview(response.data as typeof recalculationPreview);
      } else if (response.intent === "recalculateCredit") {
        setIsRecalculating(false);
        setShowRecalculateConfirm(false);
        setRecalculationPreview(null);

        if (response.success) {
          // Optionally show success message or reload the page
          console.log("✅ Credit recalculation completed successfully");
          window.location.reload(); // Reload to see updated data
        } else {
          console.error("❌ Credit recalculation failed:", response.errors);
          alert(
            `Failed to recalculate credit: ${response.errors?.[0] || "Unknown error"}`,
          );
        }
      }
    }
  }, [recalculateFetcher.state, recalculateFetcher.data]);

  return (
    <s-page heading={`${data.company.name} - Credit Dashboard`}>
      <div style={{ marginBottom: 16 }}>
        <Link
          to="/app/companies"
          style={{
            color: "#005bd3",
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          ← Back to Companies
        </Link>
      </div>

      {/* Payment Terms Edit Modal */}
      {isEditingPaymentTerms && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={handleCancelPaymentTermsEdit} // click outside closes
        >
          <section
            onClick={(e) => e.stopPropagation()} // ✅ VERY IMPORTANT
            style={{
              backgroundColor: "white",
              borderRadius: 8,
              padding: 24,
              width: "90%",
              maxWidth: 500,
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
            }}
            role="dialog"
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 20,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                Edit payment terms
              </h2>
              <button
                onClick={handleCancelPaymentTermsEdit}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: 20,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>

  <div style={{ marginBottom: 20 }}>
    <label 
      htmlFor="payment-terms-select"
      style={{ fontSize: 13, fontWeight: 500 }}
    >
      Set payment terms
    </label>
    <select
      id="payment-terms-select"
      value={selectedPaymentTerms}
      onChange={(e) => setSelectedPaymentTerms(e.target.value)}
      style={{
        width: "100%",
        padding: "8px 12px",
        marginTop: 6,
      }}
    >
      {paymentTermsOptions.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </div>

  {isEditingPaymentTerms && (
    <div
      style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
    >
      <button onClick={handleCancelPaymentTermsEdit}>Cancel</button>
      <button
        onClick={handlePaymentTermsUpdate}
        disabled={fetcher.state === "submitting"}
        style={{
          backgroundColor: "#008060",
          color: "white",
          padding: "8px 16px",
          borderRadius: 6,
        }}
      >
        {fetcher.state === "submitting" ? "Saving..." : "Save"}
      </button>
    </div>
  )}
</section>
        </div>
      )}

      {/* Company Information Section */}
      <s-section heading="Company Information">
        <div
          style={{
            border: "1px solid #e0e0e0",
            borderRadius: 8,
            padding: 16,
            backgroundColor: "#ffffff",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1.5fr 2fr 1.5fr 1.5fr auto",
              gap: 24,
              alignItems: "center",
            }}
          >
            {/* Company Name */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Company Name
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#202223",
                }}
              >
                {data.company.name}
              </div>
            </div>

            {/* Contact Person */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Contact Person
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#202223",
                }}
              >
                {data.company.contactName || "—"}
              </div>
            </div>

            {/* Contact Email */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Contact Email
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#202223",
                  wordBreak: "break-word",
                }}
              >
                {data.company.contactEmail || "—"}
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Payment Terms
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#202223",
                  }}
                >
                  {getPaymentTermsLabel(data.company.paymentTermsTemplateId)}
                </div>
                <button
                  onClick={() => setIsEditingPaymentTerms(true)}
                  style={{
                    padding: "4px 6px",
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    color: "#5c5f62",
                    display: "flex",
                    alignItems: "center",
                  }}
                  title="Edit payment terms"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M11.3333 2.00004C11.5084 1.82494 11.7163 1.68605 11.9451 1.59129C12.1739 1.49653 12.4192 1.44775 12.6667 1.44775C12.9141 1.44775 13.1594 1.49653 13.3882 1.59129C13.617 1.68605 13.8249 1.82494 14 2.00004C14.1751 2.17513 14.314 2.383 14.4088 2.61178C14.5036 2.84055 14.5523 3.08584 14.5523 3.33337C14.5523 3.58091 14.5036 3.8262 14.4088 4.05497C14.314 4.28375 14.1751 4.49162 14 4.66671L5.00001 13.6667L1.33334 14.6667L2.33334 11L11.3333 2.00004Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {/* Credit Limit - Editable */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Credit Limit
              </div>
              {isEditingCredit ? (
                <div>
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <input
                      type="number"
                      value={creditLimitValue}
                      onChange={(e) => setCreditLimitValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleCreditUpdate();
                        } else if (e.key === "Escape") {
                          handleCancelEdit();
                        }
                      }}
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        padding: "4px 8px",
                        border: "1px solid #c9ccd0",
                        borderRadius: 4,
                        width: "100px",
                      }}
                      step="0.01"
                      min="0"
                    />
                    <button
                      onClick={handleCreditUpdate}
                      disabled={fetcher.state === "submitting"}
                      style={{
                        padding: "4px 8px",
                        fontSize: 11,
                        fontWeight: 500,
                        backgroundColor: "#008060",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor:
                          fetcher.state === "submitting"
                            ? "not-allowed"
                            : "pointer",
                        opacity: fetcher.state === "submitting" ? 0.6 : 1,
                      }}
                    >
                      {fetcher.state === "submitting" ? "..." : "✓"}
                    </button>
                  </div>
                  {fetcher.data?.intent === "updateCredit" &&
                    fetcher.data?.success && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "#008060",
                          marginTop: 4,
                        }}
                      >
                        ✓ Updated successfully
                      </div>
                    )}
                  {fetcher.data?.intent === "updateCredit" &&
                    !fetcher.data?.success && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "#d72c0d",
                          marginTop: 4,
                        }}
                      >
                        {fetcher.data?.errors?.[0] || "Failed to update"}
                      </div>
                    )}
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#202223",
                    }}
                  >
                    {formatCurrency(data.creditLimit)}
                  </div>
                  <button
                    onClick={() => setIsEditingCredit(true)}
                    style={{
                      padding: "4px 3px",
                      border: "none",
                      background: "none",
                      cursor: "pointer",
                      color: "#5c5f62",
                      display: "flex",
                      alignItems: "center",
                    }}
                    title="Edit credit limit"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 16 16"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M11.3333 2.00004C11.5084 1.82494 11.7163 1.68605 11.9451 1.59129C12.1739 1.49653 12.4192 1.44775 12.6667 1.44775C12.9141 1.44775 13.1594 1.49653 13.3882 1.59129C13.617 1.68605 13.8249 1.82494 14 2.00004C14.1751 2.17513 14.314 2.383 14.4088 2.61178C14.5036 2.84055 14.5523 3.08584 14.5523 3.33337C14.5523 3.58091 14.5036 3.8262 14.4088 4.05497C14.314 4.28375 14.1751 4.49162 14 4.66671L5.00001 13.6667L1.33334 14.6667L2.33334 11L11.3333 2.00004Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </div>
            {/* Deactivate / Reactivate Button */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <updateFetcher.Form
                method="post"
                onSubmit={() => {
                  setDeactivatingId(data.company.id);
                  setDeactivateError(null); // Clear previous errors
                }}
              >
                <input
                  type="hidden"
                  name="intent"
                  value={
                    data.company.isDisable
                      ? "reActivateCompany"
                      : "deactivateCompany"
                  }
                />
                <input type="hidden" name="id" value={data.company.id} />

                <button
                  type="submit"
                  disabled={deactivatingId === data.company.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minWidth: 100,
                    padding: "6px 14px",
                    borderRadius: 6,
                    border: data.company.isDisable
                      ? "1px solid #008060"
                      : "1px solid #d72c0d",
                    backgroundColor: "white",
                    color: data.company.isDisable ? "#008060" : "#d72c0d",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor:
                      deactivatingId === data.company.id
                        ? "not-allowed"
                        : "pointer",
                    opacity: deactivatingId === data.company.id ? 0.6 : 1,
                  }}
                >
                  {deactivatingId === data.company.id
                    ? "Processing..."
                    : data.company.isDisable
                      ? "Reactivate"
                      : "Deactivate"}
                </button>
              </updateFetcher.Form>

              {/* Error message display */}
            </div>
          </div>
        </div>
        {deactivateError && deactivatingId === null && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              backgroundColor: "#fef1f1",
              border: "1px solid #fda29b",
              color: "#d72c0d",
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            {deactivateError}
          </div>
        )}
      </s-section>

      {/* Top Row: Company Info, Credit Status, Order Summary */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 10,
          marginBottom: 10,
        }}
      >
        {/* Credit Overview */}
        <s-section heading="Credit Status">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Credit Limit
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {formatCurrency(data.creditLimit)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Available Credit
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: creditStatusColor,
                }}
              >
                {formatCurrency(data.availableCredit)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Used Credit
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {formatCurrency(data.usedCredit)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Pending Credit
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {formatCurrency(data.pendingCredit)}
              </div>
              <div style={{ fontSize: 11, color: "#5c5f62", marginTop: 2 }}>
                {data.pendingOrderCount} pending orders
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Credit Usage: {data.creditPercentageUsed.toFixed(1)}%
            </div>
            <div
              style={{
                width: "100%",
                height: 8,
                backgroundColor: "#e0e0e0",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.min(data.creditPercentageUsed, 100)}%`,
                  height: "100%",
                  backgroundColor: creditStatusColor,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>

          {/* Recalculate Credit Button */}
          <div
            style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: "1px solid #e0e0e0",
            }}
          >
            <button
              onClick={handleShowRecalculateModal}
              disabled={recalculateFetcher.state === "submitting"}
              style={{
                padding: "8px 16px",
                backgroundColor: "#005bd3",
                color: "white",
                border: "none",
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 500,
                cursor:
                  recalculateFetcher.state === "submitting"
                    ? "not-allowed"
                    : "pointer",
                opacity: recalculateFetcher.state === "submitting" ? 0.6 : 1,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {recalculateFetcher.state === "submitting" ? (
                <>
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      border: "2px solid #ffffff",
                      borderTop: "2px solid transparent",
                      borderRadius: "50%",
                      animation: "spin 1s linear infinite",
                    }}
                  />
                  Loading...
                </>
              ) : (
                <>🔄 Recalculate Credit</>
              )}
            </button>
            <div style={{ fontSize: 11, color: "#5c5f62", marginTop: 8 }}>
              Recalculates credit based on current unpaid orders and updates
              transaction history
            </div>
          </div>
        </s-section>

        {/* Order Statistics */}
        <s-section heading="Order Summary">
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Total Orders:</span>
              <strong>{data.orderStats.total}</strong>
            </div>
            <div style={{ borderTop: "1px solid #e0e0e0" }} />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "#008060",
              }}
            >
              <span>Paid:</span>
              <span>{data.orderStats.paid}</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "#d72c0d",
              }}
            >
              <span>Unpaid:</span>
              <span>{data.orderStats.unpaid}</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "#b98900",
              }}
            >
              <span>Pending:</span>
              <span>{data.orderStats.pending}</span>
            </div>
          </div>
        </s-section>
      </div>

      <s-section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Users</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                const formData = new FormData();
                formData.append("intent", "syncUsers");
                formData.append("companyId", data.company.id);
                fetcher.submit(formData, { method: "POST" });
              }}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #c9ccd0",
                color: "#202223",
                fontSize: 12,
                fontWeight: 500,
                backgroundColor: "white",
                cursor: "pointer",
                textAlign: "center",
              }}
              disabled={fetcher.state === "submitting"}
            >
              {fetcher.state === "submitting" ? "Syncing..." : "Sync Users"}
            </button>
            <Link
              to={`/app/companies/${data.company.id}/users`}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #c9ccd0",
                textDecoration: "none",
                color: "#202223",
                fontSize: 12,
                fontWeight: 500,
                backgroundColor: "white",
                cursor: "pointer",
                textAlign: "center",
              }}
            >
              View All Users
            </Link>
          </div>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Total Users:</span>
            <strong>{data.totalUsers}</strong>
          </div>
          <div style={{ borderTop: "1px solid #e0e0e0" }} />
          {data.users.slice(0, 3).map((user) => (
            <div
              key={user.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 13,
              }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>
                  {[user.firstName, user.lastName].filter(Boolean).join(" ") ||
                    user.email}
                </div>
                <div style={{ fontSize: 11, color: "#5c5f62" }}>
                  {user.companyRole || user.role}
                </div>
              </div>
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 4,
                  fontSize: 11,
                  backgroundColor:
                    user.status === "ACTIVE" ? "#d4f3e6" : "#e0e0e0",
                  color: user.status === "ACTIVE" ? "#008060" : "#5c5f62",
                }}
              >
                {user.status}
              </span>
            </div>
          ))}
        </div>
      </s-section>

      {/* Recent Orders */}
      <s-section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Recent Orders
          </h3>
          <Link
            to={`/app/companies/${data.company.id}/orders`}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #c9ccd0",
              textDecoration: "none",
              color: "#202223",
              fontSize: 12,
              fontWeight: 500,
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            View All Orders
          </Link>
        </div>
        {data.recentOrders.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e0e0e0" }}>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Order ID
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Date
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Total
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Paid
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Credit Used
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    New Balance
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.map((tx) => (
                  <tr key={tx.id} style={{ borderBottom: "1px solid #e0e0e0" }}>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {formatDate(tx.createdAt)}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {tx.createdAt.replace(/_/g, " ").toUpperCase()}
                    </td>
                    <td
                      style={{
                        padding: 12,
                        textAlign: "right",
                        fontSize: 13,
                        color: tx.orderTotal >= 0 ? "#008060" : "#d72c0d",
                        fontWeight: 500,
                      }}
                    >
                      {tx.orderTotal >= 0 ? "+" : ""}
                      {formatCurrency(tx.orderTotal)}
                    </td>
                    <td
                      style={{ padding: 12, textAlign: "right", fontSize: 13 }}
                    >
                      {formatCurrency(tx.paidAmount)}
                    </td>

                    <td
                      style={{ padding: 12, textAlign: "right", fontSize: 13 }}
                    >
                      {formatCurrency(tx.creditUsed)}
                    </td>

                    <td
                      style={{ padding: 12, textAlign: "right", fontSize: 13 }}
                    >
                      {formatCurrency(tx.remainingBalance)}
                    </td>
                    {/* <td style={{ padding: 12, fontSize: 13 }}>
                      {tx.notes || "—"}
                    </td> */}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: "center", color: "#5c5f62" }}>
            <p>No transactions yet. Credit transactions will appear here.</p>
          </div>
        )}
      </s-section>

      {/* Recalculate Credit Confirmation Modal */}
      {showRecalculateConfirm && (
        <button
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
          aria-label="Close recalculation modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCancelRecalculate();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              handleCancelRecalculate();
            }
          }}
        >
          <section
            style={{
              backgroundColor: "white",
              borderRadius: 8,
              padding: 24,
              maxWidth: 600,
              width: "90%",
              maxHeight: "80vh",
              overflow: "auto",
            }}
            role="dialog"
            aria-labelledby="recalculate-modal-title"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 20,
              }}
            >
              <h3
                style={{ margin: 0, fontSize: 18, fontWeight: 600 }}
                id="recalculate-modal-title"
              >
                🔄 Recalculate Credit
              </h3>
              <button
                onClick={handleCancelRecalculate}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: 18,
                  cursor: "pointer",
                  color: "#5c5f62",
                }}
              >
                ×
              </button>
            </div>

            {recalculationPreview ? (
              <>
                <div style={{ marginBottom: 16 }}>
                  <p style={{ margin: 0, marginBottom: 12, color: "#5c5f62" }}>
                    This will recalculate the credit for{" "}
                    <strong>{recalculationPreview.companyName}</strong> based on
                    current unpaid orders.
                  </p>

                  <div
                    style={{
                      backgroundColor: "#f8f9fa",
                      padding: 16,
                      borderRadius: 6,
                      marginBottom: 16,
                    }}
                  >
                    <h4 style={{ margin: 0, marginBottom: 12, fontSize: 14 }}>
                      Preview Summary:
                    </h4>
                    <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>Credit Limit:</span>
                        <span>
                          {formatCurrency(
                            typeof recalculationPreview.creditLimit ===
                              "object" &&
                              recalculationPreview.creditLimit?.toNumber
                              ? recalculationPreview.creditLimit.toNumber()
                              : ((recalculationPreview.creditLimit as number) ??
                                  0),
                          )}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>Unpaid Orders:</span>
                        <span style={{ fontWeight: 600, color: "#d72c0d" }}>
                          {recalculationPreview.unpaidOrdersCount}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>Total Unpaid Amount:</span>
                        <span style={{ fontWeight: 600, color: "#d72c0d" }}>
                          {formatCurrency(
                            typeof recalculationPreview.unpaidOrdersTotal ===
                              "object" &&
                              recalculationPreview.unpaidOrdersTotal?.toNumber
                              ? recalculationPreview.unpaidOrdersTotal.toNumber()
                              : ((recalculationPreview.unpaidOrdersTotal as number) ??
                                  0),
                          )}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>Current Transactions:</span>
                        <span>
                          {recalculationPreview.currentTransactionsCount}
                        </span>
                      </div>
                    </div>
                  </div>

                  {recalculationPreview.unpaidOrders.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <h4 style={{ margin: 0, marginBottom: 12, fontSize: 14 }}>
                        Unpaid Orders (
                        {recalculationPreview.unpaidOrders.length}):
                      </h4>
                      <div
                        style={{
                          maxHeight: 200,
                          overflow: "auto",
                          border: "1px solid #e0e0e0",
                          borderRadius: 4,
                        }}
                      >
                        {recalculationPreview.unpaidOrders.map(
                          (
                            order: {
                              id: string;
                              shopifyOrderId?: string;
                              remainingBalance: number;
                              createdBy?: string;
                              createdAt?: string;
                            },
                            index: number,
                          ) => (
                            <div
                              key={order.id}
                              style={{
                                padding: 12,
                                borderBottom:
                                  index <
                                  recalculationPreview.unpaidOrders.length - 1
                                    ? "1px solid #e0e0e0"
                                    : "none",
                                fontSize: 12,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  marginBottom: 4,
                                }}
                              >
                                <span style={{ fontWeight: 500 }}>
                                  Order #
                                  {order.shopifyOrderId || order.id.slice(-8)}
                                </span>
                                <span style={{ fontWeight: 600 }}>
                                  {formatCurrency(order.remainingBalance)}
                                </span>
                              </div>
                              <div style={{ color: "#5c5f62" }}>
                                {order.createdBy && order.createdAt && (
                                  <>
                                    Created by {order.createdBy} on{" "}
                                    {formatDate(order.createdAt)}
                                  </>
                                )}
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )}

                  <div
                    style={{
                      padding: 12,
                      backgroundColor: "#fff3cd",
                      border: "1px solid #ffeaa7",
                      borderRadius: 4,
                      marginBottom: 20,
                      fontSize: 13,
                    }}
                  >
                    <strong>⚠️ Warning:</strong> This action will:
                    <ul style={{ margin: "8px 0 0 16px", paddingLeft: 0 }}>
                      <li>
                        Delete existing credit transactions for these orders
                      </li>
                      <li>
                        Create new credit transactions based on current order
                        amounts
                      </li>
                      <li>Update company credit usage in Shopify metafields</li>
                    </ul>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      onClick={handleCancelRecalculate}
                      disabled={isRecalculating}
                      style={{
                        padding: "10px 16px",
                        border: "1px solid #e0e0e0",
                        backgroundColor: "white",
                        borderRadius: 4,
                        fontSize: 13,
                        cursor: isRecalculating ? "not-allowed" : "pointer",
                        opacity: isRecalculating ? 0.6 : 1,
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleRecalculateCredit}
                      disabled={isRecalculating}
                      style={{
                        padding: "10px 16px",
                        backgroundColor: isRecalculating
                          ? "#cccccc"
                          : "#d72c0d",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: isRecalculating ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      {isRecalculating ? (
                        <>
                          <div
                            style={{
                              width: 12,
                              height: 12,
                              border: "2px solid #ffffff",
                              borderTop: "2px solid transparent",
                              borderRadius: "50%",
                              animation: "spin 1s linear infinite",
                            }}
                          />
                          Recalculating...
                        </>
                      ) : (
                        "Confirm Recalculation"
                      )}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: 20 }}>
                <div
                  style={{
                    width: 24,
                    height: 24,
                    border: "3px solid #005bd3",
                    borderTop: "3px solid transparent",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                    margin: "0 auto 16px",
                  }}
                />
                <p style={{ margin: 0, color: "#5c5f62" }}>
                  Loading preview...
                </p>
              </div>
            )}
          </section>
        </button>
      )}

      {/* Add CSS animation */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </s-page>
  );
}
