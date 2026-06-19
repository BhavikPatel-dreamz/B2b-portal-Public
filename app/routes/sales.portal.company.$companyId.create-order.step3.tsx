import { LoaderFunctionArgs, ActionFunctionArgs, redirect } from "react-router";
import { useLoaderData, Link, useSubmit, useNavigation } from "react-router";
import { useState, useEffect } from "react";
import prisma from "app/db.server";
import { requireSalesSession, hasCompanyAccess } from "app/utils/sales-session.server";
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
  type QuoteCartItem,
} from "app/services/quote.server";

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

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const { user } = await requireSalesSession(request);
    const companyId = params.companyId;
    const formData = await request.formData();
    const actionType = formData.get("actionType") as string | null;

    if (!["process_order", "save_quote_draft", "submit_quote"].includes(actionType || "")) {
      return Response.json({ error: "Invalid order action" }, { status: 400 });
    }

    const customerId = formData.get("customerId") as string;
    const cartDataStr = formData.get("cartData") as string;
    const internalNotes = formData.get("internalNotes") as string;
  const customerNotes = formData.get("customerNotes") as string;
  const discountAmount = Number(formData.get("discountAmount") || "0");
  const discountType = normalizeDiscountType(formData.get("discountType") as string);
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

  if (!company || !company.shop || !company.shop.accessToken || !company.shopifyCompanyId) {
    return Response.json({ error: "Company or shop credentials not found" }, { status: 400 });
  }

  const cartData = JSON.parse(cartDataStr || "[]") as SalesCartItem[];
  if (cartData.length === 0) {
    return Response.json({ error: "Cart is empty" }, { status: 400 });
  }

  if (actionType === "save_quote_draft" || actionType === "submit_quote") {
    const quoteTitle = String(formData.get("quoteTitle") || "").trim();
    const expirationDate = String(formData.get("expirationDate") || "");
    const expiresAt = expirationDate ? new Date(`${expirationDate}T23:59:59.999`) : null;
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

    return redirect(
      `/sales/portal/company/${company.id}/quotes/${quote.id}?created=1&quoteUrl=${encodeURIComponent(getQuoteUrl(request, quote))}`,
    );
  }

  // 1. Fetch B2B contact and location details from Shopify
  const baseMetaQuery = `
    query GetBaseMeta($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 10) {
          nodes {
            id
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

  const baseMetaRes = await fetch(`https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": company.shop.accessToken,
    },
    body: JSON.stringify({ query: baseMetaQuery, variables: { companyId: company.shopifyCompanyId } }),
  });
  const baseMetaData = await baseMetaRes.json();
  const contacts = baseMetaData.data?.company?.contacts?.edges || [];
  const matchCustGid = `gid://shopify/Customer/${customerId}`;
  const matchedContact = contacts.find((edge: any) => edge.node.customer?.id === matchCustGid);
  
  const companyLocationId = matchedContact?.node.roleAssignments?.edges?.[0]?.node?.companyLocation?.id || 
                            baseMetaData.data?.company?.locations?.nodes?.[0]?.id || "";
  const companyContactId = matchedContact?.node?.id || "";

  if (!companyLocationId || !companyContactId) {
    return Response.json({ error: "B2B context missing. The selected customer is not correctly assigned as a contact for this company in Shopify." }, { status: 400 });
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
  const taxLine = buildSalesDraftTaxLine(totals.estimatedTax, taxRate, currencyCode);
  if (taxLine) {
    lineItems.push(taxLine);
  }
  const shippingLine = buildSalesDraftShippingLine(shippingCost, currencyCode);

  const customAttributes = [{ key: "_source", value: "Sales Portal" }];
  if (internalNotes) {
    customAttributes.push({ key: "Internal Notes", value: internalNotes });
  }
  if (taxRate > 0) {
    customAttributes.push({ key: "Estimated Tax Rate", value: `${taxRate}%` });
  }

  const appliedDiscount = totals.discountTotal > 0 ? {
    value: totals.discountTotal,
    valueType: "FIXED_AMOUNT" as const,
    title: discountType === "PERCENTAGE" ? `Custom Agent Discount (${discountAmount}%)` : "Custom Agent Discount"
  } : undefined;

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
        companyContactId
      }
    }
  };

  if (appliedDiscount) {
    draftInput.appliedDiscount = appliedDiscount;
  }
  if (shippingLine) {
    draftInput.shippingLine = shippingLine;
  }

  const draftRes = await fetch(`https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": company.shop.accessToken,
    },
    body: JSON.stringify({ query: draftOrderMutation, variables: { input: draftInput } }),
  });

  const draftData = await draftRes.json();
  
  if (draftData.errors && draftData.errors.length > 0) {
    console.error("GraphQL Top-Level Errors:", draftData.errors);
    return Response.json({ error: draftData.errors[0].message }, { status: 400 });
  }

  const errors = draftData.data?.draftOrderCreate?.userErrors || [];
  if (errors.length > 0) {
    return Response.json({ error: errors[0].message }, { status: 400 });
  }

  const draftId = draftData.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) {
    return Response.json({ error: "Failed to create draft order. Invalid Shopify response." }, { status: 400 });
  }

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

  const completeRes = await fetch(`https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": company.shop.accessToken,
    },
    body: JSON.stringify({ query: completeMutation, variables: { id: draftId, paymentPending: true } }),
  });

  const completeData = await completeRes.json();
  
  if (completeData.errors && completeData.errors.length > 0) {
    console.error("GraphQL Top-Level Errors (Complete):", completeData.errors);
    return Response.json({ error: completeData.errors[0].message }, { status: 400 });
  }

  const completeErrors = completeData.data?.draftOrderComplete?.userErrors || [];
  if (completeErrors.length > 0) {
    return Response.json({ error: completeErrors[0].message }, { status: 400 });
  }

  const createdOrder = completeData.data?.draftOrderComplete?.draftOrder?.order;
  if (!createdOrder || !createdOrder.id) {
    return Response.json({ error: "Failed to complete draft order. Invalid Shopify response." }, { status: 400 });
  }

  // 5. Record final order details to the local database
  const dbUser = await prisma.user.findFirst({
    where: { email: user.email }
  });

  if (dbUser) {
    const shopifyOrderTotal = Number(createdOrder.totalPriceSet?.shopMoney?.amount);
    const orderTotal = Number.isFinite(shopifyOrderTotal) ? shopifyOrderTotal : totals.total;

    await prisma.b2BOrder.create({
      data: {
        companyId: company.id,
        createdByUserId: dbUser.id,
        shopId: company.shopId,
        shopifyOrderId: createdOrder.id,
        orderTotal: orderTotal,
        creditUsed: 0,
        paymentStatus: "pending",
        orderStatus: "completed",
        remainingBalance: orderTotal,
        userCreditUsed: 0,
        notes: internalNotes,
        source: "Sales Portal",
      }
    });
  }

    return redirect(`/sales/portal?companyId=${company.id}&successOrder=${createdOrder.name}`);
  } catch (err: any) {
    if (err instanceof Response) throw err;
    console.error("Action Crash Error (Complete Order):", err);
    return Response.json({ error: `Server crash: ${err?.message || "Unknown error"}` }, { status: 500 });
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
  
  if (!customerId) {
    return redirect(`/sales/portal/company/${companyId}/${isQuoteMode ? "create-quote" : "create-order"}`);
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
      const customerRes = await fetch(`https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": company.shop.accessToken,
        },
        body: JSON.stringify({
          query: customerQuery,
          variables: { id: `gid://shopify/Customer/${customerId}` },
        }),
      });
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

  return Response.json({
    company: {
      id: company.id,
      name: company.name,
      creditLimit: company.creditLimit.toString(),
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
  const submit = useSubmit();
  const navigation = useNavigation();
  const isQuoteMode = mode === "quote";
  const flowBase = isQuoteMode
    ? `/sales/portal/company/${company.id}/create-quote`
    : `/sales/portal/company/${company.id}/create-order`;

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

  useEffect(() => {
    const storedCart = sessionStorage.getItem(`sales_checkout_cart_${company.id}`);
    const storedIntNotes = sessionStorage.getItem(`sales_checkout_notes_int_${company.id}`);
    const storedCustNotes = sessionStorage.getItem(`sales_checkout_notes_cust_${company.id}`);
    const storedDiscount = sessionStorage.getItem(`sales_checkout_discount_${company.id}`);
    const storedDiscountType = sessionStorage.getItem(`sales_checkout_discount_type_${company.id}`);
    const storedShipping = sessionStorage.getItem(`sales_checkout_shipping_${company.id}`);
    const storedTax = sessionStorage.getItem(`sales_checkout_tax_rate_${company.id}`);

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
  }, [company.id]);

  const subtotal = cartItems.reduce((acc, item) => acc + Number(item.price) * item.quantity, 0);
  const discountVal = discountType === "PERCENTAGE" ? (subtotal * (discountAmount / 100)) : discountAmount;
  const taxableAmount = Math.max(0, subtotal - discountVal);
  const taxVal = taxableAmount * (taxRate / 100);
  const grandTotal = taxableAmount + taxVal + shippingCost;
  const displayCurrencyCode =
    (cartItems.find((item) => item.currencyCode)?.currencyCode || "USD").toUpperCase();

  const formatCurrency = (val: string | number, currencyCode = displayCurrencyCode) => {
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

  const isSubmitting = navigation.state === "submitting";

  const submitReview = (quoteAction?: "save_quote_draft" | "submit_quote") => {
    if (cartItems.length === 0) {
      setErrorMsg(`Cannot submit an empty ${isQuoteMode ? "quote" : "order"}.`);
      return;
    }
    submit({
      actionType: quoteAction || "process_order",
      customerId: selectedCustomer.shopifyCustomerId,
      cartData: JSON.stringify(cartItems),
      internalNotes,
      customerNotes,
      discountAmount: discountAmount.toString(),
      discountType,
      shippingCost: shippingCost.toString(),
      taxRate: taxRate.toString(),
      quoteTitle,
      expirationDate,
    }, { method: "POST" });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitReview(isQuoteMode ? "submit_quote" : undefined);
  };

  return (
    <div style={styles.container}>
      {/* Top Header Navigation */}
      <header style={styles.header}>
        <div style={styles.headerContent}>
          <div style={styles.breadcrumb}>
            <Link to={`/sales/portal?companyId=${company.id}`} style={styles.breadcrumbLink}>Dashboard</Link>
            <span style={styles.breadcrumbSeparator}>/</span>
            <Link to={`/sales/portal?companyId=${company.id}`} style={styles.breadcrumbLink}>{company.name}</Link>
            <span style={styles.breadcrumbSeparator}>/</span>
            <Link to={`${flowBase}/step2?customerId=${selectedCustomer.shopifyCustomerId}`} style={styles.breadcrumbLink}>Product Catalog</Link>
            <span style={styles.breadcrumbSeparator}>/</span>
            <span style={styles.breadcrumbCurrent}>{isQuoteMode ? "Review Quote" : "Review Order"}</span>
          </div>
          <div style={styles.headerUser}>
            <div style={styles.avatar}>
              {user.firstName?.charAt(0) || user.email.charAt(0).toUpperCase()}
            </div>
            <span style={styles.userName}>{user.firstName} {user.lastName}</span>
          </div>
        </div>
      </header>

      <main style={styles.mainContent}>
        <div style={styles.pageHeader}>
          <h1 style={styles.pageTitle}>{isQuoteMode ? "Review B2B Quote" : "Review B2B Order"}</h1>
          <p style={styles.pageSubtitle}>
            {isQuoteMode
              ? "Verify pricing, expiration, and notes before saving or sending the quote."
              : "Verify details and complete the purchasing flow for the company location."}
          </p>
        </div>

        {errorMsg && (
          <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "12px 16px", color: "#991b1b", marginBottom: "20px", fontSize: "14px" }}>
            ⚠️ {errorMsg}
          </div>
        )}

        <div style={styles.layoutGrid}>
          {/* Left Column: Details */}
          <section style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            {/* Customer info card */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Customer Information</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", fontSize: "14px" }}>
                <div>
                  <span style={{ fontWeight: 600, color: "#4b5563" }}>B2B Company:</span>
                  <div style={{ marginTop: "4px", fontSize: "16px", fontWeight: 700, color: "#111827" }}>{company.name}</div>
                </div>
                <div>
                  <span style={{ fontWeight: 600, color: "#4b5563" }}>B2B Buyer Contact:</span>
                  <div style={{ marginTop: "4px", fontSize: "16px", fontWeight: 700, color: "#111827" }}>{selectedCustomer.firstName} {selectedCustomer.lastName}</div>
                  <div style={{ fontSize: "13px", color: "#6b7280" }}>{selectedCustomer.email}</div>
                </div>
              </div>
            </div>

            {isQuoteMode && (
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>Quote Information</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: "16px" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#374151" }}>
                    Quote Title
                    <input
                      value={quoteTitle}
                      onChange={(e) => setQuoteTitle(e.target.value)}
                      placeholder={`${company.name} quote`}
                      style={{ height: "42px", borderRadius: "8px", border: "1px solid #d1d5db", padding: "0 12px", font: "inherit" }}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#374151" }}>
                    Expiration Date
                    <input
                      type="date"
                      value={expirationDate}
                      onChange={(e) => setExpirationDate(e.target.value)}
                      style={{ height: "42px", borderRadius: "8px", border: "1px solid #d1d5db", padding: "0 12px", font: "inherit" }}
                    />
                  </label>
                </div>
              </div>
            )}

            {/* Line Items Card */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>{isQuoteMode ? "Quote" : "Order"} Line Items ({cartItems.length} Products)</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {cartItems.map((item) => (
                  <div key={item.variantId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #f3f4f6", paddingBottom: "12px" }}>
                    <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                      <div style={{ width: "56px", height: "56px", borderRadius: "8px", overflow: "hidden", backgroundColor: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {item.image ? (
                          <img src={item.image} alt={item.productTitle} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <span style={{ fontSize: "24px" }}>📦</span>
                        )}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, color: "#111827", fontSize: "14px" }}>{item.productTitle}</div>
                        {item.variantTitle !== "Default Title" && (
                          <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>Variant: {item.variantTitle}</div>
                        )}
                        <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: "2px" }}>SKU: {item.sku || "N/A"}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 700, color: "#111827", fontSize: "14px" }}>{formatCurrency(Number(item.price) * item.quantity)}</div>
                      <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>{item.quantity} × {formatCurrency(item.price)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Notes Card */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>{isQuoteMode ? "Quote" : "Order"} Notes</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", fontSize: "13px" }}>
                <div>
                  <h4 style={{ margin: "0 0 6px 0", color: "#ef4444" }}>Internal Notes (Private)</h4>
                  <div style={{ padding: "10px", backgroundColor: "#fef2f2", border: "1px solid #fee2e2", borderRadius: "6px", minHeight: "60px", whiteSpace: "pre-wrap" }}>
                    {internalNotes || "No internal notes provided."}
                  </div>
                </div>
                <div>
                  <h4 style={{ margin: "0 0 6px 0", color: "#3b82f6" }}>Customer Notes (Public)</h4>
                  <div style={{ padding: "10px", backgroundColor: "#eff6ff", border: "1px solid #dbeafe", borderRadius: "6px", minHeight: "60px", whiteSpace: "pre-wrap" }}>
                    {customerNotes || "No customer notes provided."}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Right Column: Pricing & Submit */}
          <aside style={styles.sidebar}>
            <div style={styles.card}>
              <h3 style={styles.sidebarTitle}>{isQuoteMode ? "Quote" : "Order"} Summary</h3>

              <div style={{ display: "flex", flexDirection: "column", gap: "12px", fontSize: "14px", color: "#4b5563", marginBottom: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Subtotal:</span>
                  <span style={{ fontWeight: 600, color: "#111827" }}>{formatCurrency(subtotal)}</span>
                </div>
                {discountVal > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#10b981", fontWeight: 600 }}>
                    <span>Discount:</span>
                    <span>-{formatCurrency(discountVal)}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Est. Taxes ({taxRate}%):</span>
                  <span style={{ fontWeight: 600, color: "#111827" }}>{formatCurrency(taxVal)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Est. Shipping:</span>
                  <span style={{ fontWeight: 600, color: "#111827" }}>{formatCurrency(shippingCost)}</span>
                </div>
                <div style={{ height: "1px", backgroundColor: "#eaeaea", margin: "8px 0" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "18px", fontWeight: 800, color: "#111827" }}>
                  <span>Grand Total:</span>
                  <span style={{ color: "#E91E63" }}>{formatCurrency(grandTotal)}</span>
                </div>
              </div>

              <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {isQuoteMode && (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => submitReview("save_quote_draft")}
                    style={styles.backBtn}
                  >
                    Save Draft Quote
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={styles.submitBtn}
                >
                  {isSubmitting
                    ? isQuoteMode
                      ? "Saving Quote..."
                      : "Processing Order..."
                    : isQuoteMode
                      ? "Submit Quote"
                      : "Process Order"}
                </button>
                <Link
                  to={`${flowBase}/step2?customerId=${selectedCustomer.shopifyCustomerId}`}
                  style={styles.backBtn}
                >
                  {isQuoteMode ? "Edit Quote" : "Modify Order"}
                </Link>
              </form>
            </div>
          </aside>
        </div>
      </main>
    </div>
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
    boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03)",
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
};
