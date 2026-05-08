import { type LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/proxy.server";
import { apiVersion } from "../../shopify.server";

/**
 * Recommended Products API
 * Returns a list of recommended products for the B2B customer.
 * Defaults to most ordered (best-selling) products.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { shop, store } = await authenticateApiProxyRequest(request);

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

    // Fetch best selling products as "recommended"
    // We try the "all" collection first as it supports BEST_SELLING sort.
    // If that doesn't exist, we fall back to root products.
    const graphqlQuery = `
      query getRecommendedProducts {
        shop {
          currencyCode
        }
        collectionByHandle(handle: "all") {
          products(first: 10, sortKey: BEST_SELLING) {
            edges {
              node {
                id
                title
                handle
                descriptionHtml
                totalInventory
                featuredImage {
                  url
                  altText
                }
                variants(first: 5) {
                  edges {
                    node {
                      id
                      title
                      price
                      compareAtPrice
                      inventoryQuantity
                      availableForSale
                      sku
                    }
                  }
                }
              }
            }
          }
        }
        fallbackProducts: products(first: 10) {
          edges {
            node {
              id
              title
              handle
              descriptionHtml
              totalInventory
              featuredImage {
                url
                altText
              }
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                    inventoryQuantity
                    availableForSale
                    sku
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": store.accessToken,
      },
      body: JSON.stringify({
        query: graphqlQuery,
      }),
    });

    if (!response.ok) {
      return Response.json(
        { error: "Shopify API request failed" },
        { status: response.status },
      );
    }

    const data = await response.json();

    if (data.errors) {
      console.error("Shopify API Error:", JSON.stringify(data.errors, null, 2));
      return Response.json(
        { error: "Shopify API returned errors", details: data.errors },
        { status: 500 },
      );
    }

    const shopCurrency = data.data.shop?.currencyCode || "USD";
    const currencySymbol =
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: shopCurrency,
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value || shopCurrency;

    // Use products from "all" collection if available, otherwise use fallback products
    const productsData = data.data.collectionByHandle?.products || data.data.fallbackProducts;

    if (!productsData) {
      console.error("Unexpected Shopify API response structure:", JSON.stringify(data, null, 2));
      return Response.json(
        { error: "Unexpected response structure from Shopify", details: data },
        { status: 500 },
      );
    }

    const products = productsData.edges.map((edge: any) => {
      const p = edge.node;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        image: p.featuredImage?.url,
        description: p.descriptionHtml,
        totalInventory: p.totalInventory,
        currencyCode: shopCurrency,
        currencySymbol: currencySymbol,
        variants: p.variants.edges.map((vEdge: any) => {
          const v = vEdge.node;
          return {
            id: v.id,
            title: v.title,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            inventoryQuantity: v.inventoryQuantity,
            availableForSale: v.availableForSale,
            sku: v.sku,
          };
        }),
      };
    });

    return Response.json({
      success: true,
      products,
    });
  } catch (error) {
    console.error("Error in recommended-products loader:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      { status: 500 },
    );
  }
};
