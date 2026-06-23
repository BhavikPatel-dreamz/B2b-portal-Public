import {
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
  redirect,
  useActionData,
  useLoaderData,
  Link,
  useSubmit,
  useNavigation,
} from "react-router";
import { useState, useEffect, useRef } from "react";
import prisma from "app/db.server";
import {
  buildClearSessionCookie,
  requireSalesSession,
  hasCompanyAccess,
} from "app/utils/sales-session.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
  salesPortalButtonStyles,
} from "app/components/SalesPortalLayout";
import {
  buildSalesDraftLineItems,
  buildSalesDraftShippingLine,
  buildSalesDraftTaxLine,
  calculateSalesOrderTotals,
  getCartCurrency,
  normalizeDiscountType,
  type SalesCartItem,
  type SalesDraftLineItemInput,
  type SalesDraftShippingLineInput,
} from "app/utils/sales-order-pricing.server";
import {
  createQuoteFromCart,
  getQuoteUrl,
  sendQuoteToCustomer,
  type QuoteCartItem,
} from "app/services/quote.server";
import { sendPendingOrderPaymentRequestEmail } from "app/services/sales-order-management.server";
import { getAdminForShop } from "app/shopify.server";
import {
  assertNoShopifyUserErrors,
  retryLocalOrderSync,
  shopifyOrderGraphql,
  ShopifyOrderCreationError,
  verifyShopifyDraftOrder,
  verifyShopifyOrder,
} from "app/services/shopify-order-creation.server";

type DraftOrderInput = {
  lineItems: SalesDraftLineItemInput[];
  note: string;
  customAttributes: Array<{
    key: string;
    value: string;
  }>;
  presentmentCurrencyCode: string;
  purchasingEntity: {
    purchasingCompany: {
      companyId: string;
      companyLocationId: string;
      companyContactId: string;
    };
  };
  appliedDiscount?: {
    value: number;
    valueType: "PERCENTAGE" | "FIXED_AMOUNT";
    title: string;
  };
  shippingLine?: SalesDraftShippingLineInput;
  taxExempt?: boolean;
};

