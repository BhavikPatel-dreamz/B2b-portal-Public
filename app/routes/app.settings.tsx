import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  deleteStore,
  getStoreByDomain,
  setShopValidationMetafields,
  updateStore,
} from "../services/store.server";
import { createUser, getUserByEmail } from "app/services/user.server";
import { getCompaniesByShop } from "app/services/company.server";
import { calculateAvailableCredit } from "../services/creditService";
import { getFreePlanUsage } from "app/utils/free-plan-limits.server";
import {
  processCustomersDataRequest,
  processCustomersRedact,
  processShopRedact,
} from "../services/gdpr-webhooks.server";

interface LoaderData {
  storeMissing: boolean;
  store?: {
    shopDomain: string;
    plan: string;
    shopName: string;
    logo: string;
    submissionEmail: string;
    contactEmail: string;
    themeColor: string;
    autoApproveB2BOnboarding: boolean;
    defaultCompanyCreditLimit: string;
    orderConfirmationToMainAccount: boolean;
    allowQuickOrderForUser: boolean;
    blockOrderWhenCreditUnavailable: boolean;
    defaultTaxRate: string;
    companyWelcomeEmailTemplate?: string;
    companyWelcomeEmailEnabled?: boolean;
    privacyPolicylink?: string;
    privacyPolicyContent?: string;
    freePlanUsage?: {
      companyCount: number;
      registrationCount: number;
    };
  };
}

interface ActionResponse {
  success: boolean;
  message?: string;
  errors?: string[];
}

type DeleteIntent =
  | "delete"
  | "customers-data-request"
  | "customers-redact"
  | "shop-redact";

function clearAdminCompaniesCache(shop: string) {
  const globalCache = globalThis as typeof globalThis & {
    __adminCompaniesCache?: Map<string, { data: unknown; timestamp: number }>;
  };
  const prefix = `admin-companies-${shop}`;

  for (const key of globalCache.__adminCompaniesCache?.keys() ?? []) {
    if (key.startsWith(prefix)) {
      globalCache.__adminCompaniesCache?.delete(key);
    }
  }
}

