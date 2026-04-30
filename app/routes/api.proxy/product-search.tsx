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

  const query = url.searchParams.get("q")?.trim() || "";
  const cursor = url.searchParams.get("cursor");

  if (!query) {
    return { products: [], pageInfo: { hasNextPage: false } };
  }

  const normalizedQuery = query.toLowerCase();

  const shopifySearchQuery =
    normalizedQuery === "all"
      ? "status:active published_status:published"
      : `status:active published_status:published title:${normalizedQuery}*`;

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
      query searchProducts($query: String!, $cursor: String) {
        shop {
          currencyCode
        }
        products(first: 10, after: $cursor, query: $query) {
          edges {
            cursor
            node {
              id
              title
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
    return { products: [], pageInfo: { hasNextPage: false } };
  }

  const shopCurrency: string = data.data.shop.currencyCode;

  // Extract currency symbol using Intl (e.g., USD -> $, INR -> ₹)
  const currencySymbol = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: shopCurrency,
  })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value || shopCurrency;

  const products = data.data.products.edges.map(
    (edge: ShopifyEdge) => ({
      id: edge.node.id,
      title: edge.node.title,
      image: edge.node.featuredImage?.url,
      cursor: edge.cursor,
      totalInventory: edge.node.totalInventory,
      variants: edge.node.variants.edges.map(({ node: v }) => ({
        id: v.id,
        title: v.title,
        price: v.price ?? "0",
        currencyCode: shopCurrency,
        currencySymbol: currencySymbol,
        inventoryQuantity: v.inventoryQuantity ?? 0,
        inventoryPolicy: v.inventoryPolicy,
        availableForSale: v.availableForSale,
        inStock:
          v.availableForSale &&
          (v.inventoryQuantity > 0 || v.inventoryPolicy === "CONTINUE"),
      })),
    }),
  );

  const result: ProductResponse = {
    products,
    pageInfo: data.data.products.pageInfo,
  };

  return result;
};
