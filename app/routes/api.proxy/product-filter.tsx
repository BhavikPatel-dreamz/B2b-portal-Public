import { type LoaderFunctionArgs } from "react-router";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";
import { getStoreByDomain } from "../../services/store.server";
import { apiVersion } from "../../shopify.server";
import { buildFiltersFromEdges, FilterOptions } from "./product-filter.utils";

interface ShopifyVariantNode {
  id: string;
  title: string;
  price: string;
  sku: string;
  inventoryQuantity: number;
  inventoryPolicy: string;
  availableForSale: boolean;
  selectedOptions: {
    name: string;
    value: string;
  }[];
}

interface ShopifyProductNode {
  id: string;
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  totalInventory: number;
  featuredImage?: { url: string };
  variants: {
    edges: {
      node: ShopifyVariantNode;
    }[];
  };
}

interface ShopifyEdge {
  cursor: string;
  node: ShopifyProductNode;
}

type ProductResponse = {
  products: {
    id: string;
    title: string;
    vendor: string;
    productType: string;
    tags: string[];
    image?: string;
    cursor: string;
    totalInventory: number;
    variants: {
      id: string;
      title: string;
      price: string;
      sku: string;
      currencyCode: string;
      currencySymbol: string;
      inventoryQuantity: number;
      inventoryPolicy: string;
      availableForSale: boolean;
      inStock: boolean;
      selectedOptions: {
        name: string;
        value: string;
      }[];
    }[];
  }[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  filters: FilterOptions;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await validateB2BCustomerAccess(request);
  const url = new URL(request.url);

  const search = url.searchParams.get("q")?.trim() || "";
  const vendor = url.searchParams.get("vendor")?.trim();
  const productType = url.searchParams.get("product_type")?.trim();
  const tag = url.searchParams.get("tag")?.trim();
  const color = url.searchParams.get("color")?.trim();
  const size = url.searchParams.get("size")?.trim();
  const minPrice = url.searchParams.get("min_price")?.trim();
  const maxPrice = url.searchParams.get("max_price")?.trim();
  const available = url.searchParams.get("available")?.trim();
  const cursor = url.searchParams.get("cursor");

  const queryFilters = ["status:active", "published_status:published"];

  if (search) {
    queryFilters.push(`title:${search}*`);
  }

  if (vendor) {
    queryFilters.push(`vendor:${vendor}`);
  }

  if (productType) {
    queryFilters.push(`product_type:${productType}`);
  }

  if (tag) {
    queryFilters.push(`tag:${tag}`);
  }

  // Note: Color and size filters are applied after fetching from Shopify
  // as they are stored in variant options and require post-processing

  if (available?.toLowerCase() === "true") {
    queryFilters.push("available:true");
  }

  if (minPrice && !Number.isNaN(Number(minPrice))) {
    queryFilters.push(`price:>=${minPrice}`);
  }

  if (maxPrice && !Number.isNaN(Number(maxPrice))) {
    queryFilters.push(`price:<=${maxPrice}`);
  }

  const shopifySearchQuery = queryFilters.join(" ");

  const store = await getStoreByDomain(shop);
  if (!store || !store.accessToken) {
    throw new Error("Store not found");
  }

  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": store.accessToken,
    },
    body: JSON.stringify({
      query: `
        query productFilterSearch($query: String!, $cursor: String) {
          shop {
            currencyCode
          }
          products(first: 10, after: $cursor, query: $query) {
            edges {
              cursor
              node {
                id
                title
                vendor
                productType
                tags
                totalInventory
                featuredImage {
                  url
                }
                variants(first: 3) {
                  edges {
                    node {
                      id
                      title
                      price
                      sku
                      inventoryQuantity
                      inventoryPolicy
                      availableForSale
                      selectedOptions {
                        name
                        value
                      }
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          filterProducts: products(first: 250, query: $query) {
            edges {
              node {
                vendor
                productType
                tags
                variants(first: 10) {
                  edges {
                    node {
                      price
                      availableForSale
                      selectedOptions {
                        name
                        value
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        query: shopifySearchQuery,
        cursor: cursor || null,
      },
    }),
  });

  if (!response.ok) {
    throw new Error("Shopify API request failed");
  }

  const data = await response.json();

  if (data.errors) {
    console.error("Shopify API Error:", data.errors);
    return { products: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }

  const shopCurrency: string = data.data.shop.currencyCode;
  const currencySymbol = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: shopCurrency,
  })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value || shopCurrency;

  const products: ProductResponse["products"] = data.data.products.edges.map((edge: ShopifyEdge) => ({
    id: edge.node.id,
    title: edge.node.title,
    vendor: edge.node.vendor,
    productType: edge.node.productType,
    tags: edge.node.tags,
    image: edge.node.featuredImage?.url,
    cursor: edge.cursor,
    totalInventory: edge.node.totalInventory,
    variants: edge.node.variants.edges.map(({ node: v }) => ({
      id: v.id,
      title: v.title,
      price: v.price ?? "0",
      sku: v.sku ?? "",
      currencyCode: shopCurrency,
      currencySymbol,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      inventoryPolicy: v.inventoryPolicy,
      availableForSale: v.availableForSale,
      inStock:
        v.availableForSale &&
        (v.inventoryQuantity > 0 || v.inventoryPolicy === "CONTINUE"),
      selectedOptions: v.selectedOptions ?? [],
    })),
  }));

  const filters: FilterOptions = buildFiltersFromEdges(data.data.filterProducts.edges || []);

  // Filter products by color and size if specified
  let filteredProducts: ProductResponse["products"] = products;

  if (color || size) {
    filteredProducts = products
      .map((product) => ({
        ...product,
        variants: product.variants.filter((variant) => {
          let matchesColor = !color;
          let matchesSize = !size;

          variant.selectedOptions?.forEach((option) => {
            if (color && option.name.toLowerCase() === "color" && option.value === color) {
              matchesColor = true;
            }
            if (size && option.name.toLowerCase() === "size" && option.value === size) {
              matchesSize = true;
            }
          });

          return matchesColor && matchesSize;
        }),
      }))
      .filter((product) => product.variants.length > 0);
  }

  const result: ProductResponse = {
    products: filteredProducts,
    pageInfo: data.data.products.pageInfo,
    filters,
  };

  return result;
};