function sanitizeNonNegativeDecimal(value: string) {
  if (!value) return value;
  return value.startsWith("-") ? value.replace(/^-+/, "") : value;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json({ storeMissing: true } satisfies LoaderData, {
      status: 404,
    });
  }

  const freePlanUsage =
    store.plan === "free" ? await getFreePlanUsage(store.id) : undefined;

  return Response.json(
    {
      storeMissing: false,
      store: {
        shopDomain: store.shopDomain,
        plan: store.plan || "",
        shopName: store.shopName || "",
        logo: store.logo || "",
        submissionEmail: store.submissionEmail || "",
        contactEmail: store.contactEmail || "",
        themeColor: store.themeColor || "",
        autoApproveB2BOnboarding: store.autoApproveB2BOnboarding ?? false,
        defaultCompanyCreditLimit:
          store.defaultCompanyCreditLimit?.toString() || "",
        orderConfirmationToMainAccount:
          store.orderConfirmationToMainAccount ?? false,
        allowQuickOrderForUser: store.allowQuickOrderForUser ?? false,
        blockOrderWhenCreditUnavailable:
          store.blockOrderWhenCreditUnavailable ?? false,
        defaultTaxRate: store.defaultTaxRate?.toString() || "8.00",
        companyWelcomeEmailTemplate: store.companyWelcomeEmailTemplate || "",
        companyWelcomeEmailEnabled: store.companyWelcomeEmailEnabled !== false,
        privacyPolicylink: store.privacyPolicylink || "",
        privacyPolicyContent: store.privacyPolicyContent || "",
        freePlanUsage: freePlanUsage
          ? {
              companyCount: freePlanUsage.companyCount,
              registrationCount: freePlanUsage.registrationCount,
            }
          : undefined,
      },
    } satisfies LoaderData,
    { status: 200 },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { success: false, errors: ["Store not found"] } satisfies ActionResponse,
      { status: 404 },
    );
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const isFreePlan = store.plan === "free";

  if (intent === "delete") {
    try {
      const shop = session.shop;

      const users = await prisma.user.findMany({ where: { shopId: store.id } });
      if (users.length > 0) {
        const userIds = users.map((u) => u.id);
        await prisma.userSession.deleteMany({
          where: { userId: { in: userIds } },
        });
      }

      const orders = await prisma.b2BOrder.findMany({
        where: { shopId: store.id },
      });
      if (orders.length > 0) {
        const orderIds = orders.map((o) => o.id);
        await prisma.orderPayment.deleteMany({
          where: { orderId: { in: orderIds } },
        });
      }

      const companyAccounts = await prisma.companyAccount.findMany({
        where: { shopId: store.id },
      });
      if (companyAccounts.length > 0) {
        const companyIds = companyAccounts.map((c) => c.id);
        await prisma.creditTransaction.deleteMany({
          where: { companyId: { in: companyIds } },
        });
      }

      await prisma.wishlist.deleteMany({ where: { shop } });
      await prisma.notification.deleteMany({ where: { shopId: store.id } });
      await prisma.b2BOrder.deleteMany({ where: { shopId: store.id } });
      await prisma.companyAccount.deleteMany({ where: { shopId: store.id } });
      await prisma.registrationSubmission.deleteMany({
        where: { shopId: store.id },
      });
      await prisma.user.deleteMany({ where: { shopId: store.id } });
      await prisma.emailTemplates.deleteMany({ where: { shopId: store.id } });

      await deleteStore(shop);

      console.log(`Successfully uninstalled store: ${shop}`);

      return Response.json(
        {
          success: true,
          message: "All B2B portal data has been successfully deleted",
        } satisfies ActionResponse,
        { status: 200 },
      );
    } catch (error) {
      console.error("Error deleting store data:", error);
      return Response.json(
        {
          success: false,
          errors: ["Failed to delete store data. Please try again."],
        } satisfies ActionResponse,
        { status: 500 },
      );
    }
  }

  if (intent === "customers-data-request") {
    try {
      const result = await processCustomersDataRequest(session.shop);
      return Response.json(
        { success: true, message: result.message } satisfies ActionResponse,
        { status: 200 },
      );
    } catch (error) {
      console.error("Error processing customers/data_request:", error);
      return Response.json(
        {
          success: false,
          errors: ["Failed to process customer data request."],
        } satisfies ActionResponse,
        { status: 500 },
      );
    }
  }

  if (intent === "customers-redact") {
    try {
      const result = await processCustomersRedact(session.shop);
      return Response.json(
        { success: true, message: result.message } satisfies ActionResponse,
        { status: 200 },
      );
    } catch (error) {
      console.error("Error processing customers/redact:", error);
      return Response.json(
        {
          success: false,
          errors: ["Failed to process customer redact request."],
        } satisfies ActionResponse,
        { status: 500 },
      );
    }
  }

  if (intent === "shop-redact") {
    try {
      const result = await processShopRedact(session.shop);
      return Response.json(
        { success: true, message: result.message } satisfies ActionResponse,
        { status: 200 },
      );
    } catch (error) {
      console.error("Error processing shop/redact:", error);
      return Response.json(
        {
          success: false,
          errors: ["Failed to process shop redact request."],
        } satisfies ActionResponse,
        { status: 500 },
      );
    }
  }

  if (intent === "webhook") {
    try {
      const { payload, shop, topic } = await authenticate.webhook(request);
      console.log(`Received ${topic} webhook for ${shop}`);

      if (topic !== "CUSTOMERS_CREATE") {
        console.info(
          `Webhook topic ${topic} hit customers/create route. Ignoring.`,
        );
        return new Response();
      }

      if (!payload || !shop) {
        return new Response("Invalid webhook payload", { status: 400 });
      }

      const store = await getStoreByDomain(shop);
      if (!store) {
        console.warn(
          `Store not found for domain ${shop} — skipping customer sync`,
        );
        return new Response();
      }

      const customer = payload as {
        id: number;
        email: string;
        first_name: string;
        last_name: string;
        tags: string;
        credit: number;
      };
      const customerId = customer.id;
      const customerEmail = customer.email;
      const firstName = customer.first_name;
      const lastName = customer.last_name;
      const customerTags = customer.tags || "";
      const credit = customer.credit || 0;

      if (!customerEmail || !customerId) {
        console.info("Customer has no email or ID; skipping B2B user creation");
        return new Response();
      }

      const customerGid = `gid://shopify/Customer/${customerId}`;

      const existingUser = await getUserByEmail(customerEmail, store.id);
      if (existingUser) {
        console.info(
          `User with email ${customerEmail} already exists; skipping creation`,
        );
        return new Response();
      }

      let assignedCompany = null;

      const isB2BCustomer =
        customerTags.toLowerCase().includes("b2b") ||
        customerTags.toLowerCase().includes("business") ||
        customerTags.toLowerCase().includes("company");

      if (!isB2BCustomer) {
        console.info(
          `Customer ${customerEmail} does not have B2B tags; skipping B2B user creation`,
        );
        return new Response();
      }

      const companies = await getCompaniesByShop(store.id, { take: 1 });

      if (companies.length === 0) {
        console.warn(
          `No companies found for store ${shop}; cannot assign user to company`,
        );
        return new Response();
      }

      assignedCompany = companies[0];

      const newUser = await createUser({
        email: customerEmail,
        firstName: firstName || null,
        lastName: lastName || null,
        password: "",
        role: "STORE_USER",
        status: "PENDING",
        shopId: store.id,
        companyId: assignedCompany.id,
        companyRole: "member",
        shopifyCustomerId: customerGid,
        userCreditLimit: credit,
      });

      console.log(
        `Created B2B user ${newUser.id} for Shopify customer ${customerId} and assigned to company ${assignedCompany.name}`,
      );
      return new Response();
    } catch (error) {
      console.error("Error processing customers/create webhook:", error);
      return new Response("Internal server error", { status: 500 });
    }
  }

  // Handle settings update
  const shopName = (formData.get("shopName") as string | null)?.trim() || "";
  const submissionEmailRaw =
    (formData.get("submissionEmail") as string | null)?.trim() || "";
  const contactEmailRaw =
    (formData.get("contactEmail") as string | null)?.trim() || "";
  const themeColorRaw =
    (formData.get("themeColor") as string | null)?.trim() || "";
  const autoApproveB2BOnboarding =
    (formData.get("autoApproveB2BOnboarding") as string | null) === "true";
  const defaultCompanyCreditLimitRaw = isFreePlan
    ? store.defaultCompanyCreditLimit?.toString() || ""
    : ((formData.get("defaultCompanyCreditLimit") as string | null)?.trim() ||
      "");
  const orderConfirmationToMainAccount =
    (formData.get("orderConfirmationToMainAccount") as string | null) ===
    "true";
  const allowQuickOrderForUser =
    (formData.get("allowQuickOrderForUser") as string | null) === "true";
  const blockOrderWhenCreditUnavailable =
    (formData.get("blockOrderWhenCreditUnavailable") as string | null) ===
    "true";
  const companyWelcomeEmailTemplate =
    (formData.get("companyWelcomeEmailTemplate") as string | null)?.trim() ||
    "";
  const companyWelcomeEmailEnabled =
    (formData.get("companyWelcomeEmailEnabled") as string | null) === "on";

  const defaultTaxRateRaw = (formData.get("defaultTaxRate") as string | null)?.trim() || "8.00";
  const defaultTaxRate = Number(defaultTaxRateRaw) || 8.00;

  const privacyPolicylink =
    (formData.get("privacyPolicylink") as string | null)?.trim() || null;
  const privacyPolicyContent =
    (formData.get("privacyPolicyContent") as string | null)?.trim() || null;

  const errors: string[] = [];

  const submissionEmail = submissionEmailRaw || null;
  if (submissionEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submissionEmail)) {
    errors.push("Enter a valid registration notification email address.");
  }

  const contactEmail = contactEmailRaw || null;
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    errors.push("Enter a valid contact email address.");
  }

  const themeColor = themeColorRaw || null;
  if (themeColor && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(themeColor)) {
    errors.push("Theme color must be a hex value like #0d6efd or #123.");
  }

  if (
    defaultCompanyCreditLimitRaw &&
    !/^\d+(\.\d{1,2})?$/.test(defaultCompanyCreditLimitRaw)
  ) {
    errors.push("Default credit limit must be a valid positive number.");
  }

  const defaultCompanyCreditLimit =
    defaultCompanyCreditLimitRaw === ""
      ? null
      : Number(defaultCompanyCreditLimitRaw);
  if (
    defaultCompanyCreditLimit !== null &&
    (Number.isNaN(defaultCompanyCreditLimit) || defaultCompanyCreditLimit < 0)
  ) {
    errors.push("Default credit limit must be 0 or greater.");
  }

  const currentDefaultCompanyCreditLimit =
    store.defaultCompanyCreditLimit === null
      ? null
      : Number(store.defaultCompanyCreditLimit.toString());
  const shouldSyncCompanyCreditLimit =
    defaultCompanyCreditLimit !== null &&
    currentDefaultCompanyCreditLimit !== defaultCompanyCreditLimit;

  if (privacyPolicylink && !/^https?:\/\/[^\s]+$/.test(privacyPolicylink)) {
    errors.push("Privacy policy link must be a valid URL.");
  }

  if (Number.isNaN(defaultTaxRate) || defaultTaxRate < 0 || defaultTaxRate > 100) {
    errors.push("Default tax rate must be a number between 0 and 100.");
  }

  if (errors.length > 0) {
    return Response.json({ success: false, errors }, { status: 400 });
  }

  await updateStore(store.id, {
    shopName,
    submissionEmail,
    contactEmail,
    themeColor,
    autoApproveB2BOnboarding,
    defaultCompanyCreditLimit:
      defaultCompanyCreditLimitRaw === "" ? null : defaultCompanyCreditLimitRaw,
    orderConfirmationToMainAccount,
    allowQuickOrderForUser,
    blockOrderWhenCreditUnavailable,
    companyWelcomeEmailTemplate: companyWelcomeEmailTemplate || null,
    companyWelcomeEmailEnabled,
    privacyPolicylink,
    privacyPolicyContent,
    defaultTaxRate,
  });

  await setShopValidationMetafields(admin, {
    enabled: store.plan === "approved payment",
    blockOrderWhenCreditUnavailable,
  });

  let updatedCompanyCount = 0;

  if (shouldSyncCompanyCreditLimit) {
    const companies = await prisma.companyAccount.findMany({
      where: { shopId: store.id },
      select: { id: true, creditLimit: true },
    });

    for (const company of companies) {
      try {
        const previousCreditInfo = await calculateAvailableCredit(company.id);
        if (!previousCreditInfo) continue;

        await prisma.companyAccount.update({
          where: { id: company.id },
          data: { creditLimit: defaultCompanyCreditLimitRaw },
        });

        const currentCreditInfo = await calculateAvailableCredit(company.id);
        if (!currentCreditInfo) continue;

        const previousBalance = previousCreditInfo.availableCredit;
        const newBalance = currentCreditInfo.availableCredit;
        const creditAmount = newBalance.minus(previousBalance);

        await prisma.creditTransaction.create({
          data: {
            companyId: company.id,
            transactionType: "Credit Added",
            creditAmount: creditAmount,
            previousBalance: previousBalance,
            newBalance: newBalance,
            notes: `Default credit limit applied: updated from ${previousCreditInfo.creditLimit.toString()} to ${defaultCompanyCreditLimitRaw}`,
            createdBy: "Admin",
            createdAt: new Date(),
          },
        });

        updatedCompanyCount++;
      } catch (err) {
        console.error(`Failed to update credit for company ${company.id}:`, err);
      }
    }
  }

  const message = shouldSyncCompanyCreditLimit
    ? `Settings saved. Default credit limit applied to ${updatedCompanyCount} ${
        updatedCompanyCount === 1 ? "company" : "companies"
      }.`
    : defaultCompanyCreditLimit === null
      ? "Settings saved. Default credit limit cleared."
      : "Settings saved";

  return Response.json({ success: true, message } satisfies ActionResponse, {
    status: 200,
  });
};

