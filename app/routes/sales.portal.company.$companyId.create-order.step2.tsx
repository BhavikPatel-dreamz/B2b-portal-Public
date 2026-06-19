import { LoaderFunctionArgs, ActionFunctionArgs, redirect } from "react-router";
import { useLoaderData, Link, useSubmit, useNavigation, useSearchParams, useFetcher } from "react-router";
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
  type SalesDraftLineItemInput,
  type SalesDraftShippingLineInput,
} from "app/utils/sales-order-pricing.server";

type DraftCartItem = {
  variantId: string;
  quantity: number;
  price: string | number;
  currencyCode?: string | null;
};

type ShopifyCompanyContactEdge = {
  node: {
    id?: string;
    customer?: {
      id?: string | null;
    } | null;
    roleAssignments?: {
      edges?: Array<{
        node?: {
          companyLocation?: {
            id?: string | null;
          } | null;
        } | null;
      }>;
    } | null;
  };
};

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

type SaveDraftResponse = {
  success?: boolean;
  error?: string;
  name?: string;
  id?: string;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const formData = await request.formData();
    const actionType = formData.get("actionType") as string;
    const companyId = params.companyId;

    if (actionType !== "save_draft") {
      return Response.json({ error: "Invalid order action" }, { status: 400 });
    }

    const { user } = await requireSalesSession(request);
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

    const cartData = JSON.parse(cartDataStr || "[]") as DraftCartItem[];
    if (cartData.length === 0) {
      return Response.json({ error: "Cart is empty" }, { status: 400 });
    }

    // Fetch B2B company, locations, and contacts to build purchasingEntity
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
    const contacts = (baseMetaData.data?.company?.contacts?.edges || []) as ShopifyCompanyContactEdge[];
    const matchCustGid = `gid://shopify/Customer/${customerId}`;
    const matchedContact = contacts.find((edge) => edge.node.customer?.id === matchCustGid);
    
    const companyLocationId = matchedContact?.node.roleAssignments?.edges?.[0]?.node?.companyLocation?.id || 
                              baseMetaData.data?.company?.locations?.nodes?.[0]?.id || "";
    const companyContactId = matchedContact?.node?.id || "";

    if (!companyLocationId || !companyContactId) {
      return Response.json({ error: "B2B context missing. The selected customer is not correctly assigned as a contact for this company in Shopify." }, { status: 400 });
    }

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

    const draftOrderMutation = `
      mutation CreateB2BDraft($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
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

    const createdDraft = draftData.data?.draftOrderCreate?.draftOrder;
    if (!createdDraft || !createdDraft.id) {
      return Response.json({ error: "Failed to create draft order. Invalid Shopify response." }, { status: 400 });
    }

    const dbUser = await prisma.user.findFirst({
      where: { email: user.email }
    });

    if (dbUser) {
      const shopifyOrderTotal = Number(createdDraft.totalPriceSet?.shopMoney?.amount);
      const orderTotal = Number.isFinite(shopifyOrderTotal) ? shopifyOrderTotal : totals.total;
      
      const shopifyDraftOrderId = createdDraft.id.replace("gid://shopify/DraftOrder/", "");

      await prisma.b2BOrder.upsert({
        where: { shopifyOrderId: shopifyDraftOrderId },
        create: {
          companyId: company.id,
          createdByUserId: dbUser.id,
          shopId: company.shopId,
          shopifyOrderId: shopifyDraftOrderId,
          orderTotal: orderTotal,
          creditUsed: 0,
          paymentStatus: "pending",
          orderStatus: "draft",
          remainingBalance: orderTotal,
          userCreditUsed: 0,
          notes: internalNotes,
          source: "Sales Portal",
        },
        update: {
          companyId: company.id,
          createdByUserId: dbUser.id,
          shopId: company.shopId,
          orderTotal: orderTotal,
          remainingBalance: orderTotal,
          paymentStatus: "pending",
          orderStatus: "draft",
          notes: internalNotes,
          source: "Sales Portal",
        },
      });
    }

    return Response.json({ success: true, name: createdDraft.name, id: createdDraft.id });
  } catch (err: any) {
    if (err instanceof Response) throw err;
    console.error("Action Crash Error:", err);
    return Response.json({ error: `Server crash: ${err?.message || "Unknown error"}` }, { status: 500 });
  }
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;

  if (!companyId) {
    return redirect("/sales/portal");
  }

  if (!hasCompanyAccess(user, companyId)) {
    return redirect("/sales/portal");
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  
  if (!customerId) {
    return redirect(`/sales/portal/company/${companyId}/create-order`);
  }

  // Find the company and the selected customer user
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

  // Fetch store's default tax rate
  const store = await prisma.store.findUnique({
    where: { id: company.shopId },
    select: { defaultTaxRate: true },
  });
  const defaultTaxRate = store?.defaultTaxRate ? Number(store.defaultTaxRate) : 8;

  let selectedCustomer = await prisma.user.findFirst({
    where: { shopifyCustomerId: customerId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      shopifyCustomerId: true,
      companyRole: true,
    },
  });

  // If the user isn't synced to Prisma yet, query Shopify B2B customer endpoint directly
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
          id: customerId, // use shopify ID
          firstName: shopifyCust.firstName,
          lastName: shopifyCust.lastName,
          email: shopifyCust.email,
          shopifyCustomerId: customerId,
          companyRole: "Customer",
        };
      }
    } catch (e) {
      console.error("Failed to query customer details from Shopify:", e);
    }
  }

  if (!selectedCustomer) {
    return redirect(`/sales/portal/company/${companyId}/create-order`);
  }

  // Query search/filter parameters
  const searchQuery = url.searchParams.get("q")?.trim() || "";
  const filterVendor = url.searchParams.get("vendor")?.trim() || "";
  const filterType = url.searchParams.get("product_type")?.trim() || "";
  const filterTag = url.searchParams.get("tag")?.trim() || "";
  const filterCollection = url.searchParams.get("collection_id")?.trim() || "";
  const cursor = url.searchParams.get("cursor") || null;

  // Build shopify query
  const queryFilters = ["status:active", "published_status:published"];
  if (searchQuery) {
    // Search by title, SKU, or Barcode
    queryFilters.push(`(title:${searchQuery}* OR sku:${searchQuery}* OR barcode:${searchQuery}*)`);
  }
  if (filterVendor) {
    queryFilters.push(`vendor:"${filterVendor}"`);
  }
  if (filterType) {
    queryFilters.push(`product_type:"${filterType}"`);
  }
  if (filterTag) {
    queryFilters.push(`tag:"${filterTag}"`);
  }

  const shopifySearchQuery = queryFilters.join(" ");

  // 1. Fetch Company Location ID to get B2B Contextual pricing
  let locationId = "";
  let companyContactId = "";
  let collections: Array<{ id: string; title: string }> = [];
  let products: any[] = [];
  let pageInfo = { hasNextPage: false, endCursor: null };
  let filterOptions = { vendors: [] as string[], productTypes: [] as string[], tags: [] as string[] };

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const shopDomain = company.shop.shopDomain;
    const token = company.shop.accessToken;

    try {
      // Fetch Locations, Collections and Company Contacts to map customer to location
      const baseMetaQuery = `
        query GetBaseMeta($companyId: ID!) {
          company(id: $companyId) {
            locations(first: 10) {
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
          collections(first: 250) {
            nodes {
              id
              title
            }
          }
        }
      `;

      const baseMetaRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query: baseMetaQuery, variables: { companyId: company.shopifyCompanyId } }),
      });
      const baseMetaData = await baseMetaRes.json();
      
      collections = baseMetaData.data?.collections?.nodes || [];

      // Resolve locationId based on customer location assignment, falling back to company's first location
      const contacts = baseMetaData.data?.company?.contacts?.edges || [];
      const matchCustGid = `gid://shopify/Customer/${selectedCustomer.shopifyCustomerId}`;
      const matchedContact = contacts.find((edge: any) => edge.node.customer?.id === matchCustGid);
      const matchedLocationId = matchedContact?.node.roleAssignments?.edges?.[0]?.node?.companyLocation?.id;
      companyContactId = matchedContact?.node?.id || "";

      locationId = matchedLocationId || baseMetaData.data?.company?.locations?.nodes?.[0]?.id || "";

      // If a collection is selected, we must fetch products from that specific collection connection.
      // Otherwise we use the global products search query.
      let productsQuery = "";
      let productsVariables: any = { cursor, locationId };

      if (filterCollection) {
        productsQuery = `
          query GetCollectionProducts($collectionId: ID!, $cursor: String, $locationId: ID!) {
            collection(id: $collectionId) {
              products(first: 24, after: $cursor) {
                edges {
                  cursor
                  node {
                    id
                    title
                    vendor
                    productType
                    tags
                    featuredImage { url }
                    variants(first: 100) {
                      nodes {
                        id
                        title
                        sku
                        barcode
                        contextualPricing(context: { companyLocationId: $locationId }) {
                          price { amount currencyCode }
                        }
                        inventoryQuantity
                        inventoryPolicy
                        availableForSale
                      }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        `;
        productsVariables.collectionId = filterCollection;
      } else {
        productsQuery = `
          query GetSearchProducts($query: String!, $cursor: String, $locationId: ID!) {
            products(first: 24, after: $cursor, query: $query) {
              edges {
                cursor
                node {
                  id
                  title
                  vendor
                  productType
                  tags
                  featuredImage { url }
                  variants(first: 100) {
                    nodes {
                      id
                      title
                      sku
                      barcode
                      contextualPricing(context: { companyLocationId: $locationId }) {
                        price { amount currencyCode }
                      }
                      inventoryQuantity
                      inventoryPolicy
                      availableForSale
                    }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        `;
        productsVariables.query = shopifySearchQuery;
      }

      // Fetch products
      const productsRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query: productsQuery, variables: productsVariables }),
      });
      const productsData = await productsRes.json();
      
      const productEdges = filterCollection 
        ? productsData.data?.collection?.products?.edges || [] 
        : productsData.data?.products?.edges || [];
      
      const productPageInfo = filterCollection 
        ? productsData.data?.collection?.products?.pageInfo 
        : productsData.data?.products?.pageInfo;

      if (productPageInfo) {
        pageInfo = productPageInfo;
      }

      products = productEdges
        .map((edge: any) => {
          const node = edge.node;
          const mappedVariants = node.variants?.nodes?.map((v: any) => {
            const contextualPrice = v.contextualPricing?.price?.amount;
            return {
              id: v.id,
              title: v.title,
              sku: v.sku || "",
              barcode: v.barcode || "",
              price: contextualPrice ? contextualPrice : null,
              currencyCode: v.contextualPricing?.price?.currencyCode || "USD",
              inventoryQuantity: v.inventoryQuantity || 0,
              availableForSale: v.availableForSale,
              inStock: v.availableForSale && (v.inventoryQuantity > 0 || v.inventoryPolicy === "CONTINUE"),
            };
          }) || [];

          return {
            id: node.id,
            title: node.title,
            vendor: node.vendor,
            productType: node.productType,
            tags: node.tags || [],
            image: node.featuredImage?.url || "",
            variants: mappedVariants,
          };
        })
        .filter((p: any) => {
          // Filter out products that are restricted (not present in any catalog assigned to this company location)
          return p.variants.some((v: any) => v.price !== null);
        });

      // Build filters using a lightweight parallel query of first 250 products
      const filterMetaQuery = `
        query GetFilterMeta($query: String!) {
          products(first: 250, query: $query) {
            nodes {
              vendor
              productType
              tags
            }
          }
        }
      `;
      const filterMetaRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query: filterMetaQuery, variables: { query: shopifySearchQuery } }),
      });
      const filterMetaData = await filterMetaRes.json();
      const filterNodes = filterMetaData.data?.products?.nodes || [];
      
      const vendorsSet = new Set<string>();
      const typesSet = new Set<string>();
      const tagsSet = new Set<string>();

      filterNodes.forEach((p: any) => {
        if (p.vendor) vendorsSet.add(p.vendor);
        if (p.productType) typesSet.add(p.productType);
        p.tags?.forEach((t: string) => tagsSet.add(t));
      });

      filterOptions = {
        vendors: Array.from(vendorsSet).sort(),
        productTypes: Array.from(typesSet).sort(),
        tags: Array.from(tagsSet).sort()
      };

    } catch (e) {
      console.error("GraphQL metadata load failed:", e);
    }
  }

  return Response.json({
    company: {
      id: company.id,
      name: company.name,
      creditLimit: company.creditLimit.toString(),
      companyLocationId: locationId,
      companyContactId: companyContactId,
      defaultTaxRate: defaultTaxRate,
    },
    selectedCustomer,
    products,
    collections,
    filterOptions,
    pageInfo,
    searchParams: {
      q: searchQuery,
      vendor: filterVendor,
      product_type: filterType,
      tag: filterTag,
      collection_id: filterCollection,
    },
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    }
  });
};