type ActionResponse = {
  error?: string;
  requestId?: string;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const companyId = params.companyId;
    const formData = await request.formData();
    const intent = formData.get("intent");
    if (intent === "logout") {
      return redirect("/sales/login", {
        headers: { "Set-Cookie": buildClearSessionCookie() },
      });
    }

    const { user } = await requireSalesSession(request);
    const actionType = formData.get("actionType") as string | null;

    if (
      !["process_order", "save_quote_draft", "submit_quote"].includes(
        actionType || "",
      )
    ) {
      return Response.json({ error: "Invalid order action" }, { status: 400 });
    }

    const customerId = formData.get("customerId") as string;
    const submittedCompanyLocationId = String(
      formData.get("companyLocationId") || "",
    ).trim();
    const cartDataStr = formData.get("cartData") as string;
    const internalNotes = formData.get("internalNotes") as string;
    const customerNotes = formData.get("customerNotes") as string;
    const discountAmount = Number(formData.get("discountAmount") || "0");
    const discountType = normalizeDiscountType(
      formData.get("discountType") as string,
    );
    const shippingCost = Number(formData.get("shippingCost") || "0");
    const taxRate = Number(formData.get("taxRate") || "0");

    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      include: {
        shop: {
          select: { shopName: true, shopDomain: true, accessToken: true },
        },
      },
    });

    if (
      !company ||
      !company.shop ||
      !company.shop.accessToken ||
      !company.shopifyCompanyId
    ) {
      return Response.json(
        { error: "Company or shop credentials not found" },
        { status: 400 },
      );
    }
    const admin = await getAdminForShop(company.shop.shopDomain);

    const cartData = JSON.parse(cartDataStr || "[]") as SalesCartItem[];
    if (cartData.length === 0) {
      return Response.json({ error: "Cart is empty" }, { status: 400 });
    }

    if (actionType === "save_quote_draft" || actionType === "submit_quote") {
      const quoteTitle = String(formData.get("quoteTitle") || "").trim();
      const expirationDate = String(formData.get("expirationDate") || "");
      const expiresAt = expirationDate
        ? new Date(`${expirationDate}T23:59:59.999`)
        : null;
      const quote = await createQuoteFromCart({
        companyId: company.id,
        salesAgentId: user.id,
        customerId,
        cartData: cartData as QuoteCartItem[],
        title: quoteTitle || null,
        internalNotes,
        customerNotes,
        discountAmount,
        discountType,
        shippingCost,
        taxRate,
        expiresAt,
        submit: actionType === "submit_quote",
      });
      if (actionType === "submit_quote") {
        await sendQuoteToCustomer({
          quoteId: quote.id,
          request,
          userId: user.id,
        });
      }

      return redirect(
        `/sales/portal/company/${company.id}/quotes/${quote.id}?created=1&quoteUrl=${encodeURIComponent(getQuoteUrl(request, quote))}`,
      );
    }

    // 1. Fetch B2B contact and location details from Shopify
    const baseMetaQuery = `
    query GetBaseMeta($companyId: ID!) {
        company(id: $companyId) {
          locations(first: 50) {
            nodes {
              id
              name
            }
          }
        contacts(first: 50) {
          edges {
            node {
              id
              customer {
                id
              }
              roleAssignments(first: 5) {
                edges {
                  node {
                    companyLocation {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

    const baseMetaData = await shopifyOrderGraphql<{
      company: null | {
        locations?: { nodes?: Array<{ id?: string; name?: string | null }> };
        contacts?: { edges?: Array<any> };
      };
    }>({
      admin,
      operation: "LoadSalesPortalB2BContext",
      query: baseMetaQuery,
      variables: { companyId: company.shopifyCompanyId },
    });
    const contacts = baseMetaData.company?.contacts?.edges || [];
    const matchCustGid = `gid://shopify/Customer/${customerId}`;
    const matchedContact = contacts.find(
      (edge: any) => edge.node.customer?.id === matchCustGid,
    );
    const companyLocations = baseMetaData.company?.locations?.nodes || [];
    const validLocationIds = new Set(
      companyLocations.map((location) => location.id).filter(Boolean),
    );
    if (
      submittedCompanyLocationId &&
      !validLocationIds.has(submittedCompanyLocationId)
    ) {
      return Response.json(
        { error: "The selected delivery location is not assigned to this company." },
        { status: 400 },
      );
    }

    const companyLocationId =
      submittedCompanyLocationId ||
      matchedContact?.node.roleAssignments?.edges?.[0]?.node?.companyLocation
        ?.id ||
      companyLocations[0]?.id ||
      "";
    const companyContactId = matchedContact?.node?.id || "";
    const selectedLocationName =
      companyLocations.find((location) => location.id === companyLocationId)
        ?.name || "";

    if (!companyLocationId || !companyContactId) {
      return Response.json(
        {
          error:
            "B2B context missing. The selected customer is not correctly assigned as a contact for this company in Shopify.",
        },
        { status: 400 },
      );
    }

    // 2. Map line items with explicit B2B contextual price overrides.
    const currencyCode = getCartCurrency(cartData);
    const totals = calculateSalesOrderTotals(
      cartData,
      discountAmount,
      discountType,
      shippingCost,
      taxRate,
    );
    const lineItems = buildSalesDraftLineItems(cartData, currencyCode);
    const taxLine = buildSalesDraftTaxLine(
      totals.estimatedTax,
      taxRate,
      currencyCode,
    );
    if (taxLine) {
      lineItems.push(taxLine);
    }
    const shippingLine = buildSalesDraftShippingLine(
      shippingCost,
      currencyCode,
    );

    const customAttributes = [
      { key: "_source", value: "Sales Portal" },
      { key: "_sales_agent_user_id", value: user.id },
    ];
    if (internalNotes) {
      customAttributes.push({ key: "Internal Notes", value: internalNotes });
    }
    if (taxRate > 0) {
      customAttributes.push({
        key: "Estimated Tax Rate",
        value: `${taxRate}%`,
      });
    }
    if (selectedLocationName) {
      customAttributes.push({
        key: "Delivery Location",
        value: selectedLocationName,
      });
    }

    const appliedDiscount =
      totals.discountTotal > 0
        ? {
            value: totals.discountTotal,
            valueType: "FIXED_AMOUNT" as const,
            title:
              discountType === "PERCENTAGE"
                ? `Custom Agent Discount (${discountAmount}%)`
                : "Custom Agent Discount",
          }
        : undefined;

    // 3. Create Draft Order Mutation
    const draftOrderMutation = `
    mutation CreateB2BDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

    const draftInput: DraftOrderInput = {
      lineItems,
      note: customerNotes,
      customAttributes,
      presentmentCurrencyCode: currencyCode,
      taxExempt: true,
      purchasingEntity: {
        purchasingCompany: {
          companyId: company.shopifyCompanyId,
          companyLocationId,
          companyContactId,
        },
      },
    };

    if (appliedDiscount) {
      draftInput.appliedDiscount = appliedDiscount;
    }
    if (shippingLine) {
      draftInput.shippingLine = shippingLine;
    }

    const draftData = await shopifyOrderGraphql<{
      draftOrderCreate: {
        draftOrder: null | { id: string };
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>({
      admin,
      operation: "CreateSalesPortalOrderDraft",
      query: draftOrderMutation,
      variables: { input: draftInput },
    });
    assertNoShopifyUserErrors(
      "CreateSalesPortalOrderDraft",
      draftData.draftOrderCreate.userErrors,
    );
    const draftId = draftData.draftOrderCreate.draftOrder?.id;
    if (!draftId) {
      return Response.json(
        { error: "Failed to create draft order. Invalid Shopify response." },
        { status: 400 },
      );
    }
    const verifiedDraft = await verifyShopifyDraftOrder(admin, draftId);
    console.info("[sales-order] completion draft verified in Shopify", {
      id: verifiedDraft.id,
      name: verifiedDraft.name,
      status: verifiedDraft.status,
      companyId: company.id,
      salesAgentId: user.id,
    });

    // 4. Complete Draft Order (Convert to Final Shopify Order)
    const completeMutation = `
    mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder {
          order {
            id
            name
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
        userErrors {
          message
        }
      }
    }
  `;

    const completeData = await shopifyOrderGraphql<{
      draftOrderComplete: {
        draftOrder: null | {
          order: null | {
            id: string;
            name: string;
            totalPriceSet?: {
              shopMoney?: { amount?: string; currencyCode?: string };
            };
          };
        };
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>({
      admin,
      operation: "CompleteSalesPortalDraftOrder",
      query: completeMutation,
      variables: { id: draftId, paymentPending: true },
    });
    assertNoShopifyUserErrors(
      "CompleteSalesPortalDraftOrder",
      completeData.draftOrderComplete.userErrors,
    );
    const createdOrder = completeData.draftOrderComplete.draftOrder?.order;
    if (!createdOrder || !createdOrder.id) {
      return Response.json(
        { error: "Failed to complete draft order. Invalid Shopify response." },
        { status: 400 },
      );
    }
    const verifiedOrder = await verifyShopifyOrder(admin, createdOrder.id);
    console.info("[sales-order] final order verified in Shopify", {
      id: verifiedOrder.id,
      name: verifiedOrder.name,
      financialStatus: verifiedOrder.displayFinancialStatus,
      fulfillmentStatus: verifiedOrder.displayFulfillmentStatus,
      companyId: company.id,
      salesAgentId: user.id,
    });

    // 5. Record final order details to the local database
    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    let localSyncWarning = false;
    let persistedOrder: any = null;

    if (dbUser) {
      const customer = await prisma.user.findFirst({
        where: {
          companyId: company.id,
          OR: [
            { id: customerId },
            { shopifyCustomerId: customerId },
            { shopifyCustomerId: `gid://shopify/Customer/${customerId}` },
          ],
        },
        select: { firstName: true, lastName: true, email: true },
      });
      const shopifyOrderTotal = Number(
        createdOrder.totalPriceSet?.shopMoney?.amount,
      );
      const orderTotal = Number.isFinite(shopifyOrderTotal)
        ? shopifyOrderTotal
        : totals.total;

      try {
        persistedOrder = await retryLocalOrderSync(
          "persist completed sales portal order",
          () =>
            prisma.b2BOrder.upsert({
              where: { shopifyOrderId: verifiedOrder.id },
              create: {
                companyId: company.id,
                createdByUserId: dbUser.id,
                shopId: company.shopId,
                shopifyOrderId: verifiedOrder.id,
                orderTotal: orderTotal,
                creditUsed: 0,
                paymentStatus: "pending",
                orderStatus: "payment_pending",
                remainingBalance: orderTotal,
                userCreditUsed: 0,
                notes: internalNotes,
                source: "Sales Portal",
                orderNumber: verifiedOrder.name,
                customerId,
                customerName: customer
                  ? [customer.firstName, customer.lastName]
                      .filter(Boolean)
                      .join(" ")
                  : null,
                customerEmail: customer?.email,
                currencyCode,
                subtotal: totals.subtotal,
                discountTotal: totals.discountTotal,
                taxAmount: totals.estimatedTax,
                shippingAmount: shippingCost,
                items: {
                  create: cartData.map((item) => ({
                    productId: item.productId,
                    productTitle:
                      item.productTitle || item.variantTitle || "Product",
                    variantId: item.variantId,
                    variantTitle: item.variantTitle,
                    sku: item.sku,
                    image: item.image,
                    quantity: item.quantity,
                    unitPrice: Number(item.price),
                    discount: 0,
                    lineTotal: Number(item.price) * item.quantity,
                  })),
                },
                activities: {
                  create: {
                    userId: dbUser.id,
                    action: "Order Created",
                    message: "Order submitted through the Sales Portal.",
                  },
                },
              },
              update: {
                companyId: company.id,
                createdByUserId: dbUser.id,
                orderNumber: verifiedOrder.name,
                orderTotal,
                remainingBalance: orderTotal,
                paymentStatus: "pending",
                orderStatus: "payment_pending",
                customerId,
                customerName: customer
                  ? [customer.firstName, customer.lastName]
                      .filter(Boolean)
                      .join(" ")
                  : null,
                customerEmail: customer?.email,
                currencyCode,
                subtotal: totals.subtotal,
                discountTotal: totals.discountTotal,
                taxAmount: totals.estimatedTax,
                shippingAmount: shippingCost,
                notes: internalNotes,
                source: "Sales Portal",
                items: {
                  deleteMany: {},
                  create: cartData.map((item) => ({
                    productId: item.productId,
                    productTitle:
                      item.productTitle || item.variantTitle || "Product",
                    variantId: item.variantId,
                    variantTitle: item.variantTitle,
                    sku: item.sku,
                    image: item.image,
                    quantity: item.quantity,
                    unitPrice: Number(item.price),
                    discount: 0,
                    lineTotal: Number(item.price) * item.quantity,
                  })),
                },
              },
              include: {
                company: {
                  select: {
                    name: true,
                    shop: { select: { shopDomain: true } },
                  },
                },
              },
            }),
        );
      } catch (syncError) {
        localSyncWarning = true;
        console.error("[sales-order] final order local sync incomplete", {
          shopifyOrderId: verifiedOrder.id,
          companyId: company.id,
          error:
            syncError instanceof Error ? syncError.message : String(syncError),
        });
      }
    } else {
      localSyncWarning = true;
      console.error(
        "[sales-order] final order local sync skipped: sales user not found",
        {
          shopifyOrderId: verifiedOrder.id,
          salesAgentId: user.id,
        },
      );
    }

    if (persistedOrder?.customerEmail) {
      try {
        await sendPendingOrderPaymentRequestEmail(persistedOrder, dbUser?.id);
      } catch (emailError) {
        console.error("[sales-order] pending payment email failed", {
          orderId: persistedOrder.id,
          shopifyOrderId: persistedOrder.shopifyOrderId,
          customerEmail: persistedOrder.customerEmail,
          error:
            emailError instanceof Error
              ? emailError.message
              : String(emailError),
        });
      }
    }

    return redirect(
      `/sales/portal/orders?company=${company.id}&createdOrder=${encodeURIComponent(verifiedOrder.name)}${localSyncWarning ? "&syncWarning=1" : ""}`,
    );
  } catch (err: any) {
    if (err instanceof Response) throw err;
    console.error("Action Crash Error (Complete Order):", err);
    if (err instanceof ShopifyOrderCreationError) {
      return Response.json(
        { error: err.message, requestId: err.requestId || undefined },
        { status: 502 },
      );
    }
    return Response.json(
      { error: `Order creation failed: ${err?.message || "Unknown error"}` },
      { status: 500 },
    );
  }
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  const isQuoteMode = new URL(request.url).pathname.includes("create-quote");

  if (!companyId) {
    return redirect("/sales/portal");
  }

  if (!hasCompanyAccess(user, companyId)) {
    return redirect("/sales/portal");
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const requestedLocationId = url.searchParams.get("locationId")?.trim() || "";

  if (!customerId) {
    return redirect(
      `/sales/portal/company/${companyId}/${isQuoteMode ? "create-quote" : "create-order"}`,
    );
  }

  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: {
      shop: {
        select: { shopName: true, shopDomain: true, accessToken: true },
      },
    },
  });

  if (!company || !company.shop) {
    return redirect("/sales/portal");
  }

  let selectedCustomer = await prisma.user.findFirst({
    where: { shopifyCustomerId: customerId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      shopifyCustomerId: true,
    },
  });

  if (!selectedCustomer && company.shop.accessToken) {
    const customerQuery = `
      query GetCustomer($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          email
        }
      }
    `;
    try {
      const customerRes = await fetch(
        `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": company.shop.accessToken,
          },
          body: JSON.stringify({
            query: customerQuery,
            variables: { id: `gid://shopify/Customer/${customerId}` },
          }),
        },
      );
      const customerData = await customerRes.json();
      const shopifyCust = customerData.data?.customer;

      if (shopifyCust) {
        selectedCustomer = {
          id: customerId,
          firstName: shopifyCust.firstName,
          lastName: shopifyCust.lastName,
          email: shopifyCust.email,
          shopifyCustomerId: customerId,
        };
      }
    } catch (e) {
      console.error("Failed to query customer details from Shopify:", e);
    }
  }

  if (!selectedCustomer) {
    return redirect(`/sales/portal/company/${companyId}/create-order`);
  }

  let companyLocations: Array<{ id: string; name: string }> = [];
  let companyLocationId = requestedLocationId;

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const locationQuery = `
      query GetCompanyLocations($companyId: ID!) {
        company(id: $companyId) {
          locations(first: 50) {
            nodes {
              id
              name
            }
          }
        }
      }
    `;
    try {
      const locationRes = await fetch(
        `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": company.shop.accessToken,
          },
          body: JSON.stringify({
            query: locationQuery,
            variables: { companyId: company.shopifyCompanyId },
          }),
        },
      );
      const locationData = await locationRes.json();
      companyLocations =
        locationData.data?.company?.locations?.nodes?.map((location: any) => ({
          id: location.id,
          name: location.name || "Company location",
        })) || [];
      const requestedLocationIsValid = companyLocations.some(
        (location) => location.id === requestedLocationId,
      );
      companyLocationId =
        (requestedLocationIsValid ? requestedLocationId : "") ||
        companyLocations[0]?.id ||
        "";
    } catch (e) {
      console.error("Failed to query company locations from Shopify:", e);
      companyLocationId = requestedLocationId;
    }
  }

  return Response.json({
    company: {
      id: company.id,
      name: company.name,
      storeName: company.shop.shopName || company.shop.shopDomain,
      creditLimit: company.creditLimit.toString(),
      companyLocationId,
      selectedLocation:
        companyLocations.find((location) => location.id === companyLocationId) ||
        null,
    },
    selectedCustomer,
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    mode: isQuoteMode ? "quote" : "order",
  });
};

export default function ReviewOrder() {
  const { company, selectedCustomer, user, mode } = useLoaderData<any>();
  const actionData = useActionData<ActionResponse>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isQuoteMode = mode === "quote";
  const flowBase = isQuoteMode
    ? `/sales/portal/company/${company.id}/create-quote`
    : `/sales/portal/company/${company.id}/create-order`;
  const selectedLocationId = company.companyLocationId || "";
  const selectedLocationQuery = selectedLocationId
    ? `&locationId=${encodeURIComponent(selectedLocationId)}`
    : "";
  const checkoutScope = `${company.id}_${selectedLocationId || "default"}`;

  // Local state retrieved from sessionStorage
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [internalNotes, setInternalNotes] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [discountAmount, setDiscountAmount] = useState(0);
  const [discountType, setDiscountType] = useState("FIXED_AMOUNT");
  const [shippingCost, setShippingCost] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [quoteTitle, setQuoteTitle] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [pendingAction, setPendingAction] = useState<
    "process_order" | "save_quote_draft" | "submit_quote" | null
  >(null);
  const submissionLock = useRef(false);

  useEffect(() => {
    const storedCart = sessionStorage.getItem(
      `sales_checkout_cart_${checkoutScope}`,
    ) || sessionStorage.getItem(
      `sales_checkout_cart_${company.id}`,
    );
    const storedIntNotes = sessionStorage.getItem(
      `sales_checkout_notes_int_${checkoutScope}`,
    ) || sessionStorage.getItem(
      `sales_checkout_notes_int_${company.id}`,
    );
    const storedCustNotes = sessionStorage.getItem(
      `sales_checkout_notes_cust_${checkoutScope}`,
    ) || sessionStorage.getItem(
      `sales_checkout_notes_cust_${company.id}`,
    );
    const storedDiscount = sessionStorage.getItem(
      `sales_checkout_discount_${checkoutScope}`,
    ) || sessionStorage.getItem(
      `sales_checkout_discount_${company.id}`,
    );
    const storedDiscountType = sessionStorage.getItem(
      `sales_checkout_discount_type_${checkoutScope}`,
    ) || sessionStorage.getItem(
      `sales_checkout_discount_type_${company.id}`,
    );
    const storedShipping = sessionStorage.getItem(
      `sales_checkout_shipping_${checkoutScope}`,
    ) || sessionStorage.getItem(
      `sales_checkout_shipping_${company.id}`,
    );
    const storedTax = sessionStorage.getItem(
      `sales_checkout_tax_rate_${checkoutScope}`,
    ) || sessionStorage.getItem(
      `sales_checkout_tax_rate_${company.id}`,
    );

    if (storedCart) setCartItems(JSON.parse(storedCart));
    if (storedIntNotes) setInternalNotes(storedIntNotes);
    if (storedCustNotes) setCustomerNotes(storedCustNotes);
    if (storedDiscount) setDiscountAmount(Number(storedDiscount));
    if (storedDiscountType) setDiscountType(storedDiscountType);
    if (storedShipping) setShippingCost(Number(storedShipping));
    if (storedTax) setTaxRate(Number(storedTax));
    const defaultExpiry = new Date();
    defaultExpiry.setDate(defaultExpiry.getDate() + 30);
    setExpirationDate(defaultExpiry.toISOString().slice(0, 10));
  }, [checkoutScope, company.id]);

  useEffect(() => {
    if (navigation.state === "idle") {
      submissionLock.current = false;
      setPendingAction(null);
    }
  }, [navigation.state]);

  useEffect(() => {
    if (!actionData?.error) return;

    setErrorMsg(
      actionData.requestId
        ? `${actionData.error} (Request ID: ${actionData.requestId})`
        : actionData.error,
    );
  }, [actionData]);

  const subtotal = cartItems.reduce(
    (acc, item) => acc + Number(item.price) * item.quantity,
    0,
  );
  const discountVal =
    discountType === "PERCENTAGE"
      ? subtotal * (discountAmount / 100)
      : discountAmount;
  const taxableAmount = Math.max(0, subtotal - discountVal);
  const taxVal = taxableAmount * (taxRate / 100);
  const grandTotal = taxableAmount + taxVal + shippingCost;
  const displayCurrencyCode = (
    cartItems.find((item) => item.currencyCode)?.currencyCode || "USD"
  ).toUpperCase();

  const formatCurrency = (
    val: string | number,
    currencyCode = displayCurrencyCode,
  ) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(val) || 0);
    } catch {
      return `${currencyCode} ${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  };

  const isSubmitting = navigation.state !== "idle";

  const submitReview = (quoteAction?: "save_quote_draft" | "submit_quote") => {
    if (submissionLock.current || isSubmitting) return;

    if (cartItems.length === 0) {
      setErrorMsg(`Cannot submit an empty ${isQuoteMode ? "quote" : "order"}.`);
      return;
    }

    const actionType = quoteAction || "process_order";
    submissionLock.current = true;
    setPendingAction(actionType);
    setErrorMsg("");
    submit(
      {
        actionType,
        customerId: selectedCustomer.shopifyCustomerId,
        companyLocationId: selectedLocationId,
        cartData: JSON.stringify(cartItems),
        internalNotes,
        customerNotes,
        discountAmount: discountAmount.toString(),
        discountType,
        shippingCost: shippingCost.toString(),
        taxRate: taxRate.toString(),
        quoteTitle,
        expirationDate,
      },
      { method: "POST" },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitReview(isQuoteMode ? "submit_quote" : undefined);
  };

  return (
    <SalesPortalLayout
      company={company}
      user={user}
      activePage={isQuoteMode ? "quotes" : "orders"}
    >
      <SalesPortalHeader
        title={isQuoteMode ? "Review B2B Quote" : "Review B2B Order"}
        subtitle={
          isQuoteMode
            ? "Verify pricing, expiration, and notes before saving or sending the quote."
            : "Verify details and complete the purchasing flow for the company location."
        }
        companyId={company.id}
        actions={
          <Link
            to={`${flowBase}/step2?customerId=${selectedCustomer.shopifyCustomerId}${selectedLocationQuery}`}
            aria-disabled={isSubmitting}
            style={{
              ...salesPortalButtonStyles.secondary,
              opacity: isSubmitting ? 0.55 : 1,
              pointerEvents: isSubmitting ? "none" : "auto",
            }}
          >
            Back to Products
          </Link>
        }
      />
      <div style={styles.container}>
        <main style={styles.mainContent}>
          {/* <div style={styles.pageHeader}>
          <h1 style={styles.pageTitle}>{isQuoteMode ? "Review B2B Quote" : "Review B2B Order"}</h1>
          <p style={styles.pageSubtitle}>
            {isQuoteMode
              ? "Verify pricing, expiration, and notes before saving or sending the quote."
              : "Verify details and complete the purchasing flow for the company location."}
          </p>
        </div> */}

          {errorMsg && (
            <div role="alert" aria-live="assertive" style={styles.errorToast}>
              <div style={{ paddingRight: "28px" }}>
                <strong>Unable to complete request</strong>
                <p style={{ margin: "4px 0 0" }}>{errorMsg}</p>
              </div>
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={() => setErrorMsg("")}
                style={styles.toastCloseBtn}
              >
                x
              </button>
            </div>
          )}

          <div style={styles.layoutGrid}>
            {/* Left Column: Details */}
            <section
              style={{ display: "flex", flexDirection: "column", gap: "24px" }}
            >
              {/* Customer info card */}
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>Customer Information</h3>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "16px",
                    fontSize: "14px",
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, color: "#4b5563" }}>
                      B2B Company:
                    </span>
                    <div
                      style={{
                        marginTop: "4px",
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#111827",
                      }}
                    >
                      {company.name}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontWeight: 600, color: "#4b5563" }}>
                      B2B Buyer Contact:
                    </span>
                    <div
                      style={{
                        marginTop: "4px",
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#111827",
                      }}
                    >
                      {selectedCustomer.firstName} {selectedCustomer.lastName}
                    </div>
                    <div style={{ fontSize: "13px", color: "#6b7280" }}>
                      {selectedCustomer.email}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontWeight: 600, color: "#4b5563" }}>
                      Delivery Location:
                    </span>
                    <div
                      style={{
                        marginTop: "4px",
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#111827",
                      }}
                    >
                      {company.selectedLocation?.name || "Company location"}
                    </div>
                  </div>
                </div>
              </div>

              {isQuoteMode && (
                <div style={styles.card}>
                  <h3 style={styles.cardTitle}>Quote Information</h3>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 180px",
                      gap: "16px",
                    }}
                  >
                    <label
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "#374151",
                      }}
                    >
                      Quote Title
                      <input
                        value={quoteTitle}
                        onChange={(e) => setQuoteTitle(e.target.value)}
                        placeholder={`${company.name} quote`}
                        style={{
                          height: "42px",
                          borderRadius: "8px",
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          font: "inherit",
                        }}
                      />
                    </label>
                    <label
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "#374151",
                      }}
                    >
                      Expiration Date
                      <input
                        type="date"
                        value={expirationDate}
                        onChange={(e) => setExpirationDate(e.target.value)}
                        style={{
                          height: "42px",
                          borderRadius: "8px",
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          font: "inherit",
                        }}
                      />
                    </label>
                  </div>
                </div>
              )}

              {/* Line Items Card */}
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>
                  {isQuoteMode ? "Quote" : "Order"} Line Items (
                  {cartItems.length} Products)
                </h3>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                  }}
                >
                  {cartItems.map((item) => (
                    <div
                      key={item.variantId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        borderBottom: "1px solid #f3f4f6",
                        paddingBottom: "12px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: "12px",
                          alignItems: "center",
                        }}
                      >
                        <div
                          style={{
                            width: "56px",
                            height: "56px",
                            borderRadius: "8px",
                            overflow: "hidden",
                            backgroundColor: "#f3f4f6",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {item.image ? (
                            <img
                              src={item.image}
                              alt={item.productTitle}
                              style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                              }}
                            />
                          ) : (
                            <span style={{ fontSize: "24px" }}>📦</span>
                          )}
                        </div>
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              color: "#111827",
                              fontSize: "14px",
                            }}
                          >
                            {item.productTitle}
                          </div>
                          {item.variantTitle !== "Default Title" && (
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#6b7280",
                                marginTop: "2px",
                              }}
                            >
                              Variant: {item.variantTitle}
                            </div>
                          )}
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#9ca3af",
                              marginTop: "2px",
                            }}
                          >
                            SKU: {item.sku || "N/A"}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div
                          style={{
                            fontWeight: 700,
                            color: "#111827",
                            fontSize: "14px",
                          }}
                        >
                          {formatCurrency(Number(item.price) * item.quantity)}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                            marginTop: "2px",
                          }}
                        >
                          {item.quantity} × {formatCurrency(item.price)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Notes Card */}
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>
                  {isQuoteMode ? "Quote" : "Order"} Notes
                </h3>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "20px",
                    fontSize: "13px",
                  }}
                >
                  <div>
                    <h4 style={{ margin: "0 0 6px 0", color: "#ef4444" }}>
                      Internal Notes (Private)
                    </h4>
                    <div
                      style={{
                        padding: "10px",
                        backgroundColor: "#fef2f2",
                        border: "1px solid #fee2e2",
                        borderRadius: "6px",
                        minHeight: "60px",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {internalNotes || "No internal notes provided."}
                    </div>
                  </div>
                  <div>
                    <h4 style={{ margin: "0 0 6px 0", color: "#3b82f6" }}>
                      Customer Notes (Public)
                    </h4>
                    <div
                      style={{
                        padding: "10px",
                        backgroundColor: "#eff6ff",
                        border: "1px solid #dbeafe",
                        borderRadius: "6px",
                        minHeight: "60px",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {customerNotes || "No customer notes provided."}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Right Column: Pricing & Submit */}
            <aside style={styles.sidebar}>
              <div style={styles.card}>
                <h3 style={styles.sidebarTitle}>
                  {isQuoteMode ? "Quote" : "Order"} Summary
                </h3>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    fontSize: "14px",
                    color: "#4b5563",
                    marginBottom: "20px",
                  }}
                >
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span>Subtotal:</span>
                    <span style={{ fontWeight: 600, color: "#111827" }}>
                      {formatCurrency(subtotal)}
                    </span>
                  </div>
                  {discountVal > 0 && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        color: "#10b981",
                        fontWeight: 600,
                      }}
                    >
                      <span>Discount:</span>
                      <span>-{formatCurrency(discountVal)}</span>
                    </div>
                  )}
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span>Est. Taxes ({taxRate}%):</span>
                    <span style={{ fontWeight: 600, color: "#111827" }}>
                      {formatCurrency(taxVal)}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span>Est. Shipping:</span>
                    <span style={{ fontWeight: 600, color: "#111827" }}>
                      {formatCurrency(shippingCost)}
                    </span>
                  </div>
                  <div
                    style={{
                      height: "1px",
                      backgroundColor: "#eaeaea",
                      margin: "8px 0",
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "18px",
                      fontWeight: 800,
                      color: "#111827",
                    }}
                  >
                    <span>Grand Total:</span>
                    <span style={{ color: "#E91E63" }}>
                      {formatCurrency(grandTotal)}
                    </span>
                  </div>
                </div>

                <form
                  onSubmit={handleSubmit}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  {isQuoteMode && (
                    <button
                      type="button"
                      disabled={isSubmitting}
                      aria-busy={pendingAction === "save_quote_draft"}
                      onClick={() => submitReview("save_quote_draft")}
                      style={{
                        ...styles.backBtn,
                        opacity: isSubmitting ? 0.6 : 1,
                        cursor: isSubmitting ? "not-allowed" : "pointer",
                      }}
                    >
                      {pendingAction === "save_quote_draft" && (
                        <span
                          style={{
                            ...styles.buttonSpinner,
                            borderColor: "#d1d5db",
                            borderTopColor: "#374151",
                          }}
                        />
                      )}
                      {pendingAction === "save_quote_draft"
                        ? "Saving Draft..."
                        : "Save Draft Quote"}
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    aria-busy={
                      pendingAction === "process_order" ||
                      pendingAction === "submit_quote"
                    }
                    style={{
                      ...styles.submitBtn,
                      opacity: isSubmitting ? 0.7 : 1,
                      cursor: isSubmitting ? "not-allowed" : "pointer",
                    }}
                  >
                    {(pendingAction === "process_order" ||
                      pendingAction === "submit_quote") && (
                      <span style={styles.buttonSpinner} />
                    )}
                    {pendingAction === "submit_quote"
                      ? "Submitting Quote..."
                      : pendingAction === "process_order"
                        ? "Processing Order..."
                        : isQuoteMode
                          ? "Submit Quote"
                          : "Process Order"}
                  </button>
                  <Link
                    to={`${flowBase}/step2?customerId=${selectedCustomer.shopifyCustomerId}${selectedLocationQuery}`}
                    aria-disabled={isSubmitting}
                    style={{
                      ...styles.backBtn,
                      opacity: isSubmitting ? 0.55 : 1,
                      pointerEvents: isSubmitting ? "none" : "auto",
                    }}
                  >
                    {isQuoteMode ? "Edit Quote" : "Modify Order"}
                  </Link>
                </form>
              </div>
            </aside>
          </div>
        </main>
        <style>{`
        @keyframes order-submit-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      </div>
    </SalesPortalLayout>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    minHeight: "100vh",
    backgroundColor: "#f9fafb",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  header: {
    backgroundColor: "#ffffff",
    borderBottom: "1px solid #eaeaea",
    padding: "0 40px",
    height: "64px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  headerContent: {
    width: "100%",
    maxWidth: "1200px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  breadcrumb: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "14px",
  },
  breadcrumbLink: {
    color: "#6b7280",
    textDecoration: "none",
  },
  breadcrumbSeparator: {
    color: "#d1d5db",
  },
  breadcrumbCurrent: {
    color: "#111827",
    fontWeight: 600,
  },
  headerUser: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  avatar: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    backgroundColor: "#E91E63",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: "14px",
  },
  userName: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#374151",
  },
  mainContent: {
    width: "100%",
    maxWidth: "1200px",
    margin: "0 auto",
    padding: "40px 20px",
    boxSizing: "border-box" as const,
  },
  pageHeader: {
    marginBottom: "32px",
  },
  pageTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "30px",
    fontWeight: 700,
    color: "#111827",
    margin: 0,
  },
  pageSubtitle: {
    fontSize: "16px",
    color: "#6b7280",
    marginTop: "8px",
    marginBottom: 0,
  },
  layoutGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 360px",
    gap: "32px",
    alignItems: "start",
  },
  card: {
    backgroundColor: "white",
    borderRadius: "16px",
    boxShadow:
      "0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03)",
    border: "1px solid #f3f4f6",
    padding: "24px",
  },
  cardTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "18px",
    fontWeight: 600,
    color: "#111827",
    margin: "0 0 20px 0",
    borderBottom: "1px solid #f3f4f6",
    paddingBottom: "12px",
  },
  sidebar: {
    position: "sticky" as const,
    top: "20px",
  },
  sidebarTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "18px",
    fontWeight: 600,
    color: "#111827",
    margin: "0 0 16px 0",
    borderBottom: "1px solid #f3f4f6",
    paddingBottom: "10px",
  },
  submitBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    width: "100%",
    height: "46px",
    background: "linear-gradient(90deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontWeight: 600,
    fontSize: "15px",
    cursor: "pointer",
    boxShadow: "0 4px 6px rgba(233, 30, 99, 0.2)",
  },
  backBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    width: "100%",
    height: "44px",
    backgroundColor: "#ffffff",
    color: "#4b5563",
    border: "1px solid #d1d5db",
    borderRadius: "8px",
    fontWeight: 600,
    fontSize: "14px",
    textDecoration: "none",
    cursor: "pointer",
  },
  buttonSpinner: {
    width: "16px",
    height: "16px",
    border: "2px solid rgba(255, 255, 255, 0.45)",
    borderTopColor: "#ffffff",
    borderRadius: "50%",
    animation: "order-submit-spin 0.8s linear infinite",
    flexShrink: 0,
  },
  errorToast: {
    position: "fixed" as const,
    top: "20px",
    right: "20px",
    zIndex: 11000,
    width: "min(400px, calc(100vw - 32px))",
    boxSizing: "border-box" as const,
    backgroundColor: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "10px",
    padding: "14px",
    color: "#991b1b",
    boxShadow: "0 12px 30px rgba(17, 24, 39, 0.16)",
    fontSize: "13px",
  },
  toastCloseBtn: {
    position: "absolute" as const,
    top: "8px",
    right: "10px",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: "18px",
    lineHeight: 1,
  },
};
