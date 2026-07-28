import { type LoaderFunctionArgs } from "react-router";
import { requireSalesSession } from "app/utils/sales-session.server";
import prisma from "app/db.server";
import { apiVersion } from "app/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || "";
  const cursor = url.searchParams.get("cursor");
  const companyId = url.searchParams.get("companyId") || "";

  if (!query) {
    return Response.json({ products: [], pageInfo: { hasNextPage: false, endCursor: null } });
  }

  const companyIds = user.salesCompanies.map((sc) => sc.companyId);
  if (!companyIds.length) {
    return Response.json({ products: [], pageInfo: { hasNextPage: false, endCursor: null } });
  }

  let store;
  if (companyId && companyIds.includes(companyId)) {
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      select: { shop: { select: { shopDomain: true, accessToken: true } } },
    });
    store = company?.shop;
  } else {
    const company = await prisma.companyAccount.findFirst({
      where: { id: { in: companyIds } },
      select: { shop: { select: { shopDomain: true, accessToken: true } } },
    });
    store = company?.shop;
  }

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
        query searchProducts($query: String!, $cursor: String) {
          shop {
            currencyCode
          }
          products(first: 20, after: $cursor, query: $query) {
            edges {
              cursor
              node {
                id
                title
                totalInventory
                featuredImage {
                  url
                }
                variants(first: 10) {
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

  const payload = await response.json();

  if (payload.errors?.length) {
    console.error("[sales-product-search] Shopify errors:", payload.errors);
    return Response.json({ products: [], pageInfo: { hasNextPage: false, endCursor: null } });
  }

  const products = (payload.data?.products?.edges || []).map((edge: any) => {
    const product = edge.node;
    return {
      id: product.id,
      title: product.title,
      image: product.featuredImage?.url || null,
      cursor: edge.cursor,
      totalInventory: product.totalInventory,
      variants: (product.variants?.edges || []).map((vEdge: any) => {
        const v = vEdge.node;
        return {
          id: v.id,
          title: v.title,
          price: v.price,
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