// ─── Shared tooltip/lock CSS (injected once) ────────────────────────────────
const PLAN_LOCK_STYLES = `
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input[type="number"] { -moz-appearance: textfield; }

  .plan-lock-wrapper { position: relative; }
  .plan-lock-tooltip {
    display: none;
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: #1f2937;
    color: #fff;
    font-size: 12px;
    font-weight: 500;
    padding: 5px 10px;
    border-radius: 6px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 20;
  }
  .plan-lock-tooltip::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: #1f2937;
  }
  .plan-lock-wrapper:hover .plan-lock-tooltip { display: block; }
`;

const ToolbarButton = ({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    style={{
      padding: "6px 10px",
      background: "#fff",
      border: "1px solid #c9cccf",
      borderRadius: 6,
      cursor: "pointer",
      fontSize: 14,
      minWidth: 32,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = "#f1f2f3";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = "#fff";
    }}
  >
    {children}
  </button>
);

const ToggleRow = ({
  name,
  title,
  description,
  defaultChecked = false,
  borderBottom = false,
  disabled = false,
}: {
  name: string;
  title: string;
  description: string;
  defaultChecked?: boolean;
  borderBottom?: boolean;
  disabled?: boolean;
}) => {
  const [checked, setChecked] = useState(defaultChecked);

  useEffect(() => {
    setChecked(defaultChecked);
  }, [defaultChecked]);

  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        padding: "22px 0",
        cursor: disabled ? "not-allowed" : "pointer",
        borderBottom: borderBottom ? "1px solid #e3e3e3" : undefined,
        opacity: disabled ? 1 : 1, // opacity handled by wrapper
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: disabled ? "#8c9196" : "#202223" }}>
          {title}
        </span>
        <span style={{ fontSize: 14, color: "#6d7175", lineHeight: 1.5 }}>
          {description}
        </span>
      </div>

      <span style={{ position: "relative", flexShrink: 0 }}>
        <input
          name={name}
          type="checkbox"
          value="true"
          checked={checked}
          disabled={disabled}
          onChange={(event) => {
            if (!disabled) setChecked(event.currentTarget.checked);
          }}
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0,
            cursor: disabled ? "not-allowed" : "pointer",
            margin: 0,
            width: 46,
            height: 26,
          }}
        />
        <span
          aria-hidden="true"
          style={{
            display: "block",
            width: 46,
            height: 26,
            background: disabled ? "#d8dadd" : checked ? "#303030" : "#d8dadd",
            borderRadius: 999,
            position: "relative",
            transition: "background 0.2s ease",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: disabled ? 2 : checked ? 22 : 2,
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)",
              transition: "left 0.2s ease",
            }}
          />
        </span>
      </span>
    </label>
  );
};

