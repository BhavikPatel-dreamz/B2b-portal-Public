import { type LoaderFunctionArgs } from "react-router";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";
import { getStoreByDomain } from "../../services/store.server";
import { apiVersion } from "../../shopify.server";

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
      : `status:active published_status:published title:${normalizedQuery}*`; // 👈 optimized (no wildcard both sides)

  const store = await getStoreByDomain(shop);
  if (!store || !store.accessToken) {
    throw new Error("Store not found");
  }

  const response = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": store.accessToken,
      },
      body: JSON.stringify({
        query: `
          query searchProducts($query: String!, $cursor: String) {
            products(first: 30, after: $cursor, query: $query) {
              edges {
                cursor
                node {
                  id
                  title
                  featuredImage {
                    url
                  }
                  variants(first: 10) {  
                    edges {
                      node {
                        id
                        title
                        price
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
    }
  );

  const data = await response.json();

  if (data.errors) {
    console.error("Shopify API Error:", data.errors);
    return { products: [], pageInfo: { hasNextPage: false } };
  }

  const products = data.data.products.edges.map(
    (edge: {
      cursor: string;
      node: {
        id: string;
        title: string;
        featuredImage?: { url: string };
        variants: {
          edges: { node: { id: string; title: string; price: string } }[];
        };
      };
    }) => ({
      id: edge.node.id,
      title: edge.node.title,
      image: edge.node.featuredImage?.url,
      cursor: edge.cursor, 
      variants: edge.node.variants.edges.map((v) => ({
        id: v.node.id,
        title: v.node.title,
        price: v.node.price,
      })),
    })
  );

  return {
    products,
    pageInfo: data.data.products.pageInfo, 
  };
};