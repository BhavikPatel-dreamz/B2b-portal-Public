import { type LoaderFunctionArgs } from "react-router";
import { authenticate, apiVersion } from "app/shopify.server";
import prisma from "app/db.server";

type SearchVariant = {
  id: string;
  title: string;
  sku: string;
  price: string;
  inventoryQuantity: number;
  inventoryPolicy: string;
  availableForSale: boolean;
};

type SearchProductNode = {
  id: string;
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  totalInventory: number;
  featuredImage: { url: string } | null;
  variants: { edges: Array<{ node: SearchVariant }> };
};

type SearchProductEdge = { cursor: string; node: SearchProductNode };

type SearchPayload = {
  data?: {
    shop?: { currencyCode?: string };
    products?: {
      edges?: SearchProductEdge[];
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || "";

  if (!query) {
    return Response.json({ products: [], pageInfo: { hasNextPage: false, endCursor: null } });
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { shopDomain: true, accessToken: true },
  });

  if (!store || !store.accessToken) {
    return Response.json({ products: [], pageInfo: { hasNextPage: false, endCursor: null } });
  }

  const normalizedQuery = query.toLowerCase();
  const shopifySearchQuery =
    normalizedQuery === "all"
      ? "status:active published_status:published"
      : `status:active published_status:published title:${normalizedQuery}*`;

  const endpoint = `https://${store.shopDomain}/admin/api/${apiVersion}/graphql.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": store.accessToken,
    },
    body: JSON.stringify({
      query: `
        query searchProducts($query: String!) {
          shop {
            currencyCode
          }
          products(first: 20, query: $query) {
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
                variants(first: 10) {
                  edges {
                    node {
                      id
                      title
                      sku
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
      },
    }),
  });

  const payload = (await response.json()) as SearchPayload;

  if (payload.errors?.length) {
    console.error("[admin-product-search] Shopify errors:", payload.errors);
    return Response.json({ products: [], pageInfo: { hasNextPage: false, endCursor: null } });
  }

  const shopCurrencyCode = payload.data?.shop?.currencyCode || "USD";

  const products = (payload.data?.products?.edges || []).map((edge) => {
    const product = edge.node;
    return {
      id: product.id,
      title: product.title,
      vendor: product.vendor || null,
      productType: product.productType || null,
      tags: product.tags || [],
      image: product.featuredImage?.url || null,
      cursor: edge.cursor,
      totalInventory: product.totalInventory,
      currencyCode: shopCurrencyCode,
      variants: (product.variants?.edges || []).map((vEdge) => {
        const v = vEdge.node;
        return {
          id: v.id,
          title: v.title,
          sku: v.sku || "",
          price: v.price,
          currencyCode: shopCurrencyCode,
          inventoryQuantity: v.inventoryQuantity,
          inventoryPolicy: v.inventoryPolicy,
          availableForSale: v.availableForSale,
          inStock: v.inventoryPolicy === "continue" || v.inventoryQuantity > 0,
        };
      }),
    };
  });

  const pageInfo = payload.data?.products?.pageInfo || {
    hasNextPage: false,
    endCursor: null,
  };

  return Response.json({ products, pageInfo });
};