type SettingsTabId = "store" | "onboarding" | "company" | "theme";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "store", label: "Store Settings" },
  { id: "onboarding", label: "B2B Onboarding Setting" },
  { id: "company", label: "Order Setting" },
  { id: "theme", label: "Theme Setting" },
];

export default function SettingsPage() {
  const editorRef = useRef<HTMLDivElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const privacyEditorRef = useRef<HTMLDivElement>(null);
  const privacyHiddenInputRef = useRef<HTMLInputElement>(null);

  const fetcher = useFetcher<ActionResponse>();
  const deleteFetcher = useFetcher<ActionResponse>();
  const shopify = useAppBridge();

  const [showDropdown, setShowDropdown] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedDeleteIntent, setSelectedDeleteIntent] =
    useState<DeleteIntent | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("store");

  const loaderData = useLoaderData<LoaderData>();
  const { storeMissing } = loaderData;

  const [emailHasContent, setEmailHasContent] = useState(false);
  const [privacyHasContent, setPrivacyHasContent] = useState(false);

  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const;

  const pageHeroStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    padding: "0px 0px 16px 0px",
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  } as const;

  const pageHeroTitleStyle = {
    fontSize: "22px",
    lineHeight: 1.15,
    fontWeight: 650,
    color: "#202223",
    margin: "15px",
  } as const;

  const pageHeroTextStyle = {
    fontSize: "14px",
    color: "#5c5f62",
    margin: "0 15px 0",
  } as const;

  const contentPanelStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
    background: "#ffffff",
    border: "1px solid #dfe3e8",
    borderRadius: 16,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
    padding: "16px",
    boxSizing: "border-box",
  } as const;

  useEffect(() => {
    if (deleteFetcher.data?.success) {
      setShowDeleteModal(false);
      setSelectedDeleteIntent(null);
    }
  }, [deleteFetcher.data]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.success) {
      shopify.toast.show?.(fetcher.data.message || "Settings saved");
      return;
    }
    if (fetcher.data.errors?.length) {
      shopify.toast.show?.(fetcher.data.errors[0]);
    }
  }, [fetcher.data, fetcher.state, shopify]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showDeleteModal) {
        setShowDeleteModal(false);
      }
    };
    if (showDeleteModal) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [showDeleteModal]);

  const handleInput = () => {
    if (editorRef.current && hiddenInputRef.current) {
      const htmlContent = editorRef.current.innerHTML;
      const textContent = editorRef.current.innerText.trim();
      const hasContent = textContent.length > 0;
      setEmailHasContent(hasContent);
      hiddenInputRef.current.value = hasContent ? htmlContent : "";
    }
  };

  useEffect(() => {
    if (!storeMissing && loaderData.store) {
      if (editorRef.current) {
        const emailTemplate = loaderData.store.companyWelcomeEmailTemplate || "";
        editorRef.current.innerHTML = emailTemplate;
        setEmailHasContent(emailTemplate.trim().length > 0);
        if (hiddenInputRef.current) {
          hiddenInputRef.current.value = emailTemplate;
        }
      }
      if (privacyEditorRef.current) {
        const privacyContent = loaderData.store.privacyPolicyContent || "";
        privacyEditorRef.current.innerHTML = privacyContent;
        setPrivacyHasContent(privacyContent.trim().length > 0);
        if (privacyHiddenInputRef.current) {
          privacyHiddenInputRef.current.value = privacyContent;
        }
      }
    }
  }, [loaderData.store, storeMissing]);

  const feeprismaack = useMemo(() => {
    const data = fetcher.data || deleteFetcher.data;
    if (!data) return null;
    if (!data.success && data.errors?.length) {
      return { tone: "critical" as const, title: "Error", messages: data.errors };
    }
    if (data.success && data.message) {
      return { tone: "success" as const, title: data.message, messages: [] };
    }
    return null;
  }, [fetcher.data, deleteFetcher.data]);

  if (loaderData.storeMissing) {
    return (
      <div style={pageShellStyle}>
        <div style={pageHeroStyle}>
          <Link
            to="/app"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              color: "#2c6ecb",
              textDecoration: "none",
              fontSize: "14px",
              fontWeight: 600,
              margin: "15px 15px 5px",
            }}
          >
            <svg viewBox="0 0 20 20" style={{ width: "16px", height: "16px" }} fill="currentColor">
              <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
            </svg>
            Back to Dashboard
          </Link>
          <h1 style={pageHeroTitleStyle}>Settings</h1>
          <p style={pageHeroTextStyle}>Maintain branding, emails, defaults, and store-wide B2B preferences.</p>
        </div>
        <div style={contentPanelStyle}>
          <s-banner tone="critical" heading="Store not found">
            <s-paragraph>The current shop is missing from the database. Please reinstall the app to continue.</s-paragraph>
          </s-banner>
        </div>
      </div>
    );
  }

  const isSaving = fetcher.state !== "idle";
  const isDeleting = deleteFetcher.state !== "idle";

  const deleteActionContent: Record<
    DeleteIntent,
    { buttonLabel: string; confirmLabel: string; title: string; description: string; warning: string }
  > = {
    delete: {
      buttonLabel: "Delete App Data",
      confirmLabel: "Yes, Delete Everything",
      title: "Confirm Deletion",
      description:
        "This will permanently delete all B2B portal data for this store, including companies, registrations, users, credit information, and app settings.",
      warning: "This action cannot be undone.",
    },
    "customers-data-request": {
      buttonLabel: "Customers Data Request",
      confirmLabel: "Run Data Request",
      title: "Confirm Customers Data Request",
      description:
        "This will initiate the customers/data_request workflow for the current store.",
      warning: "This action cannot be undone.",
    },
    "customers-redact": {
      buttonLabel: "Customers Redact",
      confirmLabel: "Delete Customer Data",
      title: "Confirm Customers Redact",
      description:
        "This will delete customer-related B2B data for the current store, including users, registrations, wishlist data, companies, orders, and credit records.",
      warning: "This action cannot be undone.",
    },
    "shop-redact": {
      buttonLabel: "Shop Redact",
      confirmLabel: "Delete Shop Data",
      title: "Confirm Shop Redact",
      description:
        "This will delete all B2B portal data for the current store, including customer data, email templates, and stored shop settings.",
      warning: "This action cannot be undone.",
    },
  };

  const variables = [
    { var: "{{companyName}}", desc: "Applying company's name" },
    { var: "{{contactName}}", desc: "Contact person's name" },
    { var: "{{email}}", desc: "Contact email address" },
    { var: "{{storeOwnerName}}", desc: "Store owner's name" },
    { var: "{{shopName}}", desc: "Shopify store's name" },
  ];

  const handleDelete = () => {
    if (!selectedDeleteIntent) return;
    deleteFetcher.submit({ intent: selectedDeleteIntent }, { method: "post" });
  };

  const store = loaderData.store!;
  const isFreePlan = store.plan === "free";

  return (
    <div style={pageShellStyle}>
      {/* Inject shared CSS once */}
      <style>{PLAN_LOCK_STYLES}</style>

      <div style={pageHeroStyle}>
        <Link
          to="/app"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#2c6ecb",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
            margin: "15px 15px 5px",
          }}
        >
          <svg viewBox="0 0 20 20" style={{ width: "16px", height: "16px" }} fill="currentColor">
            <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
          </svg>
          Back to Dashboard
        </Link>
        <h1 style={pageHeroTitleStyle}>Settings</h1>
        <p style={pageHeroTextStyle}>Maintain branding, emails, defaults, and store-wide B2B preferences.</p>
      </div>

      <div style={contentPanelStyle}>
        <div style={{ width: "100%" }}>
          {feeprismaack && (
            <div style={{ marginBottom: 12 }}>
              <s-banner tone={feeprismaack.tone} heading={feeprismaack.title}>
                {feeprismaack.messages.length > 0 && (
                  <s-unordered-list>
                    {feeprismaack.messages.map((msg) => (
                      <s-list-item key={msg}>{msg}</s-list-item>
                    ))}
                  </s-unordered-list>
                )}
              </s-banner>
            </div>
          )}

          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
              padding: 16,
              marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: "#202223", marginBottom: 16 }}>
              Settings
            </div>

            <fetcher.Form method="post" style={{ display: "grid", gap: 16 }}>
              {/* ── Tab Nav ────────────────────────────────────────────── */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  paddingBottom: 8,
                  borderBottom: "1px solid #e3e3e3",
                }}
              >
                {SETTINGS_TABS.map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      style={{
                        padding: "10px 16px",
                        borderRadius: 999,
                        border: isActive ? "1px solid #005bd3" : "1px solid #d8dadd",
                        background: isActive ? "#e8f2ff" : "#fff",
                        color: isActive ? "#004299" : "#303030",
                        fontWeight: 600,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {/* ── Store Settings ──────────────────────────────────────── */}
              <div style={{ display: activeTab === "store" ? "grid" : "none", gap: 16 }}>
                <div style={{ display: "grid", gap: 6 }}>
                  <label htmlFor="shopName" style={{ fontWeight: 600, fontSize: 14 }}>
                    Store name
                  </label>
                  <input
                    id="shopName"
                    name="shopName"
                    type="text"
                    defaultValue={store?.shopName}
                    placeholder="Store name"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: "1px solid #c9cccf",
                      fontSize: 14,
                      outline: "none",
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = "#005bd3";
                      e.target.style.boxShadow = "0 0 0 1px #005bd3";
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = "#c9cccf";
                      e.target.style.boxShadow = "none";
                    }}
                  />
                  <s-text tone="neutral">Store name shown across emails or customer views.</s-text>
                </div>

                <div style={{ display: "grid", gap: 6 }}>
                  <label htmlFor="contactEmail" style={{ fontWeight: 600, fontSize: 14 }}>
                    Primary contact email
                  </label>
                  <input
                    id="contactEmail"
                    name="contactEmail"
                    type="email"
                    defaultValue={store?.contactEmail}
                    placeholder="support@yourstore.com"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: "1px solid #c9cccf",
                      fontSize: 14,
                      outline: "none",
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = "#005bd3";
                      e.target.style.boxShadow = "0 0 0 1px #005bd3";
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = "#c9cccf";
                      e.target.style.boxShadow = "none";
                    }}
                  />
                  <s-text tone="neutral">Shared contact inbox for customers and notifications.</s-text>
                </div>
              </div>

              {/* ── Onboarding Settings ─────────────────────────────────── */}
              <div style={{ display: activeTab === "onboarding" ? "grid" : "none", gap: 16 }}>
                <div style={{ display: "grid" }}>
                  <ToggleRow
                    name="autoApproveB2BOnboarding"
                    title="Auto approve"
                    description="Automatically approve new B2B onboarding submissions when enabled."
                    defaultChecked={store?.autoApproveB2BOnboarding}
                  />
                </div>
              </div>

              {/* ── Company Settings ────────────────────────────────────── */}
              <div style={{ display: activeTab === "company" ? "grid" : "none", gap: 16 }}>

                {/* Default credit limit — always visible, locked on free plan */}
                <div style={{ display: "grid", gap: 6 }}>
                  <label htmlFor="defaultCompanyCreditLimit" style={{ fontWeight: 600, fontSize: 14 }}>
                    Default credit limit
                  </label>

                  {/* Lock wrapper — tooltip on hover */}
                  <div className="plan-lock-wrapper">
                    {isFreePlan && (
                      <span className="plan-lock-tooltip">⬆ Upgrade your plan to edit</span>
                    )}
                    <input
                      id="defaultCompanyCreditLimit"
                      name="defaultCompanyCreditLimit"
                      type="number"
                      min="0"
                      defaultValue={store.defaultCompanyCreditLimit || "1000"}
                      placeholder="1000"
                      disabled={isFreePlan}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: "1px solid #c9cccf",
                        fontSize: 14,
                        outline: "none",
                        width: "100%",
                        background: isFreePlan ? "#f1f2f4" : "#fff",
                        color: isFreePlan ? "#8c9196" : "inherit",
                        cursor: isFreePlan ? "not-allowed" : "text",
                        boxSizing: "border-box",
                      }}
                      onFocus={(e) => {
                        if (!isFreePlan) {
                          e.target.style.borderColor = "#005bd3";
                          e.target.style.boxShadow = "0 0 0 1px #005bd3";
                        }
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = "#c9cccf";
                        e.target.style.boxShadow = "none";
                      }}
                    />
                  </div>
                  <s-text tone="neutral">
                    {isFreePlan
                      ? "Upgrade to a paid plan to set a custom default credit limit."
                      : "Credit limit prefilled for new companies. Default is 1000."}
                  </s-text>
                </div>

                {/* Other company toggles */}
                <div style={{ display: "grid" }}>
                  <ToggleRow
                    name="orderConfirmationToMainAccount"
                    title="Order confirmation notifications to main account"
                    description="Main contact will receive order confirmation email when order is placed by other users of the company."
                    defaultChecked={store?.orderConfirmationToMainAccount}
                    borderBottom
                  />
                  <ToggleRow
                    name="allowQuickOrderForUser"
                    title="Allow quick order for user"
                    description="Control whether quick order is available for B2B users."
                    defaultChecked={store?.allowQuickOrderForUser}
                    borderBottom
                  />

                  {/* Block orders toggle — always visible, locked on free plan */}
                  <div className="plan-lock-wrapper">
                    {isFreePlan && (
                      <span className="plan-lock-tooltip">⬆ Upgrade your plan to enable</span>
                    )}
                    <div
                      style={{
                        opacity: isFreePlan ? 0.5 : 1,
                        pointerEvents: isFreePlan ? "none" : "auto",
                        position: "relative",
                      }}
                    >
                      {/* Invisible overlay captures hover for tooltip when locked */}
                      {isFreePlan && (
                        <div
                          style={{
                            position: "absolute",
                            inset: 0,
                            zIndex: 1,
                            cursor: "not-allowed",
                          }}
                        />
                      )}
                      <ToggleRow
                        name="blockOrderWhenCreditUnavailable"
                        title={
                          isFreePlan
                            ? "Block orders when credit limit is not available  🔒"
                            : "Block orders when credit limit is not available"
                        }
                        description="Enable this to block checkout and order creation when available credit is not enough."
                        defaultChecked={isFreePlan ? false : store?.blockOrderWhenCreditUnavailable}
                        disabled={isFreePlan}
                      />
                    </div>
                  </div>
                </div>

                     <div style={{ borderTop: "1px solid #e3e3e3", paddingTop: 16, marginTop: 8 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Invoice Template</h3>
                  <p style={{ fontSize: 14, color: "#6d7175", marginBottom: 12 }}>
                    Customize the look and feel of your B2B invoices.
                  </p>
                  <Link
                    to="/app/invoice-template"
                    style={{
                      display: "inline-flex",
                      padding: "10px 16px",
                      background: "#fff",
                      border: "1px solid #c9cccf",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#303030",
                      textDecoration: "none",
                    }}
                  >
                    Edit Invoice Template
                  </Link>
                </div>
              </div>

              {/* ── Theme Settings ──────────────────────────────────────── */}
              <div style={{ display: activeTab === "theme" ? "grid" : "none", gap: 16 }}>
                <div style={{ display: "grid", gap: 6 }}>
                  <label htmlFor="themeColor" style={{ fontWeight: 600, fontSize: 14 }}>
                    B2B dashboard color
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <input
                      id="themeColor"
                      type="color"
                      defaultValue={store?.themeColor || "#0f172a"}
                      style={{
                        width: 52,
                        height: 36,
                        border: "1px solid #c9cccf",
                        borderRadius: 8,
                        padding: 0,
                        cursor: "pointer",
                        background: "#fff",
                      }}
                      onChange={(e) => {
                        const textInput = document.getElementById("themeColorText") as HTMLInputElement | null;
                        if (textInput) textInput.value = e.target.value;
                      }}
                    />
                    <input
                      id="themeColorText"
                      name="themeColor"
                      type="text"
                      defaultValue={store?.themeColor || "#0f172a"}
                      placeholder="#0f172a"
                      style={{
                        flex: 1,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: "1px solid #c9cccf",
                        fontSize: 14,
                        outline: "none",
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = "#005bd3";
                        e.target.style.boxShadow = "0 0 0 1px #005bd3";
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = "#c9cccf";
                        e.target.style.boxShadow = "none";
                      }}
                      onChange={(e) => {
                        const colorInput = document.getElementById("themeColor") as HTMLInputElement | null;
                        if (colorInput && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) {
                          colorInput.value = e.target.value;
                        }
                      }}
                    />
                  </div>
                  <s-text tone="neutral">Primary accent color used across B2B dashboard surfaces.</s-text>
                </div>

                {/* <div style={{ borderTop: "1px solid #e3e3e3", paddingTop: 16, marginTop: 8 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Order Documents</h3>
                  <p style={{ fontSize: 14, color: "#6d7175", marginBottom: 12 }}>
                    Customize the look and feel of your B2B invoices.
                  </p>
                  <Link
                    to="/app/invoice-template"
                    style={{
                      display: "inline-flex",
                      padding: "10px 16px",
                      background: "#fff",
                      border: "1px solid #c9cccf",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#303030",
                      textDecoration: "none",
                    }}
                  >
                    Edit Invoice Template
                  </Link>
                </div> */}
              </div>

                   {isFreePlan  ? (
             <Link
                      to="/app/select-plan?returnTo=%2Fapp%2Fcompanies"
                      style={{
                        display: "block",
                        marginBottom: 16,
                        padding: 14,
                        borderRadius: 14,
                        border: "1px solid #f1c40f",
                        background: "linear-gradient(180deg, #fffdf2 0%, #fff7db 100%)",
                        textDecoration: "none",
                        color: "inherit",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                          flexWrap: "wrap",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 650, color: "#202223" }}>
                            Free plan limit reached
                          </div>
                          <div style={{ fontSize: 13, color: "#5c5f62", marginTop: 4 }}>
                            Companies: {store.freePlanUsage?.companyCount ?? 0}/10
                          </div>
                        </div>
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "10px 16px",
                            borderRadius: 10,
                            background: "#202223",
                            color: "white",
                            fontWeight: 600,
                          }}
                        >
                          Upgrade Plan
                        </div>
                      </div>
                    </Link>
                  ) : null}

              {/* ── Save button ─────────────────────────────────────────── */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <s-button type="submit" variant="primary" {...(isSaving ? { loading: true } : {})}>
                  Save settings
                </s-button>
              </div>
            </fetcher.Form>
            

            {/* ── Delete Actions ───────────────────────────────────────── */}
            <div style={{ marginTop: 32 }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Delete Actions</h2>

              <div
                style={{
                  background: "#fef2f2",
                  border: "1px solid #fca5a5",
                  borderRadius: 8,
                  padding: 24,
                }}
              >
                <p style={{ fontSize: 14, color: "#1f2937", marginBottom: 16, lineHeight: 1.5 }}>
                  Manually trigger the three webhook flows for this store from settings.
                </p>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: 16,
                    marginBottom: 16,
                  }}
                >
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: "#374151" }}>
                    <li style={{ marginBottom: 4 }}>Companies & contacts</li>
                    <li style={{ marginBottom: 4 }}>Registrations & approvals</li>
                    <li style={{ marginBottom: 4 }}>Users & permissions</li>
                    <li style={{ marginBottom: 4 }}>Customer data request flow</li>
                  </ul>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: "#374151" }}>
                    <li style={{ marginBottom: 4 }}>Locations</li>
                    <li style={{ marginBottom: 4 }}>Wishlist items</li>
                    <li style={{ marginBottom: 4 }}>Store B2B settings (logo, colors, emails)</li>
                  </ul>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: 12,
                    background: "#fee2e2",
                    borderRadius: 6,
                    marginBottom: 20,
                  }}
                >
                  <span style={{ fontSize: 18, color: "#dc2626", fontWeight: "bold", flexShrink: 0 }}>⚠</span>
                  <p style={{ margin: 0, fontSize: 14, color: "#7f1d1d", fontWeight: 600 }}>
                    Customers Redact and Shop Redact are irreversible actions.
                  </p>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 12 }}>
                  {(Object.keys(deleteActionContent) as DeleteIntent[]).map((deleteIntent) => (
                    <button
                      key={deleteIntent}
                      type="button"
                      onClick={() => {
                        setSelectedDeleteIntent(deleteIntent);
                        setShowDeleteModal(true);
                      }}
                      disabled={isDeleting}
                      style={{
                        padding: "10px 16px",
                        background: isDeleting ? "#f87171" : "#dc2626",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        fontSize: 14,
                        fontWeight: 600,
                        cursor: isDeleting ? "not-allowed" : "pointer",
                        opacity: isDeleting ? 0.6 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!isDeleting) e.currentTarget.style.background = "#b91c1c";
                      }}
                      onMouseLeave={(e) => {
                        if (!isDeleting) e.currentTarget.style.background = "#dc2626";
                      }}
                    >
                      {deleteActionContent[deleteIntent].buttonLabel}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Delete Confirmation Modal ─────────────────────────────── */}
            {showDeleteModal && selectedDeleteIntent && (
              <div
                style={{
                  position: "fixed",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: "rgba(0, 0, 0, 0.6)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 10000,
                  padding: 16,
                }}
                onClick={() => !isDeleting && setShowDeleteModal(false)}
              >
                <div
                  style={{
                    background: "#fff",
                    borderRadius: 12,
                    padding: 24,
                    maxWidth: 500,
                    width: "100%",
                    maxHeight: "90vh",
                    overflowY: "auto",
                    boxShadow:
                      "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
                    position: "relative",
                    zIndex: 10001,
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setShowDeleteModal(false);
                  }}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="delete-modal-title"
                  aria-describedby="delete-modal-description"
                  tabIndex={-1}
                >
                  <h3
                    id="delete-modal-title"
                    style={{ fontSize: 18, fontWeight: 600, marginBottom: 12, color: "#dc2626" }}
                  >
                    {deleteActionContent[selectedDeleteIntent].title}
                  </h3>
                  <p
                    id="delete-modal-description"
                    style={{ fontSize: 14, color: "#374151", marginBottom: 16, lineHeight: 1.6 }}
                  >
                    {deleteActionContent[selectedDeleteIntent].description}
                  </p>

                  <ul
                    style={{
                      fontSize: 14,
                      color: "#374151",
                      marginBottom: 24,
                      paddingLeft: 20,
                      lineHeight: 1.8,
                    }}
                  >
                    {selectedDeleteIntent === "delete" ? (
                      <>
                        <li>All companies and their contacts</li>
                        <li>All registration submissions</li>
                        <li>All users and their sessions</li>
                        <li>All orders and payment records</li>
                        <li>All credit accounts and transactions</li>
                        <li>All locations and wishlist items</li>
                        <li>All store B2B settings</li>
                      </>
                    ) : (
                      <>
                        <li>Endpoint: `/webhooks/customers/data_request`</li>
                        <li>Endpoint: `/webhooks/customers/redact`</li>
                        <li>Endpoint: `/webhooks/shop/redact`</li>
                      </>
                    )}
                    <li>Current selection: {deleteActionContent[selectedDeleteIntent].buttonLabel}</li>
                  </ul>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: 12,
                      background: "#fee2e2",
                      borderRadius: 6,
                      marginBottom: 20,
                    }}
                    role="alert"
                    aria-live="polite"
                  >
                    <span style={{ fontSize: 18, color: "#dc2626", fontWeight: "bold" }} aria-hidden="true">
                      ⚠
                    </span>
                    <p style={{ margin: 0, fontSize: 13, color: "#7f1d1d", fontWeight: 600 }}>
                      {deleteActionContent[selectedDeleteIntent].warning}
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => setShowDeleteModal(false)}
                      disabled={isDeleting}
                      style={{
                        padding: "10px 16px",
                        background: "#fff",
                        color: "#374151",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 14,
                        fontWeight: 600,
                        cursor: isDeleting ? "not-allowed" : "pointer",
                        opacity: isDeleting ? 0.6 : 1,
                        transition: "all 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        if (!isDeleting) e.currentTarget.style.background = "#f9fafb";
                      }}
                      onMouseLeave={(e) => {
                        if (!isDeleting) e.currentTarget.style.background = "#fff";
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDelete}
                      disabled={isDeleting}
                      style={{
                        padding: "10px 16px",
                        background: isDeleting ? "#f87171" : "#dc2626",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        fontSize: 14,
                        fontWeight: 600,
                        cursor: isDeleting ? "not-allowed" : "pointer",
                        opacity: isDeleting ? 0.6 : 1,
                        transition: "all 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        if (!isDeleting) e.currentTarget.style.background = "#b91c1c";
                      }}
                      onMouseLeave={(e) => {
                        if (!isDeleting) e.currentTarget.style.background = "#dc2626";
                      }}
                    >
                      {isDeleting
                        ? "Processing..."
                        : deleteActionContent[selectedDeleteIntent].confirmLabel}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
