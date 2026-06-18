import { type LoaderFunctionArgs } from "react-router";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";
import { getStoreByDomain } from "../../services/store.server";
import { apiVersion } from "../../shopify.server";
import {
  buildFiltersFromEdges,
  filterEdgesByCriteria,
  type FilterOptions,
  type FilterCriteria,
} from "./product-filter.utils";

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

  const queryFilters = ["status:active", "published_status:published"];

  if (search) queryFilters.push(`title:${search}*`);
  if (vendor) queryFilters.push(`vendor:${vendor}`);
  if (productType) queryFilters.push(`product_type:${productType}`);
  if (tag) queryFilters.push(`tag:${tag}`);
  if (available?.toLowerCase() === "true") queryFilters.push("available:true");
  if (minPrice && !Number.isNaN(Number(minPrice))) queryFilters.push(`price:>=${minPrice}`);
  if (maxPrice && !Number.isNaN(Number(maxPrice))) queryFilters.push(`price:<=${maxPrice}`);

  const criteria: FilterCriteria = {
    color,
    size,
    minPrice: minPrice && !Number.isNaN(Number(minPrice)) ? Number(minPrice) : null,
    maxPrice: maxPrice && !Number.isNaN(Number(maxPrice)) ? Number(maxPrice) : null,
  };

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
        query getFilters($query: String!) {
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
                      selectedOptions { name value }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: { query: shopifySearchQuery },
    }),
  });

  if (!response.ok) throw new Error("Shopify API request failed");

  const data = await response.json();
  if (data.errors) {
    console.error("Shopify API Error:", data.errors);
    return { filters: {} as FilterOptions };
  }

  const filters: FilterOptions = buildFiltersFromEdges(
    filterEdgesByCriteria(data.data.filterProducts.edges || [], criteria),
  );

  return { filters };
};
