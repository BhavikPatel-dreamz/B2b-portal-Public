import { type LoaderFunctionArgs } from "react-router";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";
import { getStoreByDomain } from "../../services/store.server";
import { apiVersion } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await validateB2BCustomerAccess(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || "";

  if (!query) {
    return { products: [] };
  }

  const normalizedQuery = query.toLowerCase();
  const shopifySearchQuery =
    normalizedQuery === "all"
      ? "status:active published_status:published"
      : `status:active published_status:published title:*${query}*`;

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
            products(first: 10, after: $cursor, query: $query) {
              edges {
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
            }
          }
        `,
        variables: {
          // When q=all, return all active published products.
          query: shopifySearchQuery,
        },
      }),
    }
  );

  const data = await response.json();

  if (data.errors) {
    console.error("Shopify API Error:", data.errors);
    return { products: [] };
  }

  const products = data.data.products.edges.map((edge: { node: { id: string; title: string; featuredImage?: { url: string }; variants: { edges: { node: { id: string; title: string; price: string } }[] } } } ) => ({
    id: edge.node.id,
    title: edge.node.title,
    image: edge.node.featuredImage?.url,
    variants: edge.node.variants.edges.map((v: { node: { id: string; title: string; price: string } }) => ({
      id: v.node.id,
      title: v.node.title,
      price: v.node.price,
    })),
  }));

  return { products };
};
