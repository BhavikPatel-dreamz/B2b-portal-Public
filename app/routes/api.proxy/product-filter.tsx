import { type LoaderFunctionArgs } from "react-router";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";
import { getStoreByDomain } from "../../services/store.server";
import { apiVersion } from "../../shopify.server";

interface ShopifyVariantNode {
  id: string;
  title: string;
  price: string;
  inventoryQuantity: number;
  inventoryPolicy: string;
  availableForSale: boolean;
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
      currencyCode: string;
      currencySymbol: string;
      inventoryQuantity: number;
      inventoryPolicy: string;
      availableForSale: boolean;
      inStock: boolean;
    }[];
  }[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await validateB2BCustomerAccess(request);
  const url = new URL(request.url);

  const search = url.searchParams.get("q")?.trim() || "";
  const vendor = url.searchParams.get("vendor")?.trim();
  const productType = url.searchParams.get("product_type")?.trim();
  const tag = url.searchParams.get("tag")?.trim();
  const minPrice = url.searchParams.get("min_price")?.trim();
  const maxPrice = url.searchParams.get("max_price")?.trim();
  const available = url.searchParams.get("available")?.trim();
  const cursor = url.searchParams.get("cursor");

  const filters = ["status:active", "published_status:published"];

  if (search) {
    filters.push(`title:${search}*`);
  }

  if (vendor) {
    filters.push(`vendor:${vendor}`);
  }

  if (productType) {
    filters.push(`product_type:${productType}`);
  }

  if (tag) {
    filters.push(`tag:${tag}`);
  }

  if (available?.toLowerCase() === "true") {
    filters.push("available:true");
  }

  if (minPrice && !Number.isNaN(Number(minPrice))) {
    filters.push(`price:>=${minPrice}`);
  }

  if (maxPrice && !Number.isNaN(Number(maxPrice))) {
    filters.push(`price:<=${maxPrice}`);
  }

  const shopifySearchQuery = filters.join(" ");

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
                      inventoryQuantity
                      inventoryPolicy
                      availableForSale
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

  const products = data.data.products.edges.map((edge: ShopifyEdge) => ({
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
      currencyCode: shopCurrency,
      currencySymbol,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      inventoryPolicy: v.inventoryPolicy,
      availableForSale: v.availableForSale,
      inStock:
        v.availableForSale &&
        (v.inventoryQuantity > 0 || v.inventoryPolicy === "CONTINUE"),
    })),
  }));

  const result: ProductResponse = {
    products,
    pageInfo: data.data.products.pageInfo,
  };

  return result;
};
