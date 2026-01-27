import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Type for GraphQL response
type GraphQLResponse<T = unknown> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

interface ShopifyLocationNode {
  id: string;
  name: string;
  address: {
    address1: string;
    city: string;
    province: string;
    country: string;
  };
  isActive: boolean;
}


/**
 * Get all Shopify locations
 * Fetches all active and inactive locations from the Shopify store
 */
export async function getShopifyLocations(admin: AdminApiContext) {
  const query = `
    query {
      locations(first: 250) {
        edges {
          node {
            id
            name
            address {
              address1
              city
              province
              country
            }
            isActive
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(query);
    const data = await response.json() as GraphQLResponse;

    if (data.errors) {
      console.error('Shopify GraphQL errors:', data.errors);
      return { success: false, error: data.errors[0].message, locations: [] };
    }

    const locations = data.data?.locations?.edges.map((edge: { node: ShopifyLocationNode }) => ({
      id: edge.node.id,
      name: edge.node.name,
      address: edge.node.address,
      isActive: edge.node.isActive
    })) || [];

    return {
      success: true,
      locations
    };
  } catch (error) {
    console.error('Error fetching locations:', error);
    return { success: false, error: 'Failed to fetch locations', locations: [] };
  }
}