export default function CreateOrderProductCatalog() {
  const { company, selectedCustomer, products, collections, filterOptions, pageInfo, searchParams, user } = useLoaderData<any>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const draftFetcher = useFetcher<SaveDraftResponse>();
  const [urlParams, setUrlParams] = useSearchParams();

  // Local State for Search/Filters
  const [search, setSearch] = useState(searchParams.q || "");
  const [selectedCollection, setSelectedCollection] = useState(searchParams.collection_id || "");
  const [selectedVendor, setSelectedVendor] = useState(searchParams.vendor || "");
  const [selectedType, setSelectedType] = useState(searchParams.product_type || "");
  const [selectedTag, setSelectedTag] = useState(searchParams.tag || "");

  // Local state for Product Cards
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({}); // { productId: variantId }
  const [quantities, setQuantities] = useState<Record<string, number>>({}); // { variantId: quantity }
  const [cart, setCart] = useState<Record<string, any>>({});
  const [internalNotes, setInternalNotes] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [discountAmount, setDiscountAmount] = useState(0);
  const [discountType, setDiscountType] = useState<"PERCENTAGE" | "FIXED_AMOUNT">("FIXED_AMOUNT");
  const [estShipping, setEstShipping] = useState(45);
  const [estTaxRate, setEstTaxRate] = useState(company.defaultTaxRate || 8); // Initialize with store's default tax rate
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);
  const [lastRemovedItem, setLastRemovedItem] = useState<any>(null);
  const [showUndoBanner, setShowUndoBanner] = useState(false);
  const [draftSaveStatus, setDraftSaveStatus] = useState<{ success?: boolean; error?: string; name?: string } | null>(null);
  const isSavingDraft = draftFetcher.state !== "idle";
  const selectedCustomerShopifyId = selectedCustomer.shopifyCustomerId || selectedCustomer.id || "";

  // Initialize selected variants and quantities
  useEffect(() => {
    const initialVariants: Record<string, string> = {};
    const initialQuantities: Record<string, number> = {};

    products.forEach((product: any) => {
      if (product.variants && product.variants.length > 0) {
        const firstVariant = product.variants[0];
        initialVariants[product.id] = firstVariant.id;
        initialQuantities[firstVariant.id] = 1;
      }
    });

    setSelectedVariants(prev => ({ ...initialVariants, ...prev }));
    setQuantities(prev => ({ ...initialQuantities, ...prev }));
  }, [products]);

  // Load cart and notes from localStorage
  useEffect(() => {
    const cartKey = `sales_cart_${company.id}_${selectedCustomer.id}`;
    const storedCart = localStorage.getItem(cartKey);
    if (storedCart) {
      try {
        setCart(JSON.parse(storedCart));
      } catch (e) {
        console.error("Failed to load cart", e);
      }
    }

    const intNotesKey = `sales_int_notes_${company.id}_${selectedCustomer.id}`;
    const custNotesKey = `sales_cust_notes_${company.id}_${selectedCustomer.id}`;
    const storedIntNotes = localStorage.getItem(intNotesKey);
    const storedCustNotes = localStorage.getItem(custNotesKey);
    if (storedIntNotes) setInternalNotes(storedIntNotes);
    if (storedCustNotes) setCustomerNotes(storedCustNotes);
  }, [company.id, selectedCustomer.id]);

  const saveCart = (newCart: Record<string, any>) => {
    setCart(newCart);
    const cartKey = `sales_cart_${company.id}_${selectedCustomer.id}`;
    localStorage.setItem(cartKey, JSON.stringify(newCart));
  };

  const saveInternalNotes = (val: string) => {
    setInternalNotes(val);
    localStorage.setItem(`sales_int_notes_${company.id}_${selectedCustomer.id}`, val);
  };

  const saveCustomerNotes = (val: string) => {
    setCustomerNotes(val);
    localStorage.setItem(`sales_cust_notes_${company.id}_${selectedCustomer.id}`, val);
  };

  useEffect(() => {
    if (!draftFetcher.data) {
      return;
    }

    if (draftFetcher.data.success) {
      setDraftSaveStatus({ success: true, name: draftFetcher.data.name });
    } else {
      setDraftSaveStatus({ error: draftFetcher.data.error || "Failed to save draft order" });
    }

  }, [draftFetcher.data]);

  const saveDraftOrder = () => {
    setDraftSaveStatus(null);

    const formData = new FormData();
    formData.append("actionType", "save_draft");
    formData.append("customerId", selectedCustomerShopifyId);
    formData.append("cartData", JSON.stringify(Object.values(cart)));
    formData.append("internalNotes", internalNotes);
    formData.append("customerNotes", customerNotes);
    formData.append("discountAmount", discountAmount.toString());
    formData.append("discountType", discountType);
    formData.append("shippingCost", estShipping.toString());
    formData.append("taxRate", estTaxRate.toString());

    draftFetcher.submit(formData, {
      method: "post",
      action: `${window.location.pathname}${window.location.search}`,
    });
  };

  const isLoading = navigation.state === "loading";

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    applyFilters();
  };

  const applyFilters = () => {
    const params = new URLSearchParams();
    params.set("customerId", selectedCustomerShopifyId);
    if (search) params.set("q", search);
    if (selectedCollection) params.set("collection_id", selectedCollection);
    if (selectedVendor) params.set("vendor", selectedVendor);
    if (selectedType) params.set("product_type", selectedType);
    if (selectedTag) params.set("tag", selectedTag);
    setUrlParams(params);
  };

  const clearFilters = () => {
    setSearch("");
    setSelectedCollection("");
    setSelectedVendor("");
    setSelectedType("");
    setSelectedTag("");
    setUrlParams({ customerId: selectedCustomerShopifyId });
  };

  const handleVariantChange = (productId: string, variantId: string) => {
    setSelectedVariants(prev => ({ ...prev, [productId]: variantId }));
    if (!quantities[variantId]) {
      setQuantities(prev => ({ ...prev, [variantId]: 1 }));
    }
  };

  const handleQuantityChange = (variantId: string, val: number) => {
    if (val < 1) return;
    setQuantities(prev => ({ ...prev, [variantId]: val }));
  };

  const addToCart = (product: any) => {
    const selectedVariantId = selectedVariants[product.id];
    if (!selectedVariantId) return;

    const variant = product.variants.find((v: any) => v.id === selectedVariantId);
    if (!variant) return;

    const quantity = quantities[selectedVariantId] || 1;

    const newCart = { ...cart };
    if (newCart[selectedVariantId]) {
      newCart[selectedVariantId].quantity += quantity;
    } else {
      newCart[selectedVariantId] = {
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku,
        price: variant.price,
        currencyCode: variant.currencyCode,
        image: product.image,
        quantity,
      };
    }

    saveCart(newCart);
  };

  const removeFromCart = (variantId: string) => {
    const item = cart[variantId];
    if (item) {
      setLastRemovedItem(item);
      setShowUndoBanner(true);
      // Auto-hide undo banner after 6 seconds
      setTimeout(() => setShowUndoBanner(false), 6000);
    }
    const newCart = { ...cart };
    delete newCart[variantId];
    saveCart(newCart);
  };

  const undoRemove = () => {
    if (lastRemovedItem) {
      const newCart = { ...cart, [lastRemovedItem.variantId]: lastRemovedItem };
      saveCart(newCart);
      setLastRemovedItem(null);
      setShowUndoBanner(false);
    }
  };

  const updateCartItemQty = (variantId: string, qty: number) => {
    if (qty < 1) return;
    const newCart = { ...cart };
    if (newCart[variantId]) {
      newCart[variantId].quantity = qty;
      saveCart(newCart);
    }
  };

  const cartItems = Object.values(cart);
  const cartSubtotal = cartItems.reduce((acc: number, item: any) => acc + Number(item.price) * item.quantity, 0);
  const displayCurrencyCode =
    (cartItems.find((item: any) => item.currencyCode)?.currencyCode ||
      products.flatMap((product: any) => product.variants || []).find((variant: any) => variant.currencyCode)?.currencyCode ||
      "USD").toUpperCase();

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

  const totalUnits = cartItems.reduce((acc: number, item: any) => acc + item.quantity, 0);
  const calculatedDiscount = discountType === "PERCENTAGE" 
    ? (cartSubtotal * (discountAmount / 100)) 
    : discountAmount;
  const taxableAmount = Math.max(0, cartSubtotal - calculatedDiscount);
  const calculatedTax = taxableAmount * (estTaxRate / 100);
  const calculatedTotal = taxableAmount + calculatedTax + estShipping;

  const renderCartContents = () => {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Undo Banner */}
        {showUndoBanner && lastRemovedItem && (
          <div style={{
            backgroundColor: "#fffbeb",
            border: "1px solid #fef3c7",
            borderRadius: "8px",
            padding: "10px 12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "12px",
            color: "#92400e",
          }}>
            <span>Removed <strong>{lastRemovedItem.productTitle}</strong></span>
            <button 
              onClick={undoRemove}
              style={{
                background: "none",
                border: "none",
                color: "#b45309",
                fontWeight: 700,
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Undo
            </button>
          </div>
        )}

        {/* Draft Save Status Banner */}
        {draftSaveStatus && (
          <div style={{
            backgroundColor: draftSaveStatus.success ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${draftSaveStatus.success ? "#a7f3d0" : "#fecaca"}`,
            borderRadius: "8px",
            padding: "12px",
            fontSize: "12px",
            color: draftSaveStatus.success ? "#065f46" : "#991b1b",
            position: "relative",
          }}>
            <button 
              onClick={() => setDraftSaveStatus(null)}
              style={{
                position: "absolute",
                top: "6px",
                right: "8px",
                background: "none",
                border: "none",
                fontSize: "14px",
                cursor: "pointer",
                color: "inherit",
              }}
            >
              ✕
            </button>
            {draftSaveStatus.success ? (
              <div>
                <strong>Success!</strong>
                <p style={{ margin: "4px 0 0 0" }}>Order has been saved as draft successfully (Shopify Draft: <strong>{draftSaveStatus.name}</strong>).</p>
              </div>
            ) : (
              <div>
                <strong>Failed to Save Draft</strong>
                <p style={{ margin: "4px 0 0 0" }}>{draftSaveStatus.error}</p>
              </div>
            )}
          </div>
        )}

        {cartItems.length > 0 ? (
          <>
            {/* Scrollable Line Items */}
            <div style={{ ...styles.cartItemsList, maxHeight: "300px" }}>
              {cartItems.map((item: any) => {
                // Low stock warning check (if inventory tracking is enabled and quantity exceeds stock)
                const isLowStock = item.inventoryQuantity !== undefined && 
                                   item.inventoryQuantity > 0 && 
                                   item.quantity > item.inventoryQuantity;
                return (
                  <div key={item.variantId} style={{ ...styles.cartItem, borderBottom: "1px solid #f3f4f6", paddingBottom: "12px" }}>
                    <div style={{ display: "flex", gap: "10px", width: "100%" }}>
                      {/* Image */}
                      <div style={{ width: "48px", height: "48px", borderRadius: "6px", overflow: "hidden", backgroundColor: "#f3f4f6", flexShrink: 0 }}>
                        {item.image ? (
                          <img src={item.image} alt={item.productTitle} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: "20px" }}>📦</div>
                        )}
                      </div>

                      {/* Item Details */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: "13px", color: "#111827", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                          {item.productTitle}
                        </div>
                        {item.variantTitle !== "Default Title" && (
                          <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "2px" }}>
                            {item.variantTitle}
                          </div>
                        )}
                        <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: "2px" }}>
                          SKU: {item.sku || "N/A"}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "6px" }}>
                          <span style={{ fontWeight: 600, color: "#374151" }}>{formatCurrency(item.price)}</span>
                          <span style={{ fontSize: "12px", color: "#9ca3af" }}>Total: {formatCurrency(Number(item.price) * item.quantity)}</span>
                        </div>

                        {/* Low stock warning */}
                        {isLowStock && (
                          <div style={{ fontSize: "10px", color: "#b45309", marginTop: "4px", fontWeight: 600 }}>
                            ⚠️ Only {item.inventoryQuantity} units available in stock.
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions & Qty Management */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", marginTop: "10px", paddingLeft: "58px" }}>
                      <div style={styles.cartItemQty}>
                        <button 
                          type="button"
                          onClick={() => updateCartItemQty(item.variantId, item.quantity - 1)}
                          style={styles.cartItemQtyBtn}
                        >
                          -
                        </button>
                        <input 
                          type="number"
                          value={item.quantity}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            if (val >= 1) updateCartItemQty(item.variantId, val);
                          }}
                          style={{
                            width: "30px",
                            border: "none",
                            textAlign: "center",
                            fontSize: "12px",
                            fontWeight: 600,
                            outline: "none",
                          }}
                        />
                        <button 
                          type="button"
                          onClick={() => updateCartItemQty(item.variantId, item.quantity + 1)}
                          style={styles.cartItemQtyBtn}
                        >
                          +
                        </button>
                      </div>
                      <button 
                        type="button"
                        onClick={() => removeFromCart(item.variantId)} 
                        style={{ ...styles.cartRemoveBtn, color: "#ef4444", display: "flex", alignItems: "center", gap: "2px" }}
                      >
                        🗑️ <span style={{ fontSize: "11px" }}>Remove</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={styles.cartDivider} />

            {/* Calculations & Pricing Fields */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#6b7280" }}>Subtotal:</span>
                <span style={{ fontWeight: 600 }}>{formatCurrency(cartSubtotal)}</span>
              </div>

              {/* Agent Discount */}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "#4b5563" }}>APPLY DISCOUNT</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input 
                    type="number"
                    min="0"
                    placeholder="Amount"
                    value={discountAmount || ""}
                    onChange={(e) => setDiscountAmount(Math.max(0, Number(e.target.value)))}
                    style={{ ...styles.select, flex: 1, height: "32px", fontSize: "12px" }}
                  />
                  <select 
                    value={discountType}
                    onChange={(e: any) => setDiscountType(e.target.value)}
                    style={{ ...styles.select, width: "70px", height: "32px", fontSize: "11px", padding: "0 4px" }}
                  >
                    <option value="FIXED_AMOUNT">$ Fixed</option>
                    <option value="PERCENTAGE">% Percent</option>
                  </select>
                </div>
              </div>

              {/* Shipping & Taxes rate input */}
              <div style={{ display: "flex", gap: "8px" }}>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "11px", fontWeight: 600, color: "#4b5563" }}>EST. SHIPPING ($)</label>
                  <input 
                    type="number"
                    min="0"
                    value={estShipping}
                    onChange={(e) => setEstShipping(Math.max(0, Number(e.target.value)))}
                    style={{ ...styles.select, height: "32px", fontSize: "12px" }}
                  />
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={{ fontSize: "11px", fontWeight: 600, color: "#4b5563" }}>EST. TAX RATE (%)</label>
                  <input 
                    type="number"
                    min="0"
                    value={estTaxRate}
                    onChange={(e) => setEstTaxRate(Math.max(0, Number(e.target.value)))}
                    style={{ ...styles.select, height: "32px", fontSize: "12px" }}
                  />
                </div>
              </div>

              {calculatedDiscount > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", color: "#10b981", fontWeight: 600 }}>
                  <span>Discount:</span>
                  <span>-{formatCurrency(calculatedDiscount)}</span>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", color: "#6b7280" }}>
                <span>Est. Tax ({estTaxRate}%):</span>
                <span>{formatCurrency(calculatedTax)}</span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", color: "#6b7280" }}>
                <span>Est. Shipping:</span>
                <span>{formatCurrency(estShipping)}</span>
              </div>

              <div style={{ ...styles.subtotalRow, margin: "8px 0 0 0", borderTop: "1px dashed #e5e7eb", paddingTop: "8px" }}>
                <span>Estimated Total:</span>
                <span style={styles.subtotalVal}>{formatCurrency(calculatedTotal)}</span>
              </div>
            </div>

            <div style={styles.cartDivider} />

            {/* Notes Section */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "#4b5563" }}>INTERNAL NOTES (AGENT/ADMIN)</label>
                <textarea 
                  value={internalNotes}
                  onChange={(e) => saveInternalNotes(e.target.value)}
                  placeholder="Expedited shipping approved, custom price match..."
                  style={{
                    width: "100%",
                    height: "60px",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                    padding: "6px 10px",
                    fontSize: "12px",
                    outline: "none",
                    resize: "none",
                    fontFamily: "inherit",
                  }}
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "#4b5563" }}>CUSTOMER NOTES (VISIBLE ON ORDER)</label>
                <textarea 
                  value={customerNotes}
                  onChange={(e) => saveCustomerNotes(e.target.value)}
                  placeholder="Delivery scheduled for Friday, delivery gate code..."
                  style={{
                    width: "100%",
                    height: "60px",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                    padding: "6px 10px",
                    fontSize: "12px",
                    outline: "none",
                    resize: "none",
                    fontFamily: "inherit",
                  }}
                />
              </div>
            </div>

            <div style={styles.cartDivider} />

            {/* Actions Footer */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <button
                type="button"
                onClick={saveDraftOrder}
                disabled={isSavingDraft}
                style={{
                  ...styles.clearBtn,
                  backgroundColor: isSavingDraft ? "#f3f4f6" : "#ffffff",
                  border: "1px solid #d1d5db",
                  color: "#374151",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}
              >
                {isSavingDraft ? (
                  <>
                    <span className="save-spinner" style={{
                      width: "16px",
                      height: "16px",
                      border: "2px solid #d1d5db",
                      borderTop: "2px solid #374151",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }}></span>
                    Saving Draft...
                  </>
                ) : (
                  "💾 Save Draft Order"
                )}
              </button>

              <Link 
                to={`/sales/portal/company/${company.id}/create-order/step3?customerId=${selectedCustomerShopifyId}`}
                style={styles.checkoutBtn}
                onClick={() => {
                  // Save all order details to sessionStorage to pass to Step 3
                  sessionStorage.setItem(`sales_checkout_cart_${company.id}`, JSON.stringify(cartItems));
                  sessionStorage.setItem(`sales_checkout_notes_int_${company.id}`, internalNotes);
                  sessionStorage.setItem(`sales_checkout_notes_cust_${company.id}`, customerNotes);
                  sessionStorage.setItem(`sales_checkout_discount_${company.id}`, discountAmount.toString());
                  sessionStorage.setItem(`sales_checkout_discount_type_${company.id}`, discountType);
                  sessionStorage.setItem(`sales_checkout_shipping_${company.id}`, estShipping.toString());
                  sessionStorage.setItem(`sales_checkout_tax_rate_${company.id}`, estTaxRate.toString());
                }}
              >
                Review Order →
              </Link>
            </div>
          </>
        ) : (
          <div style={styles.emptyCart}>
            <span style={{ fontSize: "36px", marginBottom: "8px" }}>🛒</span>
            <p style={{ margin: 0, fontWeight: 500, color: "#4b5563" }}>Cart is empty</p>
            <p style={{ margin: "4px 0 0 0", fontSize: "12px" }}>Select variants and add products above to start building the B2B order.</p>
          </div>
        )}
      </div>
    );
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
            <Link to={`/sales/portal/company/${company.id}/create-order`} style={styles.breadcrumbLink}>Create Order</Link>
            <span style={styles.breadcrumbSeparator}>/</span>
            <span style={styles.breadcrumbCurrent}>Product Catalog</span>
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
          <div style={styles.headerInfo}>
            <h1 style={styles.pageTitle}>Create Order: {company.name}</h1>
            <p style={styles.pageSubtitle}>
              Step 2: Add Products for <strong style={{ color: "#E91E63" }}>{selectedCustomer.firstName} {selectedCustomer.lastName}</strong>
            </p>
          </div>
        </div>

        {/* Three Column Layout: Filters (Left), Products (Center), Cart Summary (Right) */}
        <div style={styles.layoutGrid}>
          
          {/* Column 1: Filters */}
          <aside style={styles.filterSidebar}>
            <div style={styles.card}>
              <h3 style={styles.sidebarTitle}>Filters</h3>

              <div style={styles.filterGroup}>
                <label style={styles.filterLabel}>Collection</label>
                <select 
                  style={styles.select} 
                  value={selectedCollection} 
                  onChange={(e) => setSelectedCollection(e.target.value)}
                  disabled={isLoading}
                >
                  <option value="">All Collections</option>
                  {collections.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.title}</option>
                  ))}
                </select>
              </div>

              <div style={styles.filterGroup}>
                <label style={styles.filterLabel}>Vendor</label>
                <select 
                  style={styles.select} 
                  value={selectedVendor} 
                  onChange={(e) => setSelectedVendor(e.target.value)}
                  disabled={isLoading}
                >
                  <option value="">All Vendors</option>
                  {filterOptions.vendors.map((v: string) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>

              <div style={styles.filterGroup}>
                <label style={styles.filterLabel}>Product Type</label>
                <select 
                  style={styles.select} 
                  value={selectedType} 
                  onChange={(e) => setSelectedType(e.target.value)}
                  disabled={isLoading}
                >
                  <option value="">All Types</option>
                  {filterOptions.productTypes.map((t: string) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div style={styles.filterGroup}>
                <label style={styles.filterLabel}>Tag</label>
                <select 
                  style={styles.select} 
                  value={selectedTag} 
                  onChange={(e) => setSelectedTag(e.target.value)}
                  disabled={isLoading}
                >
                  <option value="">All Tags</option>
                  {filterOptions.tags.map((t: string) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div style={styles.filterActions}>
                <button 
                  onClick={applyFilters} 
                  style={{
                    ...styles.applyBtn,
                    opacity: isLoading ? 0.7 : 1,
                    cursor: isLoading ? "not-allowed" : "pointer"
                  }}
                  disabled={isLoading}
                >
                  {isLoading ? "Loading..." : "Apply Filters"}
                </button>
                <button 
                  onClick={clearFilters} 
                  style={styles.clearBtn}
                  disabled={isLoading}
                >
                  Clear All
                </button>
              </div>
            </div>
          </aside>

          {/* Column 2: Products Listing */}
          <section style={styles.productsSection}>
            <form onSubmit={handleSearchSubmit} style={styles.searchBarForm}>
              <div style={styles.searchContainer}>
                <input 
                  type="text" 
                  placeholder="Search by product name, SKU, or Barcode..." 
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={styles.searchInput}
                  disabled={isLoading}
                />
                <button 
                  type="submit" 
                  style={{
                    ...styles.searchBtn,
                    opacity: isLoading ? 0.7 : 1,
                    cursor: isLoading ? "not-allowed" : "pointer"
                  }}
                  disabled={isLoading}
                >
                  {isLoading ? "..." : "Search"}
                </button>
              </div>
            </form>

            <div style={{ position: "relative", minHeight: "300px" }}>
              {isLoading && (
                <div style={styles.loaderOverlay}>
                  <div style={styles.spinner}></div>
                  <span style={styles.loaderText}>Updating Catalog...</span>
                </div>
              )}

              <div style={{ opacity: isLoading ? 0.4 : 1, transition: "opacity 0.2s" }}>
                {products.length > 0 ? (
                  <div style={styles.productsGrid}>
                    {products.map((product: any) => {
                      const currentVariantId = selectedVariants[product.id] || (product.variants[0]?.id);
                      const currentVariant = product.variants.find((v: any) => v.id === currentVariantId) || product.variants[0];
                      const currentQty = quantities[currentVariantId] || 1;

                      return (
                        <div key={product.id} style={styles.productCard}>
                          <div style={styles.imgContainer}>
                            {product.image ? (
                              <img src={product.image} alt={product.title} style={styles.productImage} />
                            ) : (
                              <div style={styles.placeholderImg}>📦</div>
                            )}
                          </div>

                          <div style={styles.productCardBody}>
                            <h4 style={styles.productTitle}>{product.title}</h4>
                            
                            <div style={styles.skuRow}>
                              <span style={styles.skuLabel}>SKU:</span>
                              <span style={styles.skuValue}>{currentVariant?.sku || "N/A"}</span>
                            </div>

                            {/* Customer Price (contextualized B2B pricing) */}
                            <div style={styles.priceRow}>
                              <span style={styles.priceLabel}>Customer Price:</span>
                              <span style={styles.priceValue}>{formatCurrency(currentVariant?.price || 0)}</span>
                            </div>

                        {/* Variant Selector */}
                        {product.variants.length > 1 && (
                          <div style={styles.selectorGroup}>
                            <select 
                              style={styles.variantSelect}
                              value={currentVariantId}
                              onChange={(e) => handleVariantChange(product.id, e.target.value)}
                            >
                              {product.variants.map((v: any) => (
                                <option key={v.id} value={v.id}>
                                  {v.title} ({formatCurrency(v.price)})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {/* Quantity Selector & Add To Cart Button */}
                        <div style={styles.actionRow}>
                          <div style={styles.qtyContainer}>
                            <button 
                              type="button" 
                              onClick={() => handleQuantityChange(currentVariantId, currentQty - 1)}
                              style={styles.qtyBtn}
                            >
                              -
                            </button>
                            <input 
                              type="number" 
                              value={currentQty} 
                              onChange={(e) => handleQuantityChange(currentVariantId, parseInt(e.target.value) || 1)}
                              style={styles.qtyInput}
                            />
                            <button 
                              type="button" 
                              onClick={() => handleQuantityChange(currentVariantId, currentQty + 1)}
                              style={styles.qtyBtn}
                            >
                              +
                            </button>
                          </div>

                          <button 
                            type="button" 
                            onClick={() => addToCart(product)} 
                            style={styles.addToCartBtn}
                            disabled={!currentVariant?.inStock}
                          >
                            {currentVariant?.inStock ? "Add" : "Out of Stock"}
                          </button>
                        </div>
                      </div>
                    </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={styles.emptyState}>
                    <span style={{ fontSize: "40px", marginBottom: "16px" }}>🔍</span>
                    <h3>No products found</h3>
                    <p>Try altering your filters or search terms.</p>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Floating Mobile Cart Button */}
          <button 
            type="button"
            onClick={() => setIsMobileCartOpen(true)} 
            className="mobile-cart-btn"
            style={{
              position: "fixed",
              bottom: "24px",
              right: "24px",
              width: "60px",
              height: "60px",
              borderRadius: "50%",
              background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
              color: "white",
              border: "none",
              boxShadow: "0 10px 15px -3px rgba(233, 30, 99, 0.3), 0 4px 6px -2px rgba(233, 30, 99, 0.05)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "24px",
              cursor: "pointer",
              zIndex: 9999,
              transition: "transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
            }}
            onMouseOver={(e) => e.currentTarget.style.transform = "scale(1.08)"}
            onMouseOut={(e) => e.currentTarget.style.transform = "scale(1)"}
          >
            <span>🛒</span>
            {cartItems.length > 0 && (
              <span style={{
                position: "absolute",
                top: "-2px",
                right: "-2px",
                backgroundColor: "white",
                color: "#E91E63",
                borderRadius: "50%",
                padding: "2px 6px",
                fontSize: "12px",
                fontWeight: 700,
                border: "2px solid #E91E63",
                boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
              }}>
                {totalUnits}
              </span>
            )}
          </button>

          {/* Mobile Cart Drawer Overlay */}
          {isMobileCartOpen && (
            <div 
              className="mobile-cart-drawer"
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0,0,0,0.5)",
                backdropFilter: "blur(4px)",
                zIndex: 10000,
                display: "flex",
                justifyContent: "flex-end",
              }}
              onClick={() => setIsMobileCartOpen(false)}
            >
              <div 
                style={{
                  width: "100%",
                  maxWidth: "400px",
                  height: "100%",
                  backgroundColor: "white",
                  display: "flex",
                  flexDirection: "column",
                  padding: "20px",
                  boxShadow: "-10px 0 25px -5px rgba(0,0,0,0.1)",
                  overflowY: "auto",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                  <h3 style={{ ...styles.sidebarTitle, borderBottom: "none", margin: 0, paddingBottom: 0 }}>Cart Summary</h3>
                  <button 
                    onClick={() => setIsMobileCartOpen(false)}
                    style={{ background: "none", border: "none", fontSize: "24px", cursor: "pointer", color: "#6b7280" }}
                  >
                    ✕
                  </button>
                </div>
                {renderCartContents()}
              </div>
            </div>
          )}

          {/* Column 3: Desktop Cart Sidebar */}
          <aside className="desktop-cart-sidebar" style={styles.cartSidebar}>
            <div style={{ ...styles.card, position: "sticky", top: "20px", maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}>
              <h3 style={styles.sidebarTitle}>Cart Summary</h3>
              {renderCartContents()}
            </div>
          </aside>

        </div>
      </main>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        /* Chrome, Safari, Edge, Opera number input controls removal */
        input::-webkit-outer-spin-button,
        input::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        /* Firefox */
        input[type=number] {
          -moz-appearance: textfield;
        }

        /* Responsive Breakpoints */
        @media (max-width: 1024px) {
          .desktop-cart-sidebar {
            display: none !important;
          }
          .mobile-cart-btn {
            display: flex !important;
          }
          /* Adjust layoutGrid to 2 columns on tablets */
          div[style*="display: grid"] {
            grid-template-columns: 240px 1fr !important;
          }
        }
        @media (min-width: 1025px) {
          .mobile-cart-btn {
            display: none !important;
          }
          .mobile-cart-drawer {
            display: none !important;
          }
        }
        @media (max-width: 768px) {
          /* Full single column layout on phones */
          div[style*="display: grid"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
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
  },
  headerContent: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    maxWidth: "1400px",
    margin: "0 auto",
  },
  breadcrumb: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "14px",
  },
  breadcrumbLink: {
    color: "#4b5563",
    textDecoration: "none",
    fontWeight: 500,
    transition: "color 0.2s",
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
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    fontSize: "14px",
    fontFamily: "'Poppins', sans-serif",
  },
  userName: {
    fontSize: "14px",
    fontWeight: 500,
    color: "#374151",
  },
  mainContent: {
    flex: 1,
    padding: "40px",
    width: "100%",
    maxWidth: "1400px",
    margin: "0 auto",
  },
  pageHeader: {
    marginBottom: "32px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerInfo: {
    display: "flex",
    flexDirection: "column" as const,
  },
  pageTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "28px",
    fontWeight: 700,
    color: "#111827",
    margin: "0 0 4px 0",
    letterSpacing: "-0.02em",
  },
  pageSubtitle: {
    fontSize: "15px",
    color: "#4b5563",
    margin: 0,
  },
  layoutGrid: {
    display: "grid",
    gridTemplateColumns: "250px 1fr 340px",
    gap: "24px",
    alignItems: "start",
  },
  filterSidebar: {
    display: "flex",
    flexDirection: "column" as const,
  },
  productsSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "20px",
  },
  cartSidebar: {
    display: "flex",
    flexDirection: "column" as const,
  },
  card: {
    backgroundColor: "white",
    borderRadius: "16px",
    boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03)",
    border: "1px solid #f3f4f6",
    padding: "20px",
  },
  sidebarTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "16px",
    fontWeight: 600,
    color: "#111827",
    margin: "0 0 16px 0",
    borderBottom: "1px solid #f3f4f6",
    paddingBottom: "10px",
  },
  filterGroup: {
    marginBottom: "16px",
  },
  filterLabel: {
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    color: "#4b5563",
    marginBottom: "6px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  select: {
    width: "100%",
    height: "38px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    backgroundColor: "#ffffff",
    padding: "0 10px",
    fontSize: "14px",
    color: "#374151",
    outline: "none",
  },
  filterActions: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
    marginTop: "20px",
  },
  applyBtn: {
    width: "100%",
    height: "38px",
    backgroundColor: "#E91E63",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
  clearBtn: {
    width: "100%",
    height: "38px",
    backgroundColor: "#f3f4f6",
    color: "#4b5563",
    border: "none",
    borderRadius: "8px",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
  searchBarForm: {
    margin: 0,
  },
  searchContainer: {
    display: "flex",
    gap: "10px",
  },
  searchInput: {
    flex: 1,
    height: "44px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    padding: "0 16px",
    fontSize: "14px",
    outline: "none",
  },
  searchBtn: {
    height: "44px",
    padding: "0 24px",
    backgroundColor: "#111827",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
  },
  productsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "20px",
  },
  productCard: {
    backgroundColor: "white",
    borderRadius: "12px",
    border: "1px solid #eaeaea",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column" as const,
    transition: "transform 0.2s, box-shadow 0.2s",
  },
  imgContainer: {
    height: "180px",
    backgroundColor: "#f9fafb",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderBottom: "1px solid #eaeaea",
  },
  productImage: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain" as const,
  },
  placeholderImg: {
    fontSize: "40px",
  },
  productCardBody: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
  },
  productTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "14px",
    fontWeight: 600,
    color: "#111827",
    margin: "0 0 8px 0",
    minHeight: "40px",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
  },
  skuRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "12px",
    marginBottom: "4px",
  },
  skuLabel: {
    color: "#6b7280",
  },
  skuValue: {
    fontWeight: 500,
    color: "#374151",
  },
  priceRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "13px",
    marginBottom: "12px",
    backgroundColor: "#fff0f4",
    padding: "6px 10px",
    borderRadius: "6px",
  },
  priceLabel: {
    color: "#be185d",
    fontWeight: 500,
  },
  priceValue: {
    fontWeight: 700,
    color: "#E91E63",
  },
  selectorGroup: {
    marginBottom: "12px",
  },
  variantSelect: {
    width: "100%",
    height: "32px",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    fontSize: "12px",
    padding: "0 6px",
  },
  actionRow: {
    display: "flex",
    gap: "8px",
    marginTop: "auto",
  },
  qtyContainer: {
    display: "flex",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    overflow: "hidden",
    height: "34px",
    alignItems: "center",
  },
  qtyBtn: {
    width: "28px",
    height: "100%",
    backgroundColor: "#f3f4f6",
    border: "none",
    fontSize: "16px",
    fontWeight: 600,
    cursor: "pointer",
  },
  qtyInput: {
    width: "32px",
    height: "100%",
    border: "none",
    textAlign: "center" as const,
    fontSize: "13px",
    fontWeight: 600,
    outline: "none",
  },
  addToCartBtn: {
    flex: 1,
    height: "34px",
    backgroundColor: "#E91E63",
    color: "white",
    border: "none",
    borderRadius: "6px",
    fontWeight: 600,
    fontSize: "12px",
    cursor: "pointer",
  },
  cartItemsList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "14px",
    maxHeight: "350px",
    overflowY: "auto" as const,
    paddingRight: "4px",
  },
  cartItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    fontSize: "13px",
  },
  cartItemDetails: {
    flex: 1,
    minWidth: 0,
    paddingRight: "8px",
  },
  cartItemTitle: {
    fontWeight: 600,
    color: "#111827",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cartItemSub: {
    fontSize: "11px",
    color: "#6b7280",
    marginTop: "2px",
  },
  cartItemMeta: {
    fontSize: "11px",
    color: "#9ca3af",
    marginTop: "2px",
  },
  cartItemActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  cartItemQty: {
    display: "flex",
    alignItems: "center",
    border: "1px solid #eaeaea",
    borderRadius: "4px",
    height: "24px",
  },
  cartItemQtyBtn: {
    width: "20px",
    height: "100%",
    border: "none",
    backgroundColor: "#f9fafb",
    cursor: "pointer",
    fontSize: "12px",
  },
  cartItemQtyVal: {
    width: "20px",
    textAlign: "center" as const,
    fontWeight: 600,
    fontSize: "11px",
  },
  cartRemoveBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "14px",
    padding: 0,
  },
  cartDivider: {
    height: "1px",
    backgroundColor: "#f3f4f6",
    margin: "16px 0",
  },
  subtotalRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "14px",
    fontWeight: 600,
    color: "#111827",
    marginBottom: "16px",
  },
  subtotalVal: {
    fontSize: "16px",
    color: "#E91E63",
    fontWeight: 700,
  },
  checkoutBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "42px",
    background: "linear-gradient(90deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    textDecoration: "none",
    borderRadius: "8px",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
  emptyCart: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 0",
    color: "#9ca3af",
    textAlign: "center" as const,
    fontSize: "13px",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "64px",
    backgroundColor: "white",
    borderRadius: "16px",
    border: "1px solid #eaeaea",
    color: "#4b5563",
    textAlign: "center" as const,
  },
  loaderOverlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255, 255, 255, 0.7)",
    backdropFilter: "blur(4px)",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    borderRadius: "16px",
  },
  spinner: {
    width: "40px",
    height: "40px",
    border: "3px solid #f3f4f6",
    borderTop: "3px solid #E91E63",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  loaderText: {
    marginTop: "12px",
    fontSize: "14px",
    fontWeight: 600,
    color: "#E91E63",
    fontFamily: "'Poppins', sans-serif",
  },
};
