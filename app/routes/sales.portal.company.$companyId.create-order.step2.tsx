import { LoaderFunctionArgs, ActionFunctionArgs, redirect } from "react-router";
import { useLoaderData, Link, useSubmit, useNavigation, useSearchParams } from "react-router";
import { useState, useEffect } from "react";
import prisma from "app/db.server";
import { requireSalesSession, hasCompanyAccess } from "app/utils/sales-session.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const customerId = formData.get("customerId") as string;
  const companyId = params.companyId;

  if (!customerId) {
    return redirect(`/sales/portal/company/${companyId}/create-order`);
  }

  // Redirect to GET request with customerId in searchParams to maintain state on refresh
  return redirect(`/sales/portal/company/${companyId}/create-order/step2?customerId=${customerId}`);
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;

  if (!companyId || !hasCompanyAccess(user, companyId)) {
    return redirect("/sales/dashboard");
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
    return redirect("/sales/dashboard");
  }

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
  let collections: Array<{ id: string; title: string }> = [];
  let products: any[] = [];
  let pageInfo = { hasNextPage: false, endCursor: null };
  let filterOptions = { vendors: [] as string[], productTypes: [] as string[], tags: [] as string[] };

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const shopDomain = company.shop.shopDomain;
    const token = company.shop.accessToken;

    try {
      // Fetch Locations and Collections
      const baseMetaQuery = `
        query GetBaseMeta($companyId: ID!) {
          company(id: $companyId) {
            locations(first: 1) {
              nodes {
                id
                name
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
      locationId = baseMetaData.data?.company?.locations?.nodes?.[0]?.id || "";
      collections = baseMetaData.data?.collections?.nodes || [];

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

      products = productEdges.map((edge: any) => {
        const node = edge.node;
        return {
          id: node.id,
          title: node.title,
          vendor: node.vendor,
          productType: node.productType,
          tags: node.tags || [],
          image: node.featuredImage?.url || "",
          variants: node.variants?.nodes?.map((v: any) => ({
            id: v.id,
            title: v.title,
            sku: v.sku || "",
            barcode: v.barcode || "",
            price: v.contextualPricing?.price?.amount || "0",
            currencyCode: v.contextualPricing?.price?.currencyCode || "USD",
            inventoryQuantity: v.inventoryQuantity || 0,
            availableForSale: v.availableForSale,
            inStock: v.availableForSale && (v.inventoryQuantity > 0 || v.inventoryPolicy === "CONTINUE"),
          })) || []
        };
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

  // Load cart from localStorage
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
  }, [company.id, selectedCustomer.id]);

  const saveCart = (newCart: Record<string, any>) => {
    setCart(newCart);
    const cartKey = `sales_cart_${company.id}_${selectedCustomer.id}`;
    localStorage.setItem(cartKey, JSON.stringify(newCart));
  };

  const isLoading = navigation.state === "loading";

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    applyFilters();
  };

  const applyFilters = () => {
    const params = new URLSearchParams();
    params.set("customerId", selectedCustomer.id);
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
    setUrlParams({ customerId: selectedCustomer.id });
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
    const newCart = { ...cart };
    delete newCart[variantId];
    saveCart(newCart);
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

  const formatCurrency = (val: string | number) =>
    `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div style={styles.container}>
      {/* Top Header Navigation */}
      <header style={styles.header}>
        <div style={styles.headerContent}>
          <div style={styles.breadcrumb}>
            <Link to="/sales/dashboard" style={styles.breadcrumbLink}>Dashboard</Link>
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

          {/* Column 3: Cart Summary */}
          <aside style={styles.cartSidebar}>
            <div style={styles.card}>
              <h3 style={styles.sidebarTitle}>Cart Summary</h3>

              {cartItems.length > 0 ? (
                <>
                  <div style={styles.cartItemsList}>
                    {cartItems.map((item: any) => (
                      <div key={item.variantId} style={styles.cartItem}>
                        <div style={styles.cartItemDetails}>
                          <div style={styles.cartItemTitle}>{item.productTitle}</div>
                          {item.variantTitle !== "Default Title" && (
                            <div style={styles.cartItemSub}>{item.variantTitle}</div>
                          )}
                          <div style={styles.cartItemMeta}>
                            <span>{formatCurrency(item.price)}</span>
                            <span> · </span>
                            <span>SKU: {item.sku || "N/A"}</span>
                          </div>
                        </div>

                        <div style={styles.cartItemActions}>
                          <div style={styles.cartItemQty}>
                            <button 
                              onClick={() => updateCartItemQty(item.variantId, item.quantity - 1)}
                              style={styles.cartItemQtyBtn}
                            >
                              -
                            </button>
                            <span style={styles.cartItemQtyVal}>{item.quantity}</span>
                            <button 
                              onClick={() => updateCartItemQty(item.variantId, item.quantity + 1)}
                              style={styles.cartItemQtyBtn}
                            >
                              +
                            </button>
                          </div>
                          <button 
                            onClick={() => removeFromCart(item.variantId)} 
                            style={styles.cartRemoveBtn}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={styles.cartDivider} />

                  <div style={styles.subtotalRow}>
                    <span>Subtotal:</span>
                    <span style={styles.subtotalVal}>{formatCurrency(cartSubtotal)}</span>
                  </div>

                  <Link 
                    to={`/sales/portal/company/${company.id}/create-order/step3?customerId=${selectedCustomer.id}`}
                    style={styles.checkoutBtn}
                    onClick={(e) => {
                      // Save the cart items to sessionStorage/cookie or query params to pass to Step 3
                      sessionStorage.setItem(`sales_checkout_cart_${company.id}`, JSON.stringify(cartItems));
                    }}
                  >
                    Proceed to Review
                  </Link>
                </>
              ) : (
                <div style={styles.emptyCart}>
                  <span style={{ fontSize: "32px", marginBottom: "8px" }}>🛒</span>
                  <p>Cart is empty. Add products to start building the order.</p>
                </div>
              )}
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
