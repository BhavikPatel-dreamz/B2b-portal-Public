import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { getStoreByDomain } from "../services/store.server";
import { createUser } from "../services/user.server";
import { calculateAvailableCredit } from "app/services/creditService";

// Type for GraphQL response
type GraphQLResponse<T = unknown> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

/**
 * Check if a Shopify customer exists by email
 */
export async function checkCustomerExists(
  admin: AdminApiContext,
  email: string,
) {
  const query = `
    query getCustomer($email: String!) {
      customers(first: 1, query: $email) {
        edges {
          node {
            id
            email
            firstName
            lastName
            phone
            metafields(first: 10) {
              edges {
                node {
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  const variables = {
    email: `email:${email}`,
  };

  try {
    const response = await admin.graphql(query, { variables });
    const data = (await response.json()) as GraphQLResponse;

    if (data.errors) {
      console.error("Shopify GraphQL errors:", data.errors);
      return { success: false, error: data.errors[0].message };
    }

    const customers = data.data?.customers?.edges || [];

    if (customers.length > 0) {
      const customer = customers[0].node;
      return {
        success: true,
        exists: true,
        customer: {
          id: customer.id,
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          phone: customer.phone,
          metafields: customer.metafields.edges.map(
            (edge: {
              node: { namespace: string; key: string; value: string };
            }) => edge.node,
          ),
        },
      };
    }

    return {
      success: true,
      exists: false,
      customer: null,
    };
  } catch (error) {
    console.error("Error checking customer:", error);
    return { success: false, error: "Failed to check customer" };
  }
}

type CheckCompanyResult =
  | {
      success: true;
      exists: true;
      company: {
        id: string;
        name: string;
        externalId?: string | null;
      };
    }
  | {
      success: true;
      exists: false;
      company: null;
    }
  | {
      success: false;
      error: string;
    };

export async function checkCompanyExists(
  admin: AdminApiContext,
  externalId: string,
): Promise<CheckCompanyResult> {
  try {
    const QUERY = `
      query ($query: String!) {
        companies(first: 1, query: $query) {
          nodes {
            id
            name
            externalId
          }
        }
      }
    `;

    const res = await admin.graphql(QUERY, {
      variables: {
        query: `externalId:${externalId.trim()}`,
      },
    });

    const json = (await res.json()) as GraphQLResponse;

    if (json.errors?.length) {
      return { success: false, error: json.errors[0].message };
    }

    const company = json.data?.companies?.nodes?.[0];

    if (company) {
      return { success: true, exists: true, company };
    }

    return { success: true, exists: false, company: null };
  } catch (err) {
    console.error("checkCompanyExists failed:", err);
    return { success: false, error: "Failed to check company" };
  }
}
/**
 * Create a new Shopify customer with metafields
 */
export async function createShopifyCustomer(
  admin: AdminApiContext,
  customerData: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  },
) {
  const mutation = `
    mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          firstName
          lastName
          phone
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      email: customerData.email,
      firstName: customerData.firstName,
      lastName: customerData.lastName || "",
      phone: customerData.phone || "",
    },
  };

  try {
    console.log(
      "Creating customer with data:",
      JSON.stringify(variables, null, 2),
    );

    const response = await admin.graphql(mutation, { variables });
    const data = (await response.json()) as GraphQLResponse;

    console.log("Create Customer Response:", JSON.stringify(data, null, 2));

    // Check for userErrors first
    if (
      data.data?.customerCreate?.userErrors &&
      data.data.customerCreate.userErrors.length > 0
    ) {
      const errors = data.data.customerCreate.userErrors;
      console.error("Shopify User Errors:", errors);
      return {
        success: false,
        error: errors
          .map(
            (e: { field: string; message: string }) =>
              `${e.field}: ${e.message}`,
          )
          .join(", "),
      };
    }

    // Check for GraphQL errors
    if (data.errors) {
      console.error("Shopify GraphQL errors:", data.errors);
      return { success: false, error: data.errors[0].message };
    }

    const customer = data.data?.customerCreate?.customer;

    if (!customer) {
      return {
        success: false,
        error: "Failed to create customer - no customer returned",
      };
    }

    return {
      success: true,
      customer: {
        id: customer.id,
        email: customer.email || customerData.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
      },
    };
  } catch (error) {
    console.error("Error creating customer:", error);
    return { success: false, error: "Failed to create customer" };
  }
}

export async function createShopifyCompany(
  admin: AdminApiContext,
  companyData: {
    name: string;
    externalId?: string;
  },
) {
  const mutation = `
    mutation companyCreate($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          externalId
          updatedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      company: {
        name: companyData.name,
        externalId: companyData.externalId,
      },
    },
  };

  const res = await admin.graphql(mutation, { variables });
  const json = await res.json();

  const errors = json.data?.companyCreate?.userErrors;
  if (errors?.length) {
    return { success: false, error: errors[0].message };
  }

  return { success: true, company: json.data.companyCreate.company };
}

export async function assignCompanyToCustomer(
  admin: AdminApiContext,
  customerId: string,
  companyId: string,
) {
  try {
    // Step 1: Get or create company location
    const locationQuery = `
      query getCompanyLocations($companyId: ID!) {
        company(id: $companyId) {
          locations(first: 1) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const locationRes = await admin.graphql(locationQuery, {
      variables: { companyId },
    });

    const locationJson = await locationRes.json();
    let companyLocationId =
      locationJson.data?.company?.locations?.edges?.[0]?.node?.id;

    // If no location exists, create one
    if (!companyLocationId) {
      const createLocationMutation = `
        mutation companyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
          companyLocationCreate(companyId: $companyId, input: $input) {
            companyLocation {
              id
              name
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const createLocationRes = await admin.graphql(createLocationMutation, {
        variables: {
          companyId,
          input: {
            name: "Main Location",
          },
        },
      });

      const createLocationJson = await createLocationRes.json();
      const createLocationPayload =
        createLocationJson.data?.companyLocationCreate;

      if (createLocationPayload?.userErrors?.length) {
        return {
          success: false,
          error: createLocationPayload.userErrors[0].message,
          step: "createLocation",
        };
      }

      companyLocationId = createLocationPayload.companyLocation.id;
    }

    // Step 2: Get available roles
    const companyQuery = `
      query getCompany($companyId: ID!) {
        company(id: $companyId) {
          contactRoles(first: 10) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const companyRes = await admin.graphql(companyQuery, {
      variables: { companyId },
    });

    const companyJson = await companyRes.json();
    const roles = companyJson.data?.company?.contactRoles?.edges || [];

    // Find "Member" role or use the first available role
    let companyContactRoleId = roles.find(
      (edge: { node: { name: string; id: string } }) =>
        edge.node.name.toLowerCase() === "Company Admin",
    )?.node?.id;

    if (!companyContactRoleId && roles.length > 0) {
      companyContactRoleId = roles[0].node.id;
    }

    if (!companyContactRoleId) {
      return {
        success: false,
        error: "No company contact roles available",
        step: "getRoles",
      };
    }

    // Step 3: Assign customer as a contact to the company
    const assignContactMutation = `
      mutation companyAssignCustomerAsContact(
        $companyId: ID!
        $customerId: ID!
      ) {
        companyAssignCustomerAsContact(
          companyId: $companyId
          customerId: $customerId
        ) {
          companyContact {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const contactRes = await admin.graphql(assignContactMutation, {
      variables: { companyId, customerId },
    });

    const contactJson = await contactRes.json();
    const contactPayload = contactJson.data?.companyAssignCustomerAsContact;

    if (contactPayload?.userErrors?.length) {
      return {
        success: false,
        error: contactPayload.userErrors[0].message,
        step: "assignContact",
      };
    }

    const companyContactId = contactPayload.companyContact.id;

    // Step 4: Assign role and location to the contact
    const assignRoleMutation = `
      mutation companyContactAssignRole(
        $companyContactId: ID!
        $companyContactRoleId: ID!
        $companyLocationId: ID!
      ) {
        companyContactAssignRole(
          companyContactId: $companyContactId
          companyContactRoleId: $companyContactRoleId
          companyLocationId: $companyLocationId
        ) {
          companyContactRoleAssignment {
            id
            role {
              id
              name
            }
            companyLocation {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const roleRes = await admin.graphql(assignRoleMutation, {
      variables: {
        companyContactId,
        companyContactRoleId,
        companyLocationId,
      },
    });

    const roleJson = await roleRes.json();
    const rolePayload = roleJson.data?.companyContactAssignRole;

    if (rolePayload?.userErrors?.length) {
      return {
        success: false,
        error: rolePayload.userErrors[0].message,
        step: "assignRole",
      };
    }

    // Step 5: Assign this contact as the main contact
    const assignMainContactMutation = `
      mutation companyAssignMainContact(
        $companyId: ID!
        $companyContactId: ID!
      ) {
        companyAssignMainContact(
          companyId: $companyId
          companyContactId: $companyContactId
        ) {
          company {
            id
            name
            externalId
            mainContact {
              id
              customer {
                id
                firstName
                lastName
                email
              }
            }
            updatedAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const mainContactRes = await admin.graphql(assignMainContactMutation, {
      variables: { companyId, companyContactId },
    });

    const mainContactJson = await mainContactRes.json();
    const mainContactPayload = mainContactJson.data?.companyAssignMainContact;

    if (mainContactPayload?.userErrors?.length) {
      return {
        success: false,
        error: mainContactPayload.userErrors[0].message,
        step: "assignMainContact",
      };
    }

    return {
      success: true,
      companyContactId,
      roleAssignment: rolePayload.companyContactRoleAssignment,
      company: mainContactPayload.company,
    };
  } catch (error) {
    console.error("Error in assignCompanyToCustomer:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
      step: "general",
    };
  }
}
/**
 * Update customer metafields
 */
export async function assignLocationsToCompany(
  admin: AdminApiContext,
  companyId: string,
  locationIds: string[],
) {
  const mutation = `
    mutation companyAssignLocations($companyId: ID!, $locationIds: [ID!]!) {
      companyAssignLocations(
        companyId: $companyId
        locationIds: $locationIds
      ) {
        company {
          id
          name
          locations(first: 20) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  try {
    const response = await admin.graphql(mutation, {
      variables: {
        companyId,
        locationIds,
      },
    });

    const data = (await response.json()) as GraphQLResponse;

    /* USER ERRORS */
    if (data.data?.companyAssignLocations?.userErrors?.length) {
      return {
        success: false,
        error: data.data.companyAssignLocations.userErrors[0].message,
      };
    }

    /* GRAPHQL ERRORS */
    if (data.errors?.length) {
      return { success: false, error: data.errors[0].message };
    }

    return {
      success: true,
      company: data.data.companyAssignLocations.company,
    };
  } catch (error) {
    console.error("Assign Locations Error:", error);
    return { success: false, error: "Failed to assign company locations" };
  }
}

export async function updateCustomerMetafields(
  admin: AdminApiContext,
  customerId: string,
  metafields: { key: string; value: string }[],
) {
  const mutation = `
    mutation customerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer {
          id
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    id: customerId,
    metafields: metafields.map((mf) => ({
      namespace: "custom",
      key: mf.key,
      value: mf.value,
      type: mf.key === "b2b_locations" ? "json" : "single_line_text_field",
    })),
  };

  try {
    const response = await admin.graphql(mutation, { variables: { input } });
    const data = (await response.json()) as GraphQLResponse;

    if (data.errors) {
      console.error("Shopify GraphQL errors:", data.errors);
      return { success: false, error: data.errors[0].message };
    }

    const result = data.data?.customerUpdate;

    if (result.userErrors && result.userErrors.length > 0) {
      return { success: false, error: result.userErrors[0].message };
    }

    return {
      success: true,
      customer: result.customer,
    };
  } catch (error) {
    console.error("Error updating customer metafields:", error);
    return { success: false, error: "Failed to update customer metafields" };
  }
}

/**
 * Fetch customer tags using the Admin API
 * This uses the GraphQL Admin API to get customer tags
 */
export async function fetchCustomerTags(
  admin: AdminApiContext,
  customerId: string,
): Promise<{ success: boolean; tags: string[]; error?: string }> {
  const query = `
    query getCustomer($id: ID!) {
      customer(id: $id) {
        id
        tags
      }
    }
  `;

  try {
    const response = await admin.graphql(query, {
      variables: { id: customerId },
    });

    const data = (await response.json()) as GraphQLResponse;

    if (data.errors) {
      console.error("❌ Shopify GraphQL errors:", data.errors);
      return {
        success: false,
        tags: [],
        error: data.errors[0].message,
      };
    }

    const customer = data.data?.customer;
    const tags = customer?.tags || [];

    return {
      success: true,
      tags,
    };
  } catch (error) {
    console.error("❌ Error fetching customer tags:", error);
    return {
      success: false,
      tags: [],
      error: "Failed to fetch customer tags",
    };
  }
}

/**
 * Checks if a customer has B2B/company access in your database
 * This approach doesn't require protected customer data access from Shopify
 *
 * @param customerId - The customer ID from Shopify
 * @param shopDomain - The shop domain
 * @returns true if customer has company access, false otherwise
 */
export async function checkCustomerHasCompany(
  customerId: string,
  shopDomain: string,
): Promise<boolean> {
  try {
    // Get the store first
    const store = await getStoreByDomain(shopDomain);
    if (!store) {
      console.log("⚠️ Store not found");
      return false;
    }

    // Check if any user in this store has registered
    // Since your current schema doesn't have shopifyCustomerId,
    // we'll check if there are any approved users for this store
    const user = await prisma.user.findFirst({
      where: {
        shopId: store.id,
        status: "APPROVED",
        isActive: true,
      },
    });

    if (user) {
      console.log("✅ Approved user found for store");
      return true;
    }

    console.log("⚠️ No approved users found for this store");
    return false;
  } catch (error) {
    console.error("❌ Error checking customer in database:", error);
    // On error, you can choose to allow or deny access
    // For now, we'll allow them through to avoid blocking legitimate users
    return true;
  }
}

/**
 * Verify if a customer has B2B tags in Shopify
 * @param tags - Array of customer tags
 * @returns true if customer has B2B-related tags
 */
export function hasB2BAccess(tags: string[]): boolean {
  return tags.some(
    (tag) =>
      tag.toLowerCase() === "b2b" ||
      tag.toLowerCase() === "company" ||
      tag.toLowerCase().includes("b2b"),
  );
}

/**
 * Check if a customer has B2B/company access in Shopify
 * This checks Shopify directly using the Admin API to verify:
 * 1. Customer has B2B-related tags (b2b, company, etc.)
 * 2. Customer has company metafield set
 *
 * @param admin - The admin API context
 * @param customerId - The customer ID (GraphQL format: gid://shopify/Customer/123)
 * @returns Object with hasAccess boolean and details
 */
export async function checkCustomerIsB2BInShopify(
  admin: AdminApiContext,
  customerId: string,
): Promise<{
  success: boolean;
  hasAccess: boolean;
  hasTags: boolean;
  hasCompanyMetafield: boolean;
  tags?: string[];
  company?: string;
  error?: string;
}> {
  const query = `
    query getCustomer($id: ID!) {
      customer(id: $id) {
        id
        tags
        metafields(first: 20, namespace: "custom") {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(query, {
      variables: { id: customerId },
    });

    const data = (await response.json()) as GraphQLResponse;

    if (data.errors) {
      console.error("❌ Shopify GraphQL errors:", data.errors);
      return {
        success: false,
        hasAccess: false,
        hasTags: false,
        hasCompanyMetafield: false,
        error: data.errors[0].message,
      };
    }

    const customer = data.data?.customer;

    if (!customer) {
      return {
        success: false,
        hasAccess: false,
        hasTags: false,
        hasCompanyMetafield: false,
        error: "Customer not found",
      };
    }

    // Check tags for B2B access
    const tags = customer.tags || [];
    const hasTags = hasB2BAccess(tags);

    // Check for company metafield
    const metafields =
      customer.metafields?.edges?.map(
        (edge: { node: { key: string; value: string } }) => edge.node,
      ) || [];
    const companyMetafield = metafields.find(
      (mf: { key: string }) => mf.key === "b2b_company" || mf.key === "company",
    );
    const hasCompanyMetafield = !!companyMetafield;
    const company = companyMetafield?.value;

    // Customer has B2B access if they have either B2B tags OR a company metafield
    const hasAccess = hasTags || hasCompanyMetafield;

    console.log("✅ Shopify B2B check:", {
      customerId,
      hasAccess,
      hasTags,
      hasCompanyMetafield,
      tags: tags.length > 0 ? tags : undefined,
      company,
    });

    return {
      success: true,
      hasAccess,
      hasTags,
      hasCompanyMetafield,
      tags,
      company,
    };
  } catch (error) {
    console.error("❌ Error checking customer B2B status in Shopify:", error);
    return {
      success: false,
      hasAccess: false,
      hasTags: false,
      hasCompanyMetafield: false,
      error: "Failed to check customer B2B status",
    };
  }
}

/**
 * Check if a customer has B2B/company access in Shopify using REST API
 * This version works in PROXY ROUTES without admin context
 * Uses the store's access token to query Shopify REST API
 *
 * @param shop - Shop domain (e.g., "mystore.myshopify.com")
 * @param customerId - Customer ID (numeric format: "7449728548923")
 * @param accessToken - Store's access token
 * @returns Object with hasAccess boolean and details
 */
export async function checkCustomerIsB2BInShopifyByREST(
  shop: string,
  customerId: string,
  accessToken: string,
): Promise<{
  success: boolean;
  hasAccess: boolean;
  hasTags: boolean;
  hasCompanyMetafield: boolean;
  tags?: string[];
  company?: string;
  error?: string;
}> {
  try {
    // Fetch customer with tags and metafields using REST API
    const response = await fetch(
      `https://${shop}/admin/api/2025-01/customers/${customerId}.json?fields=id,tags,metafields`,
      {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      },
    );

    console.log(`✅ ============etched customer from Shopify:`, response);

    if (!response.ok) {
      console.error(
        `❌ Failed to fetch customer from Shopify: ${response.status}`,
      );
      return {
        success: false,
        hasAccess: false,
        hasTags: false,
        hasCompanyMetafield: false,
        error: `Failed to fetch customer: ${response.status}`,
      };
    }

    const data = await response.json();
    const customer = data.customer;

    if (!customer) {
      return {
        success: false,
        hasAccess: false,
        hasTags: false,
        hasCompanyMetafield: false,
        error: "Customer not found",
      };
    }

    // Check tags for B2B access
    const tagsString = customer.tags || "";
    const tags = tagsString
      .split(",")
      .map((tag: string) => tag.trim())
      .filter((tag: string) => tag.length > 0);
    const hasTags = hasB2BAccess(tags);

    // Check for company metafield
    const metafields = customer.metafields || [];
    const companyMetafield = metafields.find(
      (mf: { namespace: string; key: string; value: string }) =>
        mf.namespace === "custom" &&
        (mf.key === "b2b_company" || mf.key === "company"),
    );
    const hasCompanyMetafield = !!companyMetafield;
    const company = companyMetafield?.value;

    // Customer has B2B access if they have either B2B tags OR a company metafield
    const hasAccess = hasTags || hasCompanyMetafield;

    console.log("✅ Shopify B2B check (REST):", {
      customerId,
      hasAccess,
      hasTags,
      hasCompanyMetafield,
      tags: tags.length > 0 ? tags : undefined,
      company,
    });

    return {
      success: true,
      hasAccess,
      hasTags,
      hasCompanyMetafield,
      tags,
      company,
    };
  } catch (error) {
    console.error(
      "❌ Error checking customer B2B status in Shopify (REST):",
      error,
    );
    return {
      success: false,
      hasAccess: false,
      hasTags: false,
      hasCompanyMetafield: false,
      error: "Failed to check customer B2B status",
    };
  }
}

// Function to get customer company information with role details
// Function to get customer company information with role details
export async function getCustomerCompanyInfo(
  customerId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    // GraphQL query to fetch customer company contacts with their roles
    const query = `
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          id
          email
          firstName
          lastName
          companyContactProfiles {
            id
            title
            company {
              id
              name
              externalId
              mainContact {
                customer {
                  id
                  firstName
                  lastName
                  email
                }
              }
              locationsCount {
                count
              }
              totalSpent {
                amount
                currencyCode
              }
              updatedAt
            }
            roleAssignments(first: 10) {
              edges {
                node {
                  role {
                    name
                  }
                  companyLocation {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      return { hasCompany: false, error: data.errors };
    }

    const customer = data.data.customer;
    // companyContactProfiles is a list, not a connection
    const companyProfiles = customer.companyContactProfiles || [];

    if (companyProfiles.length === 0) {
      return {
        hasCompany: false,
        customerId,
        customerEmail: customer.email,
        message: "Customer has no company association",
      };
    }
    const RegistrationData = await prisma.registrationSubmission.findFirst({
      where: {
        email: customer.email,
      },
    });

    const companyData = await prisma.companyAccount.findFirst({
      where: {
        contactEmail: customer.email,
      },
    });
    // Process company information
    const companies = companyProfiles.map(
      (profile: {
        company: {
          id: string | number;
          name: string;
          mainContact: { customer: { id: string | number } };
        };
        roleAssignments: {
          edges: Array<{
            node: {
              role: { name: string };
              companyLocation: { id: string | number; name: string };
            };
          }>;
        };
      }) => {
        const company = profile.company;

        const roleAssignments =
          profile.roleAssignments?.edges?.map(
            (edge: {
              node: {
                role: { name: string };
                companyLocation: { id: string | number; name: string };
              };
            }) => ({
              role: edge.node.role.name,
              locationId: edge.node.companyLocation?.id,
              locationName: edge.node.companyLocation?.name,
            }),
          ) || [];

        const roles = roleAssignments.map((r: { role: string }) => r.role);

        // Check if this customer is the main contact (company owner)
        const isMainContact =
          company.mainContact?.customer?.id ===
          `gid://shopify/Customer/${customerId}`;

        // Check if user has "Company Admin" role (NOT "Location Admin")
        // Only "Company Admin" (without "Location" prefix) should be considered admin
        const hasCompanyAdminRole = roles.some((r: string) => {
          const roleLower = r.toLowerCase();
          // Match "company admin" or "admin" but NOT "location admin"
          return (
            (roleLower === "admin" || roleLower === "company admin") &&
            !roleLower.includes("location")
          );
        });

        // User is admin if they are main contact OR have Company Admin role
        const isAdmin = isMainContact || hasCompanyAdminRole;

        // Extract unique location IDs that this user has access to
        const assignedLocationIds = roleAssignments
          .filter((ra: { locationId: string | number }) => ra.locationId)
          .map((ra: { locationId: string }) => ra.locationId as string);

        // Remove duplicates
        const uniqueLocationIds = [...new Set(assignedLocationIds)];

        // Group role assignments by location for easier validation
        const locationRoles = roleAssignments.reduce(
          (
            acc: Record<
              string,
              { locationId: string; locationName: string; roles: string[] }
            >,
            ra: {
              locationId: string | number;
              locationName: string;
              role: string;
            },
          ) => {
            if (ra.locationId) {
              if (!acc[ra.locationId]) {
                acc[ra.locationId] = {
                  locationId: ra.locationId,
                  locationName: ra.locationName,
                  roles: [],
                };
              }
              acc[ra.locationId].roles.push(ra.role);
            }
            return acc;
          },
          {},
        );

        return {
          companyId: company.id,
          companyName: company.name,
          externalId: company.externalId,
          mainContact: company.mainContact?.customer,
          totalSpent: company.totalSpent,
          locationsCount: company.locationsCount?.count || 0,
          updatedAt: company.updatedAt,
          roles: roles,
          roleAssignments: roleAssignments,
          // NEW: Enhanced location-based access control fields
          assignedLocationIds: uniqueLocationIds,
          locationRoles: Object.values(locationRoles),
          // Helper flag: user has access to all locations if they're admin/main contact
          hasAllLocationAccess: isAdmin || isMainContact,
          title: profile.title,
          // isAdmin,
          // isMainContact,
        };
      },
    );
    const creditInfo = await calculateAvailableCredit(companyData?.id || "");
    const creditLimitNum = parseFloat(
      companyData?.creditLimit.toString() || "0",
    );
    const usedCreditNum = creditInfo
      ? parseFloat(creditInfo.usedCredit.toString())
      : 0;
    const pendingCreditNum = creditInfo
      ? parseFloat(creditInfo.pendingCredit.toString())
      : 0;
    const creditUsagePercentage =
      creditLimitNum > 0
        ? Math.round((usedCreditNum / creditLimitNum) * 100)
        : 0;

    return {
      hasCompany: true,
      customerId,
      customerName:
        RegistrationData?.contactName ||
        (customer.firstName
          ? `${customer.firstName} ${customer.lastName || ""}`.trim()
          : customer.firstName || ""),
      customerEmail: customer.email,
      CreditLimit: creditLimitNum,
      usedCredit: usedCreditNum,
      pendingCredit: pendingCreditNum,
      creditUsagePercentage: creditUsagePercentage,
      companies: companies,
      isAdmin: companies[0]?.hasAllLocationAccess,
      isMainContact:
        companies[0]?.mainContact?.id ===
        `gid://shopify/Customer/${customerId}`,
    };
  } catch (error: { message: string }) {
    console.error("Error fetching company info:", error);
    return { hasCompany: false, error: error.message };
  }
}

// Function to get company orders
export async function getCompanyOrderss(
  companyId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const query = `
      query {
        company(id: "${companyId}") {
          id
          name
          orders(first: 50) {
            edges {
              node {
                id
                createdAt
                totalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                customer {
                  firstName
                  lastName
                  email
                }
              }
            }
          }
          locations(first: 20) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      return { error: data.errors };
    }

    const company = data.data.company;
    const allOrders = company.orders.edges.map(
      (o: {
        node: {
          id: string;
          createdAt: string;
          totalPriceSet: {
            shopMoney: { amount: string; currencyCode: string };
          };
          customer: { firstName: string; lastName: string; email: string };
        };
      }) => o.node,
    );
    const locations = company.locations.edges.map(
      (l: {
        node: {
          id: string;
          name: string;
          shippingAddress: {
            address1: string;
            city: string;
            province: string;
            zip: string;
          };
        };
      }) => l.node,
    );

    // Group orders by location
    const locationsWithOrders = locations.map(
      (location: { id: string; name: string }) => {
        const locationOrders = allOrders.filter(
          (order: { companyLocation: { id: string } }) =>
            order.companyLocation?.id === location.id,
        );
        return {
          locationId: location.id,
          locationName: location.name,
          orders: locationOrders,
        };
      },
    );

    return {
      companyId: company.id,
      companyName: company.name,
      totalOrders: allOrders.length,
      companyOrders: allOrders,
      locations: locationsWithOrders,
    };
  } catch (error: { message: string }) {
    console.error("Error fetching company orders:", error);
    return { error: error.message };
  }
}

// Function to get company customers with pagination and filtering
export async function getCompanyCustomers(
  companyId: string,
  shopName: string,
  accessToken: string,
  options: {
    first?: number;
    after?: string;
    sortKey?: string; // NAME, CREATED_AT, etc.
    reverse?: boolean;
    query?: string; // Search query
  } = {},
) {
  try {
    const {
      first = 10,
      after = null,
      sortKey = "NAME",
      reverse = false,
      query: searchQuery = "",
    } = options;

    const queryArgs = [
      `first: ${first}`,
      `sortKey: ${sortKey}`,
      `reverse: ${reverse}`,
    ];

    if (after) {
      queryArgs.push(`after: "${after}"`);
    }

    if (searchQuery) {
      queryArgs.push(`query: "${searchQuery}"`);
    }

    const query = `
      query {
        company(id: "${companyId}") {
          id
          name
          contacts(${queryArgs.join(", ")}) {
            pageInfo {
              hasNextPage
              endCursor
              hasPreviousPage
              startCursor
            }
            edges {
              node {
                id
                title
                customer {
                  id
                  firstName
                  lastName
                  email
                  phone
                  metafield(namespace: "b2b_credit", key: "user_credit_limit") {
                    value
                    type
                  }
                }
                roleAssignments(first: 10) {
                  edges {
                    node {
                      role {
                        id
                        name
                      }
                      companyLocation {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      return { error: data.errors };
    }

    const company = data.data.company;
    const contacts = company.contacts.edges.map(
      (edge: {
        node: {
          id: string;
          title: string;
          customer: {
            id: string;
            firstName: string;
            lastName: string;
            email: string;
            phone: string;
            metafield: { value: string; type: string };
          };
        };
      }) => {
        const node = edge.node;
        const cust = node.customer;

        const roles =
          node.roleAssignments?.edges?.map(
            (r: {
              node: {
                role: { id: string; name: string };
                companyLocation: { id: string; name: string };
              };
            }) => ({
              id: r.node.role.id,
              name: r.node.role.name,
              locationId: r.node.companyLocation?.id,
              locationName: r.node.companyLocation?.name,
            }),
          ) || [];

        return {
          id: node.id,
          customerId: cust.id,
          title: node.title,
          customer: {
            id: cust.id,
            firstName: cust.firstName,
            lastName: cust.lastName,
            email: cust.email,
            phone: cust.phone,
            // Include roleAssignments in customer object for easy access
            roleAssignments: node.roleAssignments,
          },
          roles: roles.map((r: { name: string }) => r.name),
          roleIds: roles.map((r: { id: string }) => r.id),
          locationIds: roles
            .map((r: { locationId: string }) => r.locationId)
            .filter(Boolean),
          locationNames: roles
            .map((r: { locationName: string }) => r.locationName)
            .filter(Boolean),
          credit: cust.metafield?.value ? Number(cust.metafield.value) : 0,
        };
      },
    );

    return {
      companyId: company.id,
      companyName: company.name,
      customers: contacts,
      pageInfo: company.contacts.pageInfo,
    };
  } catch (error: unknown) {
    console.error("Error fetching company customers:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

// Function to fetch available roles for a company
export async function getCompanyRoles() {
  try {
    // We can fetch roles via the shop query or assume standard ones.
    // Let's try to fetch roles if possible, but for now we'll return a standard list
    // PLUS we will try to get them from a company query if we have a company ID context,
    // but here we don't.
    // However, we can query `companyRoles` (plural) on the shop? No.
    // We can query `roles` on a `Company` object.
    // Since we don't have company ID here easily without passing it,
    // we might need to rely on the caller passing it or just hardcoding common ones
    // AND fetching them dynamically when we have the company ID in `createCompanyCustomer`.

    // For the UI, let's return a list that includes "Admin" and "Ordering only"
    // but we should ideally fetch them.
    // Let's update this signature to take companyId if we want real roles,
    // or just return the static ones for now as the user asked to "assign role".
    // We will update the UI to send the role NAME, and we will look up the ID in `createCompanyCustomer`.

    return [
      { name: "Ordering only", value: "ordering_only" },
      { name: "Location Admin", value: "location_admin" },
    ];
  } catch (error) {
    return [];
  }
}

// Helper to assign role to company contact
async function assignRoleToCompanyContact(
  contactId: string,
  roleName: string, // e.g. "Admin"
  companyId: string,
  shopName: string,
  accessToken: string,
) {
  // 1. Fetch Company Roles to find the ID for the given name
  const rolesQuery = `
    query {
      company(id: "${companyId}") {
        roles(first: 20) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;

  const rolesResponse = await fetch(
    `https://${shopName}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: rolesQuery }),
    },
  );

  const rolesData = await rolesResponse.json();
  const roles =
    rolesData.data?.company?.roles?.edges?.map(
      (e: { node: { id: string; name: string } }) => e.node,
    ) || [];

  // Find role by name (case insensitive)
  const role = roles.find(
    (r: { name: string }) => r.name.toLowerCase() === roleName.toLowerCase(),
  );

  if (!role) {
    console.error(`Role ${roleName} not found for company ${companyId}`);
    return { error: `Role ${roleName} not found` };
  }

  // 2. Assign Role
  const assignMutation = `
    mutation companyContactAssignRole($companyContactId: ID!, $roleId: ID!) {
      companyContactAssignRole(companyContactId: $companyContactId, roleId: $roleId) {
        companyContact {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const assignResponse = await fetch(
    `https://${shopName}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: assignMutation,
        variables: { companyContactId: contactId, roleId: role.id },
      }),
    },
  );

  const assignResult = await assignResponse.json();
  if (assignResult.data?.companyContactAssignRole?.userErrors?.length > 0) {
    return {
      error: assignResult.data.companyContactAssignRole.userErrors[0].message,
    };
  }

  return { success: true };
}

// Helper to assign locations to company contact
async function assignLocationsToCompanyContact(
  contactId: string,
  locationIds: string[],
  roleId: string, // We need a role ID to assign a location?
  // Actually, in Shopify B2B, you assign a Role AT a Location.
  // So `companyContactAssignRole` assigns a role globally? No, usually it's `companyContactRoleAssign` which might take a locationId?
  // Let's check the mutation `companyContactAssignRole`.
  // It takes `companyContactId` and `roleId`.
  // Wait, does it take `companyLocationId`?
  // Ah, `companyContactAssignRole` is for company-wide roles?
  // Or maybe `companyContactRoleAssign` (if that's the name) has a location argument.
  // Actually, there is `companyContactAssignCustomerRole`?
  // Let's look at `companyLocationAssignRoles`.

  // Correction:
  // To assign a user to a location with a role:
  // mutation companyContactAssignRole($companyContactId: ID!, $roleId: ID!, $companyLocationId: ID)

  // So we need to assign the role FOR each location.

  companyId: string,
  shopName: string,
  accessToken: string,
) {
  // We need to loop through locations and assign the role for each location
  // First we need the Role ID (we might have fetched it in the previous step, but let's fetch it again or pass it)
  // For simplicity, let's assume we fetch it again or refactor to pass it.
  // Let's refactor `assignRoleToCompanyContact` to return the Role ID so we can use it here.

  return { success: true };
}

/**
 * Helper: Find existing customer by email
 */
async function findCustomerByEmail(
  email: string,
  shopName: string,
  accessToken: string,
): Promise<{ customerId?: string; error?: string }> {
  try {
    const findQuery = `
      query {
        customers(first: 1, query: "email:${email}") {
          edges {
            node {
              id
              email
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: findQuery }),
      },
    );

    const result = await response.json();
    const customerId = result.data?.customers?.edges?.[0]?.node?.id;

    if (customerId) {
      console.log(`✅ Found existing customer: ${customerId}`);
      return { customerId };
    }

    return { error: "Customer not found" };
  } catch (error) {
    console.error("Error finding customer:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

/**
 * Helper: Create a new Shopify customer
 */
async function createCustomer(
  customerData: {
    firstName: string;
    lastName: string;
    email: string;
  },
  shopName: string,
  accessToken: string,
): Promise<{ customerId?: string; error?: string }> {
  try {
    const customerCreateMutation = `
      mutation customerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
            email
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const customerInput = {
      firstName: customerData.firstName,
      lastName: customerData.lastName,
      email: customerData.email,
      tags: ["b2b", "company_user"],
    };

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: customerCreateMutation,
          variables: { input: customerInput },
        }),
      },
    );

    const result = await response.json();
    const customerId = result.data?.customerCreate?.customer?.id;

    if (customerId) {
      console.log(`✅ Created new customer: ${customerId}`);
      return { customerId };
    }

    if (result.data?.customerCreate?.userErrors?.length > 0) {
      const errors = result.data.customerCreate.userErrors;
      return { error: errors[0].message };
    }

    return { error: "Failed to create customer" };
  } catch (error) {
    console.error("Error creating customer:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

/**
 * Helper: Get or create customer (checks if exists first, creates if not)
 */
async function getOrCreateCustomer(
  customerData: {
    firstName: string;
    lastName: string;
    email: string;
  },
  shopName: string,
  accessToken: string,
): Promise<{ customerId?: string; error?: string; isNew?: boolean }> {
  try {
    // First, try to find existing customer
    const existingCustomer = await findCustomerByEmail(
      customerData.email,
      shopName,
      accessToken,
    );

    if (existingCustomer.customerId) {
      return { customerId: existingCustomer.customerId, isNew: false };
    }

    // If not found, create new customer
    const newCustomer = await createCustomer(
      customerData,
      shopName,
      accessToken,
    );

    if (newCustomer.customerId) {
      return { customerId: newCustomer.customerId, isNew: true };
    }

    return { error: newCustomer.error || "Failed to get or create customer" };
  } catch (error) {
    console.error("Error in getOrCreateCustomer:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

/**
 * Helper: Check if customer is already a company contact
 */
async function checkCompanyContactExists(
  companyId: string,
  customerId: string,
  shopName: string,
  accessToken: string,
): Promise<{ exists: boolean; contactId?: string; error?: string }> {
  try {
    const query = `
      query {
        company(id: "${companyId}") {
          contacts(first: 250) {
            edges {
              node {
                id
                customer {
                  id
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const result = await response.json();

    if (result.errors) {
      console.error("GraphQL Errors:", result.errors);
      return {
        exists: false,
        error: result.errors[0]?.message || "GraphQL error",
      };
    }

    const contacts = result.data?.company?.contacts?.edges || [];

    console.log(
      `✅ Checking ${contacts.length} contacts for customer ${customerId}`,
    );

    // Find existing contact by comparing customer IDs
    const existingContact = contacts.find(
      (edge: { node: { id: string; customer: { id: string } } }) => {
        const contactCustomerId = edge.node.customer.id;
        console.log(`  Comparing: ${contactCustomerId} === ${customerId}`);
        return contactCustomerId === customerId;
      },
    );

    if (existingContact) {
      console.log(
        `✅ Customer already exists as company contact: ${existingContact.node.id}`,
      );
      return { exists: true, contactId: existingContact.node.id };
    }

    console.log(`ℹ️ Customer is not yet a company contact`);
    return { exists: false };
  } catch (error) {
    console.error("Error checking company contact:", error);
    return {
      exists: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Create a company customer in both Shopify and the local database
 *
 * This function:
 * 1. Creates a company contact in Shopify with credit information
 * 2. Creates/updates a corresponding user record in the local database
 * 3. Links the Shopify customer ID to the local user record
 * 4. Assigns roles and locations to the company contact
 *
 * @param companyId - Shopify company GID
 * @param shopName - Shop domain
 * @param accessToken - Shopify access token
 * @param customerData - Customer information including name, email, roles, and credit
 * @returns Success status with customer and contact IDs, or error message
 *
 * NOTE: This creates both the customer AND the company contact in one operation,
 * and ensures they're synced to the local database
 */

export async function createCompanyCustomer(
  companyId: string,
  shopName: string,
  accessToken: string,
  customerData: {
    firstName: string;
    lastName: string;
    email: string;
    locationRoles?: Array<{
      roleId?: string;
      roleName?: string;
      locationId?: string;
      locationName?: string;
    }>;
    credit: number;
  },
) {
  try {
    console.log(`🔄 Creating company contact for: ${customerData.email}`);

    // Step 1: Create company contact in Shopify
    const contactResult = await createCompanyContact(
      companyId,
      {
        firstName: customerData.firstName,
        lastName: customerData.lastName,
        email: customerData.email,
        credit: customerData.credit,
      },
      shopName,
      accessToken,
    );

    if (!contactResult.contactId) {
      return {
        error: contactResult.error || "Failed to create company contact",
      };
    }

    const contactId = contactResult.contactId;
    const customerId = contactResult.customerId || "";
    console.log(
      `✅ Created company contact: ${contactId}, Customer: ${customerId}`,
    );

    // Step 2: Create/update user in local database
    try {
      await createOrUpdateLocalUser({
        email: customerData.email,
        firstName: customerData.firstName,
        lastName: customerData.lastName,
        userCreditLimit: customerData.credit,
        shopifyCustomerId: customerId,
        shopifyCompanyId: companyId,
        shopName,
      });
    } catch (dbError) {
      console.error("❌ Error creating/updating local user:", dbError);
      // Don't fail the entire operation if local DB creation fails
      // The Shopify contact was created successfully
    }

    // Step 3: Assign multiple role-location combinations
    if (customerData.locationRoles && customerData.locationRoles.length > 0) {
      const roleAssignResult = await assignMultipleRolesAndLocations(
        contactId,
        companyId,
        customerData.locationRoles,
        shopName,
        accessToken,
      );

      if (!roleAssignResult.success) {
        console.warn(`⚠️ Role assignment failed: ${roleAssignResult.error}`);
        return {
          success: true,
          customerId,
          contactId,
          warning: `User created but role assignment failed: ${roleAssignResult.error}`,
        };
      }
    }

    return { success: true, customerId, contactId };
  } catch (error) {
    console.error("Error creating company customer:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

async function assignMultipleRolesAndLocations(
  contactId: string,
  companyId: string,
  locationRoles: Array<{
    roleId?: string;
    roleName?: string;
    locationId?: string;
    locationName?: string;
  }>,
  shopName: string,
  accessToken: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Fetch available roles and locations
    const [rolesResult, locationsResult] = await Promise.all([
      fetchCompanyRoles(companyId, shopName, accessToken),
      fetchCompanyLocations(companyId, shopName, accessToken),
    ]);

    if (rolesResult.error || !rolesResult.roles) {
      return {
        success: false,
        error: rolesResult.error || "Failed to fetch roles",
      };
    }

    if (locationsResult.error || !locationsResult.locations) {
      return {
        success: false,
        error: locationsResult.error || "Failed to fetch locations",
      };
    }

    const roles = rolesResult.roles;
    const locations = locationsResult.locations;

    // Process each role-location combination
    const assignments = locationRoles
      .map((lr) => {
        let roleId = lr.roleId;
        let locationId = lr.locationId;

        // If roleName provided, find roleId
        if (!roleId && lr.roleName) {
          const role = roles.find(
            (r) =>
              r.name.toLowerCase().trim() === lr.roleName!.toLowerCase().trim(),
          );
          if (role) {
            roleId = role.id;
          } else {
            console.warn(`⚠️ Role "${lr.roleName}" not found`);
            return null;
          }
        }

        // If locationName provided, find locationId
        if (!locationId && lr.locationName) {
          const location = locations.find(
            (l) =>
              l.name.toLowerCase().trim() ===
              lr.locationName!.toLowerCase().trim(),
          );
          if (location) {
            locationId = location.id;
          } else {
            console.warn(`⚠️ Location "${lr.locationName}" not found`);
            return null;
          }
        }

        // Ensure we have at least a roleId
        if (!roleId) {
          console.warn(`⚠️ No valid role found for assignment`);
          return null;
        }

        return { roleId, locationId };
      })
      .filter(Boolean) as Array<{ roleId: string; locationId?: string }>;

    if (assignments.length === 0) {
      return {
        success: false,
        error: "No valid role-location combinations found",
      };
    }

    console.log(
      `🎯 Assigning ${assignments.length} role-location combinations to contact ${contactId}`,
    );

    // Execute all assignments in parallel
    const results = await Promise.all(
      assignments.map((assignment) =>
        assignRoleToContact(
          contactId,
          assignment.roleId,
          shopName,
          accessToken,
          assignment.locationId,
        ),
      ),
    );

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      console.warn(`⚠️ ${failed.length} role assignments failed`);
      return {
        success: true,
        error: `${failed.length} out of ${assignments.length} assignments failed`,
      };
    }

    console.log(
      `✅ Successfully assigned all ${assignments.length} role-location combinations`,
    );
    return { success: true };
  } catch (error) {
    console.error("Error in assignMultipleRolesAndLocations:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function fetchCompanyRoles(
  companyId: string,
  shopName: string,
  accessToken: string,
): Promise<{ roles?: Array<{ id: string; name: string }>; error?: string }> {
  try {
    const rolesQuery = `
      query getCompanyRoles($companyId: ID!) {
        company(id: $companyId) {
          contactRoles(first: 20) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: rolesQuery,
          variables: { companyId },
        }),
      },
    );

    const result = await response.json();

    if (result.errors) {
      console.error("❌ GraphQL errors fetching roles:", result.errors);
      return { error: result.errors[0]?.message || "GraphQL error" };
    }

    const roles =
      result.data?.company?.contactRoles?.edges?.map(
        (e: { node: { id: string; name: string } }) => e.node,
      ) || [];

    console.log(`✅ Fetched ${roles.length} company contact roles`);
    return { roles };
  } catch (error) {
    console.error("Error fetching company roles:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

async function fetchCompanyLocations(
  companyId: string,
  shopName: string,
  accessToken: string,
): Promise<{
  locations?: Array<{ id: string; name: string }>;
  error?: string;
}> {
  const query = `
    query GetCompanyLocations($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 50) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: { companyId } }),
      },
    );

    const result = await response.json();

    if (result.errors) {
      return { error: result.errors[0].message };
    }

    const locations =
      result.data?.company?.locations?.edges.map(
        (e: { node: { id: string; name: string } }) => e.node,
      ) || [];

    return { locations };
  } catch (error: { message: string }) {
    return { error: error.message };
  }
}

async function assignRoleToContact(
  contactId: string,
  roleId: string,
  shopName: string,
  accessToken: string,
  locationId?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    let assignMutation: string;
    let variables: Record<string, string>;

    if (locationId) {
      assignMutation = `
        mutation companyContactAssignRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
          companyContactAssignRole(companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId, companyLocationId: $companyLocationId) {
            companyContactRoleAssignment {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      variables = {
        companyContactId: contactId,
        companyContactRoleId: roleId,
        companyLocationId: locationId,
      };
    } else {
      assignMutation = `
        mutation companyContactAssignRole($companyContactId: ID!, $companyContactRoleId: ID!) {
          companyContactAssignRole(companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId) {
            companyContactRoleAssignment {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      variables = {
        companyContactId: contactId,
        companyContactRoleId: roleId,
      };
    }

    console.log(
      `🔄 Assigning role ${roleId} to contact ${contactId}${locationId ? ` at location ${locationId}` : ""}`,
    );

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: assignMutation,
          variables,
        }),
      },
    );

    const result = await response.json();

    if (result.data?.companyContactAssignRole?.userErrors?.length > 0) {
      const errors = result.data.companyContactAssignRole.userErrors;
      return { success: false, error: errors[0].message };
    }

    console.log(
      `✅ Assigned role to contact${locationId ? " at location" : ""}`,
    );
    return { success: true };
  } catch (error) {
    console.error("Error assigning role:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function createCompanyContact(
  companyId: string,
  customerData: {
    firstName: string;
    lastName: string;
    email: string;
    credit: number;
  },
  shopName: string,
  accessToken: string,
): Promise<{ contactId?: string; customerId?: string; error?: string }> {
  try {
    const contactCreateMutation = `
      mutation CompanyContactCreate($companyId: ID!, $input: CompanyContactInput!) {
        companyContactCreate(companyId: $companyId, input: $input) {
          companyContact {
            id
            customer {
              id
              firstName
              lastName
              email
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    // REMOVE credit and remainingCredit from input - they're not valid fields
    const input = {
      email: customerData.email,
      firstName: customerData.firstName,
      lastName: customerData.lastName,
    };

    console.log("Creating user:", { companyId, input });

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: contactCreateMutation,
          variables: { companyId, input },
        }),
      },
    );

    const result = await response.json();
    console.log("Contact creation response:", result);

    // Check for errors
    if (result.errors) {
      return { error: result.errors[0]?.message || "GraphQL error" };
    }

    const contactId = result.data?.companyContactCreate?.companyContact?.id;
    const customerId =
      result.data?.companyContactCreate?.companyContact?.customer?.id;

    if (result.data?.companyContactCreate?.userErrors?.length > 0) {
      const errors = result.data.companyContactCreate.userErrors;
      return { error: errors[0].message };
    }

    if (!contactId || !customerId) {
      return { error: "Failed to create company contact" };
    }

    console.log(
      `✅ Created company contact: ${contactId}, Customer: ${customerId}`,
    );

    // Step 2: Set credit metafields AFTER contact creation
    if (customerData.credit) {
      const metafieldResult = await setCustomerCreditMetafields(
        customerId,
        customerData.credit,
        shopName,
        accessToken,
      );

      if (!metafieldResult.success) {
        console.warn(
          `⚠️ Credit metafield creation failed: ${metafieldResult.error}`,
        );
        // Still return success since contact was created
        return {
          contactId,
          customerId,
          error: `Contact created but credit metafield failed: ${metafieldResult.error}`,
        };
      }

      console.log(`✅ Set credit metafields: ${customerData.credit}`);
    }

    return { contactId, customerId };
  } catch (error) {
    console.error("Error creating company contact:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

// Helper function to set both credit metafields
async function setCustomerCreditMetafields(
  customerId: string,
  credit: number,
  shopName: string,
  accessToken: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Shopify's recommended mutation
    const mutation = `
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            key
            namespace
            value
            createdAt
            updatedAt
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    // Shopify's format - ownerId જરૂરી છે
    const metafields = [
      {
        ownerId: customerId, // gid://shopify/Customer/123 format
        namespace: "custom",
        key: "credit",
        type: "number_integer",
        value: credit.toString(),
      },
      {
        ownerId: customerId,
        namespace: "custom",
        key: "remaining_credit",
        type: "number_integer",
        value: credit.toString(),
      },
    ];

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: mutation,
          variables: { metafields },
        }),
      },
    );

    const result = await response.json();
    console.log("Metafield response:", result);

    if (result.errors) {
      return { success: false, error: result.errors[0]?.message };
    }

    if (result.data?.metafieldsSet?.userErrors?.length > 0) {
      return {
        success: false,
        error: result.data.metafieldsSet.userErrors[0].message,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Helper: Assign role and locations to company contact
 */
async function assignRoleAndLocations(
  contactId: string,
  companyId: string,
  roleName: string,
  locationIds: string[],
  shopName: string,
  accessToken: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Fetch available roles
    const rolesResult = await fetchCompanyRoles(
      companyId,
      shopName,
      accessToken,
    );

    if (rolesResult.error || !rolesResult.roles) {
      return {
        success: false,
        error: rolesResult.error || "Failed to fetch roles",
      };
    }

    // Find the role by name
    const role = rolesResult.roles.find(
      (r) => r.name.toLowerCase().trim() === roleName.toLowerCase().trim(),
    );

    if (!role) {
      console.warn(
        `⚠️ Role "${roleName}" not found in available roles:`,
        rolesResult.roles.map((r) => r.name),
      );
      return { success: true, error: `Role "${roleName}" not found` };
    }

    console.log(
      `🎯 Assigning role "${roleName}" (${role.id}) to contact ${contactId}`,
    );

    // If role assignment for specific locations
    if (locationIds?.length > 0) {
      // Fetch location nodes so we can map human name to gid
      const locationResult = await fetchCompanyLocations(
        companyId,
        shopName,
        accessToken,
      );
      if (locationResult.error || !locationResult.locations) {
        return {
          success: false,
          error: locationResult.error || "Failed to fetch locations",
        };
      }

      // Map names to actual GIDs
      const actualLocationIds = locationIds
        .map(
          (locName) =>
            locationResult.locations?.find((l) => l.name === locName)?.id,
        )
        .filter((id) => id !== undefined);

      if (actualLocationIds.length === 0) {
        console.warn("⚠️ No valid matching locations found for provided names");
        return { success: true };
      }

      // Run parallel role assignments
      const results = await Promise.all(
        actualLocationIds.map((locId) =>
          assignRoleToContact(
            contactId,
            role.id,
            shopName,
            accessToken,
            locId!,
          ),
        ),
      );

      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        console.warn(`⚠️ ${failed.length} role assignments failed`);
        return {
          success: true,
          error: `${failed.length} location assignments failed`,
        };
      }
    } else {
      // Assign role company-wide (no specific location)
      const assignResult = await assignRoleToContact(
        contactId,
        role.id,
        shopName,
        accessToken,
      );

      if (!assignResult.success) {
        return { success: false, error: assignResult.error };
      }
    }

    return { success: true };
  } catch (error) {
    console.error("Error in assignRoleAndLocations:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
export async function getCompanyLocations(
  companyId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const query = `
  query {
    company(id: "${companyId}") {
      id
      name
      contacts(first: 250) {
        edges {
          node {
            id
            title
            customer {
              id
              firstName
              lastName
              email
              phone
            }
            roleAssignments(first: 10) {
              edges {
                node {
                  role {
                    name
                  }
                  companyLocation {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
      locations(first: 50) {
        edges {
          node {
            id
            name
            note
            phone
            externalId
            shippingAddress {
              address1
              address2
              city
              province
              zip
              country
            }
            billingAddress {
              address1
              address2
              city
              province
              zip
              country
            }
          }
        }
      }
    }
  }
`;
    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );
    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      return { error: data.errors };
    }

    const company = data.data.company;
    // Get all contacts with their location assignments
    const contacts = company.contacts.edges.map(
      (edge: {
        node: {
          id: string;
          title: string;
          customer: { id: string };
          roleAssignments: {
            edges: Array<{
              node: {
                companyLocation: { id: string; name: string };
                role: { name: string };
              };
            }>;
          };
        };
      }) => {
        const node = edge.node;
        const locationAssignments =
          node.roleAssignments?.edges
            ?.map(
              (r: {
                node: {
                  companyLocation: { id: string; name: string };
                  role: { name: string };
                };
              }) => ({
                locationId: r.node.companyLocation?.id,
                locationName: r.node.companyLocation?.name,
                roleName: r.node.role?.name,
              }),
            )
            .filter((la: { locationId: string }) => la.locationId) || [];

        return {
          id: node.id,
          title: node.title,
          customer: node.customer,
          locationAssignments: locationAssignments,
        };
      },
    );

    // Count customers per location
    const locationCustomerCount: Record<
      string,
      { name: string; count: number; customerIds: string[] }
    > = {};

    contacts.forEach(
      (contact: {
        locationAssignments: { locationId: string; locationName: string }[];
        customer: { id: string };
      }) => {
        contact.locationAssignments.forEach((assignment) => {
          if (!locationCustomerCount[assignment.locationId]) {
            locationCustomerCount[assignment.locationId] = {
              name: assignment.locationName,
              count: 0,
              customerIds: [],
            };
          }

          // Only count unique customers per location
          if (
            !locationCustomerCount[assignment.locationId].customerIds.includes(
              contact.customer.id,
            )
          ) {
            locationCustomerCount[assignment.locationId].count++;
            locationCustomerCount[assignment.locationId].customerIds.push(
              contact.customer.id,
            );
          }
        });
      },
    );

    // Get locations with customer count
    const locations = company.locations.edges.map(
      (edge: {
        node: {
          id: string;
          name: string;
          shippingAddress: {
            address1: string;
            city: string;
            province: string;
            zip: string;
          };
        };
      }) => {
        const location = edge.node;

        const customerInfo = locationCustomerCount[location.id] || {
          count: 0,
          customerIds: [],
        };
        const shippingAddress = location.shippingAddress;
        const formattedAddress = shippingAddress
          ? `${shippingAddress.address1}, ${shippingAddress.city}, ${shippingAddress.province} ${shippingAddress.zip}`
          : "No address provided";
        return {
          id: location.id,
          name: location.name,
          note: location.note,
          phone: location.phone,
          externalId: location.externalId,
          shippingAddress: location.shippingAddress,
          billingAddress: location.billingAddress,
          assignedUsers: customerInfo.count,
          address: formattedAddress,
        };
      },
    );

    return {
      companyId: company.id,
      companyName: company.name,
      contacts: contacts,
      locations: locations,
      locationCustomerCount: locationCustomerCount,
    };
  } catch (error: unknown) {
    console.error("Error fetching company locations:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function getCompanyLocationById(
  locationId: string,
  companyId: string,
  shop: string,
  accessToken: string,
) {
  try {
    const query = `
      query GetCompanyLocation($locationId: ID!) {
        companyLocation(id: $locationId) {
          id
          name
          locale
          phone
          externalId
          note
          createdAt
          updatedAt
          shippingAddress {
            address1
            address2
            city
            province
            zip
            country
            countryCode
            phone
            zoneCode
          }
          billingAddress {
            address1
            address2
            city
            province
            zip
            country
            countryCode
            phone
            zoneCode
          }
          company {
            id
            name
          }
          taxExemptions
          buyerExperienceConfiguration {
            checkoutToDraft
            editableShippingAddress
            payNowOnly
            paymentTermsTemplate {
              id
              name
            }
          }
        }
      }
    `;

    const variables = {
      locationId,
    };

    const response = await fetch(
      `https://${shop}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    if (!response.ok) {
      console.error("Shopify API error:", response.status, response.statusText);
      return { error: "Failed to fetch location from Shopify" };
    }

    const result = await response.json();

    if (result.errors) {
      console.error("GraphQL errors:", result.errors);
      return { error: "GraphQL query failed" };
    }

    const location = result.data?.companyLocation;

    if (!location) {
      return { error: "Not found" };
    }

    // Verify the location belongs to the specified company
    if (location.company?.id !== companyId) {
      console.error("Location does not belong to company");
      return { error: "Unauthorized - location does not belong to company" };
    }

    return {
      location,
    };
  } catch (error) {
    console.error("Error fetching company location:", error);
    return {
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Function to update a company customer
export async function updateCompanyCustomer(
  contactId: string,
  companyId: string,
  shopName: string,
  accessToken: string,
  customerData: {
    firstName?: string;
    lastName?: string;
    email?: string;
    locationRoles?: Array<{
      roleId?: string;
      roleName?: string;
      locationId?: string;
      locationName?: string;
    }>;
    credit?: number;
  },
) {
  try {
    const results: Record<string, unknown> = {
      success: true,
      updates: {},
      warnings: [],
    };

    const makeGraphQLRequest = async (
      query: string,
      variables: Record<string, unknown>,
    ) => {
      const response = await fetch(
        `https://${shopName}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query, variables }),
        },
      );
      return await response.json();
    };

    // ---- Get Customer ID From Contact ----
    const contactGid = contactId.startsWith("gid://")
      ? contactId
      : `gid://shopify/CompanyContact/${contactId}`;

    console.log("📝 Contact ID:", contactId);
    console.log("📝 Generated contactGid:", contactGid);

    const getCustomerResult = await makeGraphQLRequest(
      `query getCompanyContact($id: ID!) {
        companyContact(id: $id) {
          customer {
            id
          }
          roleAssignments(first: 50) {
            edges {
              node {
                id
                role {
                  id
                  name
                }
                company {
                  id
                }
                companyLocation {
                  id
                  name
                }
              }
            }
          }
        }
      }`,
      { id: contactGid },
    );

    console.log("📝 Customer query result:", getCustomerResult);

    if (getCustomerResult.errors?.length) {
      return { success: false, error: getCustomerResult.errors[0].message };
    }

    const customerId = getCustomerResult.data?.companyContact?.customer?.id;
    if (!customerId) {
      return { success: false, error: "Customer ID not found for contact" };
    }

    // Get existing role assignments with full details
    const existingRoleAssignments =
      getCustomerResult.data?.companyContact?.roleAssignments?.edges?.map(
        (edge: {
          node: {
            id: string;
            role: { id: string; name: string };
            companyLocation: { id: string; name: string };
          };
        }) => ({
          id: edge.node.id,
          roleId: edge.node.role?.id,
          roleName: edge.node.role?.name,
          locationId: edge.node.companyLocation?.id,
          locationName: edge.node.companyLocation?.name,
        }),
      ) || [];

    // ---- Update Customer Info ----
    if (
      customerData.email ||
      customerData.firstName ||
      customerData.lastName ||
      customerData.credit !== undefined
    ) {
      const payload: Record<string, unknown> = { id: customerId };

      if (customerData.email) payload.email = customerData.email;
      if (customerData.firstName) payload.firstName = customerData.firstName;
      if (customerData.lastName) payload.lastName = customerData.lastName;

      if (customerData.credit !== undefined) {
        payload.metafields = [
          {
            namespace: "custom",
            key: "credit",
            value: customerData.credit.toString(),
            type: "number_integer",
          },
        ];
      }

      console.log("📝 Customer update payload:", payload);

      const updateResponse = await makeGraphQLRequest(
        `mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            userErrors {
              field
              message
            }
            customer {
              id
            }
          }
        }`,
        { input: payload },
      );

      console.log("📝 Customer update response:", updateResponse);

      if (updateResponse.data?.customerUpdate?.userErrors?.length) {
        return {
          success: false,
          error: updateResponse.data.customerUpdate.userErrors[0].message,
        };
      }

      results.updates.customerInfo = "updated";
    }

    // ---- Update Role Assignments ----
    if (customerData.locationRoles !== undefined) {
      console.log("🎯 New locationRoles:", customerData.locationRoles);

      const roleUpdateResult = await smartRoleUpdate(
        contactGid,
        companyId,
        existingRoleAssignments,
        customerData.locationRoles,
        shopName,
        accessToken,
      );

      if (!roleUpdateResult.success) {
        results.warnings.push(roleUpdateResult.error || "Role update failed");
      }

      results.updates.roleAndLocation = roleUpdateResult.message || "updated";
    }
    console.log(results, "445454");
    return results;
  } catch (error) {
    console.error("❌ Error updating customer:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function smartRoleUpdate(
  contactId: string,
  companyId: string,
  existingAssignments: Array<{
    id: string;
    roleId?: string;
    roleName?: string;
    locationId?: string;
    locationName?: string;
  }>,
  newLocationRoles: Array<{
    roleId?: string;
    roleName?: string;
    locationId?: string;
    locationName?: string;
  }>,
  shopName: string,
  accessToken: string,
): Promise<{
  success: boolean;
  error?: string;
  message?: string;
  normalized?: Array<{
    roleId: string;
    roleName: string;
    locationId: string | null;
    locationName: string | null;
  }>;
}> {
  try {
    const [rolesResult, locationsResult] = await Promise.all([
      fetchCompanyRoless(companyId, shopName, accessToken),
      fetchCompanyLocationss(companyId, shopName, accessToken),
    ]);

    if (rolesResult.error || !rolesResult.roles) {
      return {
        success: false,
        error: rolesResult.error || "Failed to fetch roles",
      };
    }

    if (locationsResult.error || !locationsResult.locations) {
      return {
        success: false,
        error: locationsResult.error || "Failed to fetch locations",
      };
    }

    const roles = rolesResult.roles;
    const locations = locationsResult.locations;

    // Normalize new roles
    const normalizedNewRoles = newLocationRoles
      .map((lr) => {
        let { roleId, roleName, locationId, locationName } = lr;

        // Resolve roleId from roleName if needed
        if (roleId || roleName) {
          const role = roles.find(
            (r) =>
              roleName &&
              r.name.toLowerCase().trim() === roleName.toLowerCase().trim(),
          );
          console.log(role);
          if (role) {
            roleId = role.id;
            roleName = role.name;
          } else return null;
        }
        // Resolve locationId from locationName if needed
        if (!locationId && locationName) {
          const location = locations.find(
            (l) =>
              locationName &&
              l.name.toLowerCase().trim() === locationName.toLowerCase().trim(),
          );
          if (location) {
            locationId = location.id;
            locationName = location.name;
          } else return null;
        } else if (locationId) {
          const location = locations.find((l) => l.id === locationId);
          locationName = location?.name || locationName;
        }

        if (!roleId) return null;

        return {
          roleId,
          locationId: locationId || null, // ✅ Already handles missing location
          roleName: roleName || "",
          locationName: locationName || null,
        };
      })
      .filter(Boolean) as Array<{
      roleId: string;
      roleName: string;
      locationId: string | null;
      locationName: string | null;
    }>;

    console.log("🔍 Normalized new roles:", normalizedNewRoles);
    console.log("🔍 Existing assignments:", existingAssignments);

    const toRemove: string[] = [];
    const toAdd: Array<{ roleId: string; locationId?: string }> = [];
    const toUpdate: Array<{
      assignmentId: string;
      oldRoleId: string;
      newRoleId: string;
      locationId: string | null;
    }> = [];

    // ✅ NEW LOGIC: Handle role-only updates (when locationId is provided in newRole)
    // If newRole has locationId, check if we need to UPDATE the role for that location
    for (const newRole of normalizedNewRoles) {
      if (newRole.locationId) {
        // Find existing assignment with same location
        const existingWithSameLocation = existingAssignments.find(
          (ex) => (ex.locationId || null) === newRole.locationId,
        );

        if (existingWithSameLocation) {
          // Location exists - check if role needs updating
          if (existingWithSameLocation.roleId !== newRole.roleId) {
            toUpdate.push({
              assignmentId: existingWithSameLocation.id,
              oldRoleId: existingWithSameLocation.roleId!,
              newRoleId: newRole.roleId,
              locationId: newRole.locationId,
            });
          }
          // else: role and location match - no action needed
        } else {
          // Location doesn't exist - need to add
          toAdd.push({
            roleId: newRole.roleId,
            locationId: newRole.locationId || undefined,
          });
        }
      } else {
        // No locationId specified - treat as company-level role
        const alreadyExists = existingAssignments.some(
          (ex) =>
            newRole.roleId === ex.roleId && (ex.locationId || null) === null,
        );
        if (!alreadyExists) {
          toAdd.push({ roleId: newRole.roleId });
        }
      }
    }

    // Find assignments to remove (not in new roles)
    for (const existing of existingAssignments) {
      const stillExists = normalizedNewRoles.some((nr) => {
        // If new role has location, match by location
        if (nr.locationId) {
          return (existing.locationId || null) === nr.locationId;
        }
        // Otherwise match by role and location
        return (
          nr.roleId === existing.roleId &&
          (nr.locationId || null) === (existing.locationId || null)
        );
      });

      if (!stillExists) {
        toRemove.push(existing.id);
      }
    }

    console.log("🔄 Roles to Update:", toUpdate);
    console.log("🗑️ Roles to Remove:", toRemove);
    console.log("➕ Roles to Add:", toAdd);

    // If no changes needed
    if (toRemove.length === 0 && toAdd.length === 0 && toUpdate.length === 0) {
      console.log("✅ Roles are already up to date");
      return {
        success: true,
        message: "no changes needed",
        normalized: normalizedNewRoles,
      };
    }

    // ✅ STEP 1: Remove roles that are no longer needed
    // Note: companyContactRevokeRoles uses a DIFFERENT parameter name than companyLocationRevokeRoles
    if (toRemove.length > 0) {
      console.log("🗑️ Removing role assignments...");
      const removeResult = await makeGraphQLRequest(
        `mutation companyContactRevokeRoles($companyContactId: ID!, $roleAssignmentIds: [ID!]!) {
          companyContactRevokeRoles(
            companyContactId: $companyContactId
            roleAssignmentIds: $roleAssignmentIds
          ) {
            revokedRoleAssignmentIds
            userErrors { field message }
          }
        }`,
        { companyContactId: contactId, roleAssignmentIds: toRemove },
        shopName,
        accessToken,
      );

      console.log("✅ Removal result:", removeResult);

      if (
        removeResult.errors ||
        removeResult.data?.companyContactRevokeRoles?.userErrors?.length > 0
      ) {
        const errorMsg = removeResult.errors
          ? removeResult.errors[0].message
          : removeResult.data.companyContactRevokeRoles.userErrors[0].message;
        console.error("❌ Removal failed:", errorMsg);
        return {
          success: false,
          error: `Failed to remove roles: ${errorMsg}`,
          normalized: normalizedNewRoles,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // ✅ STEP 2: Update existing roles (remove old + add new for same location)
    if (toUpdate.length > 0) {
      console.log("🔄 Updating role assignments...");

      for (const update of toUpdate) {
        // Remove old role
        const removeResult = await makeGraphQLRequest(
          `mutation companyContactRevokeRoles($companyContactId: ID!, $roleAssignmentIds: [ID!]!) {
            companyContactRevokeRoles(
              companyContactId: $companyContactId
              roleAssignmentIds: $roleAssignmentIds
            ) {
              revokedRoleAssignmentIds
              userErrors { field message }
            }
          }`,
          {
            companyContactId: contactId,
            roleAssignmentIds: [update.assignmentId],
          },
          shopName,
          accessToken,
        );

        if (
          removeResult.errors ||
          removeResult.data?.companyContactRevokeRoles?.userErrors?.length > 0
        ) {
          const errorMsg = removeResult.errors
            ? removeResult.errors[0].message
            : removeResult.data.companyContactRevokeRoles.userErrors[0].message;
          console.error("❌ Update removal failed:", errorMsg);
          continue; // Skip to next update
        }

        await new Promise((resolve) => setTimeout(resolve, 300));

        // Add new role
        const assignResult = await makeGraphQLRequest(
          `mutation companyContactAssignRoles($companyContactId: ID!, $rolesToAssign: [CompanyContactRoleAssign!]!) {
            companyContactAssignRoles(
              companyContactId: $companyContactId
              rolesToAssign: $rolesToAssign
            ) {
              roleAssignments {
                id
                role { id name }
                companyLocation { id name }
              }
              userErrors { field message }
            }
          }`,
          {
            companyContactId: contactId,
            rolesToAssign: [
              {
                companyContactRoleId: update.newRoleId,
                ...(update.locationId && {
                  companyLocationId: update.locationId,
                }),
              },
            ],
          },
          shopName,
          accessToken,
        );

        if (
          assignResult.errors ||
          assignResult.data?.companyContactAssignRoles?.userErrors?.length > 0
        ) {
          const errorMsg = assignResult.errors
            ? assignResult.errors[0].message
            : assignResult.data.companyContactAssignRoles.userErrors[0].message;
          console.error("❌ Update assignment failed:", errorMsg);
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    // ✅ STEP 3: Add new roles
    if (toAdd.length > 0) {
      console.log("➕ Adding new role assignments...");

      const rolesToAssign = toAdd.map((role) => ({
        companyContactRoleId: role.roleId,
        ...(role.locationId && { companyLocationId: role.locationId }),
      }));

      const assignResult = await makeGraphQLRequest(
        `mutation companyContactAssignRoles($companyContactId: ID!, $rolesToAssign: [CompanyContactRoleAssign!]!) {
          companyContactAssignRoles(
            companyContactId: $companyContactId
            rolesToAssign: $rolesToAssign
          ) {
            roleAssignments {
              id
              role { id name }
              companyLocation { id name }
            }
            userErrors { field message }
          }
        }`,
        { companyContactId: contactId, rolesToAssign },
        shopName,
        accessToken,
      );

      console.log("✅ Assignment result:", assignResult);

      if (
        assignResult.errors ||
        assignResult.data?.companyContactAssignRoles?.userErrors?.length > 0
      ) {
        const errorMsg = assignResult.errors
          ? assignResult.errors[0].message
          : assignResult.data.companyContactAssignRoles.userErrors[0].message;
        return {
          success: false,
          error: `Failed to assign roles: ${errorMsg}`,
          normalized: normalizedNewRoles,
        };
      }
    }

    return {
      success: true,
      message: "updated",
      normalized: normalizedNewRoles,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function makeGraphQLRequest(
  query: string,
  variables: Record<string, unknown>,
  shopName: string,
  accessToken: string,
) {
  const response = await fetch(
    `https://${shopName}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  return await response.json();
}

// Fetch company roles
async function fetchCompanyRoless(
  companyId: string,
  shopName: string,
  accessToken: string,
): Promise<{ roles?: Array<{ id: string; name: string }>; error?: string }> {
  try {
    const rolesQuery = `
      query getCompanyRoles($companyId: ID!) {
        company(id: $companyId) {
          contactRoles(first: 20) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: rolesQuery,
          variables: { companyId },
        }),
      },
    );

    const result = await response.json();

    if (result.errors) {
      console.error("❌ GraphQL errors fetching roles:", result.errors);
      return { error: result.errors[0]?.message || "GraphQL error" };
    }

    const roles =
      result.data?.company?.contactRoles?.edges?.map(
        (e: { node: { id: string; name: string } }) => e.node,
      ) || [];

    console.log(`✅ Fetched ${roles.length} company contact roles`);
    return { roles };
  } catch (error) {
    console.error("Error fetching company roles:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

// Fetch company locations
async function fetchCompanyLocationss(
  companyId: string,
  shopName: string,
  accessToken: string,
): Promise<{
  locations?: Array<{ id: string; name: string }>;
  error?: string;
}> {
  const query = `
    query GetCompanyLocations($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 50) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: { companyId } }),
      },
    );

    const result = await response.json();

    if (result.errors) {
      return { error: result.errors[0].message };
    }

    const locations =
      result.data?.company?.locations?.edges.map(
        (e: { node: { id: string; name: string } }) => e.node,
      ) || [];

    return { locations };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

// Assign single role to contact
async function assignRoleToContacts(
  contactId: string,
  roleId: string,
  shopName: string,
  accessToken: string,
  locationId?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    let assignMutation: string;
    let variables: Record<string, string>;

    if (locationId) {
      assignMutation = `
        mutation companyContactAssignRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
          companyContactAssignRole(companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId, companyLocationId: $companyLocationId) {
            companyContactRoleAssignment {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      variables = {
        companyContactId: contactId,
        companyContactRoleId: roleId,
        companyLocationId: locationId,
      };
    } else {
      assignMutation = `
        mutation companyContactAssignRole($companyContactId: ID!, $companyContactRoleId: ID!) {
          companyContactAssignRole(companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId) {
            companyContactRoleAssignment {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      variables = {
        companyContactId: contactId,
        companyContactRoleId: roleId,
      };
    }

    console.log(
      `🔄 Assigning role ${roleId} to contact ${contactId}${locationId ? ` at location ${locationId}` : ""}`,
    );

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: assignMutation,
          variables,
        }),
      },
    );

    const result = await response.json();

    if (result.data?.companyContactAssignRole?.userErrors?.length > 0) {
      const errors = result.data.companyContactAssignRole.userErrors;
      return { success: false, error: errors[0].message };
    }

    console.log(
      `✅ Assigned role to contact${locationId ? " at location" : ""}`,
    );
    return { success: true };
  } catch (error) {
    console.error("Error assigning role:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

type ServiceResult<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; status: number; message: string };

// Function to delete a company customer
export async function deleteCompanyCustomer(
  contactId: string,
  shopName: string,
  accessToken: string,
): Promise<ServiceResult<{ deletedId: string; deletedCustomerId?: string }>> {
  try {
    // Step 1: Get customer ID before deleting the contact
    const getCustomerQuery = `
      query getCompanyContact($id: ID!) {
        companyContact(id: $id) {
          id
          customer {
            id
          }
        }
      }
    `;

    const customerResponse = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: getCustomerQuery,
          variables: { id: contactId },
        }),
      },
    );

    const customerData = await customerResponse.json();
    const customerId = customerData.data?.companyContact?.customer?.id;

    if (!customerId) {
      return {
        ok: false,
        status: 404,
        message: "Customer not found for this contact",
      };
    }

    console.log("Found customer:", customerId, "for contact:", contactId);

    // Step 2: Delete the company contact first
    const deleteContactMutation = `
      mutation companyContactDelete($id: ID!) {
        companyContactDelete(companyContactId: $id) {
          deletedCompanyContactId
          userErrors {
            message
          }
        }
      }
    `;

    const contactRes = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: deleteContactMutation,
          variables: { id: contactId },
        }),
      },
    );

    const contactJson = await contactRes.json();

    if (contactJson.errors?.length) {
      return {
        ok: false,
        status: 400,
        message: contactJson.errors[0].message,
      };
    }

    const contactPayload = contactJson.data?.companyContactDelete;

    if (contactPayload?.userErrors?.length) {
      return {
        ok: false,
        status: 400,
        message: contactPayload.userErrors[0].message,
      };
    }

    console.log("✅ Deleted company contact:", contactId);

    // Step 3: Delete the underlying Shopify customer
    const deleteCustomerMutation = `
      mutation customerDelete($input: CustomerDeleteInput!) {
        customerDelete(input: $input) {
          deletedCustomerId
          userErrors {
            field
            message
          }
        }
      }
    `;

    const customerDeleteRes = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: deleteCustomerMutation,
          variables: {
            input: { id: customerId },
          },
        }),
      },
    );

    const customerDeleteJson = await customerDeleteRes.json();

    if (customerDeleteJson.errors?.length) {
      console.warn(
        "⚠️ Customer delete error:",
        customerDeleteJson.errors[0].message,
      );
      return {
        ok: true,
        data: {
          deletedId: contactPayload.deletedCompanyContactId,
          deletedCustomerId: undefined,
        },
        message: "Contact deleted but customer deletion failed",
      };
    }

    const customerDeletePayload = customerDeleteJson.data?.customerDelete;

    if (customerDeletePayload?.userErrors?.length) {
      console.warn(
        "⚠️ Customer delete error:",
        customerDeletePayload.userErrors[0].message,
      );
      return {
        ok: true,
        data: {
          deletedId: contactPayload.deletedCompanyContactId,
          deletedCustomerId: undefined,
        },
        message: "Contact deleted but customer deletion failed",
      };
    }

    console.log("✅ Deleted Shopify customer:", customerId);

    return {
      ok: true,
      data: {
        deletedId: contactPayload.deletedCompanyContactId,
        deletedCustomerId: customerDeletePayload.deletedCustomerId,
      },
    };
  } catch (err) {
    console.error("Error in deleteCompanyCustomer:", err);
    return {
      ok: false,
      status: 500,
      message: err instanceof Error ? err.message : "Internal server error",
    };
  }
}

export async function getCompanyContactEmail(
  contactId: string,
  shopName: string,
  accessToken: string,
) {
  const query = `
    query getCompanyContact($id: ID!) {
      companyContact(id: $id) {
        customer {
          email
        }
      }
    }
  `;

  const response = await fetch(
    `https://${shopName}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { id: contactId },
      }),
    },
  );

  const result = await response.json();
  console.log(result, "CompanyContact email response");

  return result.data?.companyContact?.customer?.email ?? null;
}

// Function to create a company location
export async function createCompanyLocation(
  companyId: string,
  shopName: string,
  accessToken: string,
  locationData: {
    name: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    phone?: string;
    externalId?: string;
    note?: string;
  },
) {
  try {
    const createMutation = `
      mutation companyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
        companyLocationCreate(companyId: $companyId, input: $input) {
          companyLocation {
            id
            name
            phone
            locale
            externalId
            note
            shippingAddress {
              address1
              address2
              city
              zip
              province
              country
            }
            billingAddress {
              address1
              address2
              city
              zip
              province
              country
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input: {
      name: string;
      phone?: string;
      externalId?: string;
      note?: string;
      billingAddress?: {
        address1: string;
        address2?: string;
        city: string;
        zip: string;
        zoneCode?: string;
        countryCode: string;
      };
      shippingAddress?: {
        address1: string;
        address2?: string;
        city: string;
        zip: string;
        zoneCode?: string;
        countryCode: string;
      };
    } = {
      name: locationData.name,
    };

    // Add optional fields
    if (locationData.phone) {
      input.phone = locationData.phone;
    }
    if (locationData.externalId) {
      input.externalId = locationData.externalId;
    }
    if (locationData.note) {
      input.note = locationData.note;
    }

    // Add billing and shipping address if provided
    if (locationData.address1 || locationData.city) {
      const addressData = {
        address1: locationData.address1 || "",
        address2: locationData.address2,
        city: locationData.city || "",
        zip: locationData.zip || "",
        zoneCode: locationData.province || "GJ",
        countryCode: locationData.country || "IN",
      };

      input.billingAddress = addressData;
      input.shippingAddress = addressData;
    }

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: createMutation,
          variables: { companyId, input },
        }),
      },
    );

    // Check if response is ok before parsing
    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ HTTP Error:", response.status, errorText);
      return {
        error: `HTTP ${response.status}: ${response.statusText}`,
        details: errorText.substring(0, 200),
      };
    }

    // Check content type before parsing JSON
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const textResponse = await response.text();
      console.error("❌ Non-JSON response:", textResponse.substring(0, 500));
      return {
        error:
          "Invalid response from Shopify API - expected JSON but received HTML",
        details: "This usually means the shop URL or access token is incorrect",
      };
    }

    const result = await response.json();
    console.log("📦 Full result:", JSON.stringify(result, null, 2));

    // Check for GraphQL errors
    if (result.errors) {
      console.error("❌ GraphQL Errors:", result.errors);
      return {
        error: result.errors[0]?.message || "GraphQL error occurred",
        graphqlErrors: result.errors,
      };
    }

    // Check for user errors
    if (result.data?.companyLocationCreate?.userErrors?.length > 0) {
      const userErrors = result.data.companyLocationCreate.userErrors;
      console.error("❌ User Errors:", userErrors);

      return {
        error: userErrors[0].message,
        userErrors: userErrors,
        field: userErrors[0].field,
      };
    }

    if (!result.data?.companyLocationCreate?.companyLocation) {
      console.error("❌ No location created");
      return { error: "Failed to create location - no location returned" };
    }

    return {
      success: true,
      locationId: result.data.companyLocationCreate.companyLocation.id,
    };
  } catch (error) {
    console.error("💥 Error creating company location:", error);

    // Provide more specific error messages
    if (error instanceof SyntaxError) {
      return {
        error:
          "Invalid response from Shopify - please check your shop URL and access token",
        technicalError: error.message,
      };
    }

    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
      type: error instanceof Error ? error.constructor.name : "Unknown",
    };
  }
}

export async function checkLocationExists(
  companyId: string,
  shopName: string,
  accessToken: string,
  locationName: string,
) {
  const query = `
    query getCompanyLocations($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 100) {
          nodes {
            name
          }
        }
      }
    }
  `;

  const response = await fetch(
    `https://${shopName}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { companyId },
      }),
    },
  );

  const result = await response.json();

  const locations = result?.data?.company?.locations?.nodes || [];

  return locations.some(
    (loc: { name: string }) =>
      loc.name.trim().toLowerCase() === locationName.trim().toLowerCase(),
  );
}

export async function getCompanyContactRoles(
  companyId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const numericId = companyId.split("/").pop();

    const query = `
      query getCompanyRoles {
        companies(first: 10, query: "id:'${numericId}'") {
          edges {
            node {
              id
              name
              contactRoles(first: 10) {
                nodes {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const result = await response.json();
    console.log("📋 Company Roles:", JSON.stringify(result, null, 2));

    if (result.errors) {
      return { error: result.errors[0]?.message };
    }

    const roles =
      result.data?.companies?.edges?.[0]?.node?.contactRoles?.nodes || [];

    if (roles.length === 0) {
      return { error: "No roles found for this company" };
    }

    return {
      success: true,
      roles: roles,
      defaultRoleId:
        roles.find((r: { name: string }) => r.name === "Location admin")?.id ||
        roles[0].id,
    };
  } catch (error) {
    console.error("💥 Error fetching company roles:", error);
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function assignContactToLocation(
  companyContactId: string,
  companyContactRoleId: string,
  companyLocationId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const mutation = `
      mutation assignRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
        companyContactAssignRole(
          companyContactId: $companyContactId
          companyContactRoleId: $companyContactRoleId
          companyLocationId: $companyLocationId
        ) {
          companyContactRoleAssignment {
            id
            company {
              id
              name
            }
            companyContact {
              id
            }
            companyLocation {
              id
              name
            }
            role {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            companyContactId,
            companyContactRoleId,
            companyLocationId,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ HTTP Error:", response.status, errorText);
      return {
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const result = await response.json();
    console.log("📦 Assign Role Result:", JSON.stringify(result, null, 2));

    if (result.errors) {
      return {
        error: result.errors[0]?.message || "GraphQL error occurred",
        graphqlErrors: result.errors,
      };
    }

    if (result.data?.companyContactAssignRole?.userErrors?.length > 0) {
      const userErrors = result.data.companyContactAssignRole.userErrors;
      return {
        error: userErrors[0].message,
        userErrors: userErrors,
      };
    }

    return {
      success: true,
      roleAssignment:
        result.data?.companyContactAssignRole?.companyContactRoleAssignment,
    };
  } catch (error) {
    console.error("💥 Error assigning role:", error);
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function findCompanyContactByCustomer(
  companyId: string,
  customerId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const numericCompanyId = companyId.split("/").pop();

    const query = `
      query getCompanyContacts {
        companies(first: 1, query: "id:'${numericCompanyId}'") {
          edges {
            node {
              id
              contacts(first: 50) {
                edges {
                  node {
                    id
                    customer {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const result = await response.json();
    console.log("🔍 Company Contacts:", JSON.stringify(result, null, 2));

    if (result.errors) {
      return {
        error: result.errors[0]?.message || "GraphQL error occurred",
      };
    }

    const contacts =
      result.data?.companies?.edges?.[0]?.node?.contacts?.edges || [];

    const matchingContact = contacts.find(
      (edge: { node: { customer: { id: string } } }) =>
        edge.node.customer?.id === customerId,
    );

    if (!matchingContact) {
      return {
        error: "Company contact not found for this customer",
        availableContacts: contacts.map(
          (e: { node: { id: string } }) => e.node.id,
        ),
      };
    }

    return {
      success: true,
      companyContactId: matchingContact.node.id,
    };
  } catch (error) {
    console.error("💥 Error finding company contact:", error);
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function assignCustomerAsContact(
  companyId: string,
  customerId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const mutation = `
      mutation assignCustomer($companyId: ID!, $customerId: ID!) {
        companyAssignCustomerAsContact(
          companyId: $companyId
          customerId: $customerId
        ) {
          companyContact {
            id
            customer {
              id
              email
              firstName
              lastName
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: mutation,
          variables: { companyId, customerId },
        }),
      },
    );

    const result = await response.json();
    console.log("👤 Assign Customer Result:", JSON.stringify(result, null, 2));

    if (result.errors) {
      return {
        error: result.errors[0]?.message || "GraphQL error occurred",
        graphqlErrors: result.errors,
      };
    }

    if (result.data?.companyAssignCustomerAsContact?.userErrors?.length > 0) {
      const userErrors = result.data.companyAssignCustomerAsContact.userErrors;
      return {
        error: userErrors[0].message,
        userErrors: userErrors,
      };
    }

    return {
      success: true,
      companyContactId:
        result.data?.companyAssignCustomerAsContact?.companyContact?.id,
      companyContact:
        result.data?.companyAssignCustomerAsContact?.companyContact,
    };
  } catch (error) {
    console.error("💥 Error assigning customer as contact:", error);
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function createLocationAndAssignToContact(
  companyId: string,
  customerId: string,
  shopName: string,
  accessToken: string,
  locationData: {
    name: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    phone?: string;
    externalId?: string;
    note?: string;
  },
) {
  console.log("🚀 Starting complete workflow...");

  const locationResult = await createCompanyLocation(
    companyId,
    shopName,
    accessToken,
    locationData,
  );

  if (!locationResult.success || !locationResult.locationId) {
    return {
      error: locationResult.error,
      details: locationResult.error,
    };
  }
  console.log("✅ Location created:", locationResult.locationId);
  let companyContactId: string;
  const findResult = await findCompanyContactByCustomer(
    companyId,
    customerId,
    shopName,
    accessToken,
  );

  if (findResult.success && findResult.companyContactId) {
    companyContactId = findResult.companyContactId;
    console.log("✅ Found existing Company Contact:", companyContactId);
  } else {
    const contactResult = await assignCustomerAsContact(
      companyId,
      customerId,
      shopName,
      accessToken,
    );

    if (!contactResult.success || !contactResult.companyContactId) {
      return {
        warning: "Location created but failed to create company contact",
        locationId: locationResult.locationId,
        contactError: contactResult.error,
      };
    }

    companyContactId = contactResult.companyContactId;
    console.log("✅ Company Contact created:", companyContactId);
  }

  const rolesResult = await getCompanyContactRoles(
    companyId,
    shopName,
    accessToken,
  );

  if (!rolesResult.success || !rolesResult.defaultRoleId) {
    return {
      warning: "Location and contact created but failed to fetch roles",
      locationId: locationResult.locationId,
      companyContactId: companyContactId,
      rolesError: rolesResult.error,
    };
  }
  const assignResult = await assignContactToLocation(
    companyContactId,
    rolesResult.defaultRoleId,
    locationResult.locationId,
    shopName,
    accessToken,
  );

  if (!assignResult.success) {
    return {
      warning: "Location and contact created but failed to assign",
      locationId: locationResult.locationId,
      companyContactId: companyContactId,
      availableRoles: rolesResult.roles,
      assignError: assignResult.error,
    };
  }

  console.log("✅ Contact assigned to location successfully!");

  return {
    success: true,
    locationId: locationResult.locationId,
    companyContactId: companyContactId,
    roleAssignment: assignResult.roleAssignment,
    usedRoleId: rolesResult.defaultRoleId,
    availableRoles: rolesResult.roles,
  };
}

export async function updateCompanyLocation(
  locationId: string,
  shopName: string,
  accessToken: string,
  locationData: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    phone?: string;
    externalId?: string;
    note?: string;
  },
) {
  try {
    let hasErrors = false;
    const errors: string[] = [];

    // Step 1: Update basic fields (name, phone, externalId, note)
    const hasBasicUpdate =
      locationData.name !== undefined ||
      locationData.phone !== undefined ||
      locationData.externalId !== undefined ||
      locationData.note !== undefined;

    if (hasBasicUpdate) {
      const updateMutation = `
        mutation companyLocationUpdate($companyLocationId: ID!, $input: CompanyLocationUpdateInput!) {
          companyLocationUpdate(companyLocationId: $companyLocationId, input: $input) {
            companyLocation {
               id
              name
              phone
              locale
              externalId
              note
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const input: {
        name?: string;
        phone?: string;
        externalId?: string;
        note?: string;
      } = {};

      if (locationData.name !== undefined) {
        input.name = locationData.name;
      }
      if (locationData.phone !== undefined) {
        input.phone = locationData.phone;
      }
      if (locationData.externalId !== undefined) {
        input.externalId = locationData.externalId;
      }
      if (locationData.note !== undefined) {
        input.note = locationData.note;
      }

      console.log("📝 Updating basic fields:", JSON.stringify(input, null, 2));

      const response = await fetch(
        `https://${shopName}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: updateMutation,
            variables: { companyLocationId: locationId, input },
          }),
        },
      );

      const result = await response.json();
      console.log("📦 Basic update result:", JSON.stringify(result, null, 2));

      if (result.data?.companyLocationUpdate?.userErrors?.length > 0) {
        hasErrors = true;
        errors.push(
          ...result.data.companyLocationUpdate.userErrors.map(
            (e: { message: string }) => e.message,
          ),
        );
      }
    }

    // Step 2: Update address if any address field is provided
    const hasAddressUpdate =
      locationData.address1 !== undefined ||
      locationData.address2 !== undefined ||
      locationData.city !== undefined ||
      locationData.province !== undefined ||
      locationData.zip !== undefined ||
      locationData.country !== undefined;

    if (hasAddressUpdate) {
      // First, get existing address
      const queryMutation = `
        query getCompanyLocation($id: ID!) {
          companyLocation(id: $id) {
            id
            shippingAddress {
              address1
              address2
              city
              zip
              province
              country
            }
          }
        }
      `;

      const queryResponse = await fetch(
        `https://${shopName}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: queryMutation,
            variables: { id: locationId },
          }),
        },
      );

      const queryResult = await queryResponse.json();
      const existingLocation = queryResult.data?.companyLocation;
      const existingShipping = existingLocation?.shippingAddress || {};
      console.log("🏠 Existing address:", existingShipping);

      // Build address input object - only include fields with actual values
      const addressInput: {
        address1: string;
        address2?: string;
        city: string;
        zip: string;
        zoneCode?: string;
        countryCode: string;
      } = {
        address1:
          locationData.address1 !== undefined
            ? locationData.address1
            : existingShipping.address1 || "",
        city:
          locationData.city !== undefined
            ? locationData.city
            : existingShipping.city || "",
        zip:
          locationData.zip !== undefined
            ? locationData.zip
            : existingShipping.zip || "",
        countryCode:
          locationData.country !== undefined
            ? locationData.country
            : existingShipping.country || "US",
      };

      // Only add address2 if it exists (not empty string)
      const address2Value =
        locationData.address2 !== undefined
          ? locationData.address2
          : existingShipping.address2;
      if (address2Value && address2Value.trim() !== "") {
        addressInput.address2 = address2Value;
      }

      // Only add zoneCode if it exists and is not empty
      const provinceValue =
        locationData.province !== undefined
          ? locationData.province
          : existingShipping.province;
      if (provinceValue && provinceValue.trim() !== "") {
        addressInput.zoneCode = provinceValue;
      }

      console.log(
        "📍 Updating address:",
        JSON.stringify(addressInput, null, 2),
      );

      // Update address using companyLocationAssignAddress mutation
      const addressMutation = `
        mutation companyLocationAssignAddress($locationId: ID!, $address: CompanyAddressInput!, $addressTypes: [CompanyAddressType!]!) {
          companyLocationAssignAddress(locationId: $locationId, address: $address, addressTypes: $addressTypes) {
            addresses {
              address1
              address2
              city
              zip
              province
              country
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const addressResponse = await fetch(
        `https://${shopName}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: addressMutation,
            variables: {
              locationId: locationId,
              address: addressInput,
              addressTypes: ["BILLING", "SHIPPING"],
            },
          }),
        },
      );

      const addressResult = await addressResponse.json();
      console.log(
        "📦 Address update result:",
        JSON.stringify(addressResult, null, 2),
      );

      if (
        addressResult.data?.companyLocationAssignAddress?.userErrors?.length > 0
      ) {
        hasErrors = true;
        errors.push(
          ...addressResult.data.companyLocationAssignAddress.userErrors.map(
            (e: { message: string }) => e.message,
          ),
        );
      }
    }

    if (hasErrors) {
      return {
        error: errors[0],
        userErrors: errors,
      };
    }

    return { success: true };
  } catch (error) {
    console.error("Error updating company location:", error);
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

// Function to delete a company location
export async function deleteCompanyLocation(
  locationId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const deleteMutation = `
      mutation companyLocationDelete($companyLocationId: ID!) {
        companyLocationDelete(companyLocationId: $companyLocationId) {
          deletedCompanyLocationId
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: deleteMutation,
          variables: { companyLocationId: locationId },
        }),
      },
    );

    const result = await response.json();
    const deleteData = result.data?.companyLocationDelete;
    const userErrors = deleteData?.userErrors;

    if (userErrors && userErrors.length > 0) {
      // Check if error is related to orders
      const errorMessage = userErrors[0].message.toLowerCase();
      if (
        errorMessage.includes("order") ||
        errorMessage.includes("transaction")
      ) {
        return {
          error: {
            field: userErrors[0].field,
            message:
              "Cannot delete location with existing orders. This location has order history and cannot be removed.",
            type: "HAS_ORDERS",
          },
        };
      }

      return { error: userErrors[0] };
    }

    // Check if deletion was successful
    if (!deleteData?.deletedCompanyLocationId) {
      return {
        error: {
          field: ["companyLocationId"],
          message: "Location deletion failed - no ID returned",
        },
      };
    }

    return {
      success: true,
      deletedId: deleteData.deletedCompanyLocationId,
    };
  } catch (error) {
    console.error("Error deleting company location:", error);
    return {
      error: {
        field: ["general"],
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

// First, add this function to check if location has orders

export async function checkLocationHasOrders(
  locationId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const query = `
      query getCompanyLocationOrders($id: ID!) {
        companyLocation(id: $id) {
          id
          name
          orders(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { id: locationId },
        }),
      },
    );

    const result = await response.json();

    if (result.errors) {
      return {
        error: true,
        message: result.errors[0]?.message || "GraphQL query failed",
      };
    }

    const location = result.data?.companyLocation;

    if (!location) {
      return {
        error: true,
        message: "Location not found",
      };
    }

    const hasOrders =
      location.orders?.edges && location.orders.edges.length > 0;

    return {
      error: false,
      hasOrders: hasOrders,
      ordersCount: hasOrders ? "1 or more" : 0,
      locationName: location.name,
      totalSpent: "N/A", // Can't get exact total easily
    };
  } catch (error) {
    console.error("Error checking location orders:", error);
    return {
      error: true,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function checkLocationHasUsers(
  locationId: string,
  shopName: string,
  accessToken: string,
) {
  try {
    const query = `
      query {
        companyLocation(id: "${locationId}") {
          id
          name
          roleAssignments(first: 250) {
            edges {
              node {
                id
                companyContact {
                  customer {
                    email
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      return { error: "Failed to check location users" };
    }

    const location = data.data.companyLocation;
    const userCount = location?.roleAssignments?.edges?.length || 0;

    // Access email through customer object
    const assignedEmails =
      location?.roleAssignments?.edges
        ?.map(
          (edge: {
            node: { companyContact: { customer: { email: string } } };
          }) => edge.node.companyContact?.customer?.email,
        )
        .filter(Boolean) || [];

    return {
      hasUsers: userCount > 0,
      userCount: userCount,
      assignedEmails: assignedEmails,
      roleAssignIds:
        location?.roleAssignments?.edges?.map(
          (edge: { node: { id: string } }) => edge.node.id,
        ) || [],
      locationName: location?.name,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}
interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  purchasingEntity: {
    id: string;
    email: string;
  };
  location: {
    id: string;
    name: string;
  } | null;
  financialStatus: string;
  fulfillmentStatus: string;
}

// Function to get advanced company orders with filtering and pagination

export async function getAdvancedCompanyOrders(
  shopName: string,
  accessToken: string,
  params: {
    companyId: string;
    allowedLocationIds?: string[];
    filters: {
      locationId?: string;
      customerId?: string | string[];
      dateRange?: {
        preset?:
          | "last_week"
          | "current_month"
          | "last_month"
          | "last_3_months"
          | "custom"
          | "all";
        start?: string;
        end?: string;
      };
      financialStatus?: string;
      fulfillmentStatus?: string;
      query?: string;
      sortKey?: string;
      reverse?: boolean;
    };
  },
) {
  try {
    const { companyId, allowedLocationIds, filters } = params;

    const extractId = (id: string) => {
      if (!id) return "";
      return id.split("/").pop() || id;
    };

    const cleanCompanyId = extractId(companyId);
    const queryParts: string[] = [`company_id:${cleanCompanyId}`];

    // Track which filters need post-processing
    let needsLocationPostFilter = false;
    let requestedLocationId: string | undefined = undefined;

    // 1. Location Filter - DON'T add to GraphQL query, we'll post-filter
    if (filters.locationId) {
      // Check authorization if user has restricted access
      if (allowedLocationIds && allowedLocationIds.length > 0) {
        const hasAccess = allowedLocationIds.some(
          (id) => extractId(id) === extractId(filters.locationId!),
        );

        if (!hasAccess) {
          return {
            orders: [],
            totalCount: 0,
            error: "Unauthorized access to location",
          };
        }
      }

      // Store for post-filtering instead of adding to query
      requestedLocationId = extractId(filters.locationId);
      needsLocationPostFilter = true;
      console.log(`📍 Will post-filter by location: ${requestedLocationId}`);
    }

    // 2. Customer Filter - Support both single and multiple
    if (filters.customerId) {
      if (Array.isArray(filters.customerId) && filters.customerId.length > 0) {
        const customerQueries = filters.customerId
          .map((id) => `customer_id:${extractId(id)}`)
          .join(" OR ");
        queryParts.push(`(${customerQueries})`);
      } else if (typeof filters.customerId === "string") {
        const cleanCustomerId = extractId(filters.customerId);
        queryParts.push(`customer_id:${cleanCustomerId}`);
      }
    }

    // 3. Date Filter with all presets
    if (filters.dateRange) {
      const { preset, start, end } = filters.dateRange;
      const now = new Date();
      let dateQuery = "";

      if (preset === "last_week") {
        const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        dateQuery = `created_at:>=${lastWeek.toISOString()}`;
      } else if (preset === "current_month") {
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        dateQuery = `created_at:>=${firstDay.toISOString()}`;
      } else if (preset === "last_month") {
        const firstDayLastMonth = new Date(
          now.getFullYear(),
          now.getMonth() - 1,
          1,
        );
        const lastDayLastMonth = new Date(
          now.getFullYear(),
          now.getMonth(),
          0,
          23,
          59,
          59,
          999,
        );
        dateQuery = `created_at:>=${firstDayLastMonth.toISOString()} AND created_at:<=${lastDayLastMonth.toISOString()}`;
      } else if (preset === "last_3_months") {
        const threeMonthsAgo = new Date(
          now.getFullYear(),
          now.getMonth() - 3,
          1,
        );
        dateQuery = `created_at:>=${threeMonthsAgo.toISOString()}`;
      } else if (preset === "custom" && start && end) {
        dateQuery = `created_at:>=${start} AND created_at:<=${end}`;
      }

      if (dateQuery) {
        queryParts.push(dateQuery);
      }
    }

    // 4. Status Filters
    if (filters.financialStatus) {
      queryParts.push(`financial_status:${filters.financialStatus}`);
    }

    if (filters.fulfillmentStatus) {
      queryParts.push(`fulfillment_status:${filters.fulfillmentStatus}`);
    }

    // 5. Search Query
    if (filters.query) {
      const searchTerms = filters.query
        .split(" ")
        .filter((term) => term.length > 0);
      const searchQuery = searchTerms
        .map((term) => `name:*${term}* OR email:*${term}*`)
        .join(" OR ");
      queryParts.push(`(${searchQuery})`);
    }

    const queryString = queryParts.join(" AND ");

    const query = `
      query getOrders($query: String!) {
        orders(query: $query, first: 250, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              updatedAt
              processedAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              subtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalTaxSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                id
                firstName
                lastName
                email
                phone
              }
              purchasingEntity {
                ... on PurchasingCompany {
                  company {
                    id
                    name
                  }
                  location {
                    id
                    name
                  }
                }
              }
              note
              tags
              lineItems(first: 20) {
                edges {
                  node {
                    id
                    name
                    quantity
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    product {
                      id
                      title
                      handle
                    }
                    variant {
                      id
                      title
                      sku
                    }
                  }
                }
              }
              shippingAddress {
                firstName
                lastName
                company
                address1
                address2
                city
                province
                country
                zip
                phone
              }
              billingAddress {
                firstName
                lastName
                company
                address1
                address2
                city
                province
                country
                zip
                phone
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: {
            query: queryString,
          },
        }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      return { error: data.errors[0].message };
    }

    const ordersData = data.data?.orders;

    // Process orders and extract location information
    let processedOrders =
      ordersData?.edges?.map((edge: { node: OrderNode }) => {
        const order = edge.node;

        let locationId = "";
        let locationName = "Company Order";

        if (order.purchasingEntity?.location) {
          locationId = order.purchasingEntity.location.id;
          locationName = order.purchasingEntity.location.name;
        } else if (
          order.billingAddress?.company ||
          order.shippingAddress?.company
        ) {
          locationName =
            order.billingAddress?.company || order.shippingAddress?.company;
        }

        return {
          ...order,
          locationId,
          locationName,
          companyLocation: {
            id: locationId,
            name: locationName,
          },
        };
      }) || [];

    const originalCount = processedOrders.length;

    // POST-FILTER 1: Filter by requested specific location
    if (needsLocationPostFilter && requestedLocationId) {
      processedOrders = processedOrders.filter((order: OrderNode) => {
        const orderLocationId = extractId(order.location?.id || "");
        const matches = orderLocationId === requestedLocationId;

        if (!matches) {
          console.log(
            `🚫 Location filter: Excluded order ${order.name} (location: ${orderLocationId}, wanted: ${requestedLocationId})`,
          );
        }

        return matches;
      });

      console.log(
        `✅ Location filter (specific): ${originalCount} → ${processedOrders.length} orders`,
      );
    }
    // POST-FILTER 2: Filter by allowed locations (RBAC)
    else if (allowedLocationIds && allowedLocationIds.length > 0) {
      const normalizedAllowedIds = allowedLocationIds.map((id) =>
        extractId(id),
      );

      processedOrders = processedOrders.filter((order: OrderNode) => {
        const orderLocationId = extractId(order?.locationId);

        if (!orderLocationId) {
          console.warn(`⚠️ Order ${order.name} has no locationId, excluding`);
          return false;
        }

        const isAllowed = normalizedAllowedIds.includes(orderLocationId);

        if (!isAllowed) {
          console.log(
            `🚫 RBAC filter: Excluded order ${order.name} (location: ${orderLocationId})`,
          );
        }

        return isAllowed;
      });

      console.log(
        `✅ RBAC location filter: ${originalCount} → ${processedOrders.length} orders`,
      );
    }

    return {
      orders: processedOrders,
      totalCount: processedOrders.length,
      _debug: {
        queryString,
        fetched: ordersData?.edges?.length || 0,
        returned: processedOrders.length,
        locationFilter: requestedLocationId || "none",
        allowedLocations:
          allowedLocationIds?.map((id) => extractId(id)) || "all",
      },
    };
  } catch (error) {
    console.error("Error fetching advanced orders:", error);
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
// Function to get company orders count based on a query string
export async function getCompanyOrdersCount(
  shopName: string,
  accessToken: string,
  queryString: string,
): Promise<number> {
  const query = `
    query OrdersCount($query: String!) {
      ordersCount(query: $query) {
        count
      }
    }
  `;

  const response = await fetch(
    `https://${shopName}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { query: queryString },
      }),
    },
  );

  const data = await response.json();

  if (data.errors) {
    console.error("OrdersCount error:", data.errors);
    return 0;
  }

  return data.data?.ordersCount?.count ?? 0;
}

/**
 * Create or update a local user for a company customer
 *
 * This helper function:
 * 1. Finds the store by domain
 * 2. Finds the company account in local database by Shopify company ID
 * 3. Creates a new user or updates existing user with Shopify customer ID
 * 4. Links the user to the company and sets appropriate status/role
 *
 * @param email - Customer email
 * @param firstName - Customer first name
 * @param lastName - Customer last name
 * @param shopifyCustomerId - Shopify customer GID
 * @param shopifyCompanyId - Shopify company GID
 * @param shopName - Shop domain
 * @param userCreditLimit - Optional user credit limit
 */
async function createOrUpdateLocalUser({
  email,
  firstName,
  lastName,
  userCreditLimit,
  shopifyCustomerId,
  shopifyCompanyId,
  shopName,
}: {
  email: string;
  firstName: string;
  lastName: string;
  shopifyCustomerId: string;
  shopifyCompanyId: string;
  shopName: string;
  userCreditLimit?: number;
}) {
  // Get the store information
  const store = await getStoreByDomain(shopName);
  if (!store) {
    console.warn(`⚠️ Store not found for domain: ${shopName}`);
    return;
  }

  // Get the company account from local database
  const companyAccount = await prisma.companyAccount.findFirst({
    where: {
      shopifyCompanyId: shopifyCompanyId,
      shopId: store.id,
    },
  });

  if (!companyAccount) {
    console.warn(
      `⚠️ Company account not found for shopifyCompanyId: ${shopifyCompanyId}`,
    );
  }

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: {
      shopId_email: {
        email: email,
        shopId: store.id,
      },
    },
  });

  if (!existingUser) {
    // Create user in local database with placeholder password
    // B2B users created through Shopify don't need direct login passwords
    const newUser = await createUser({
      email: email,
      firstName: firstName,
      lastName: lastName,
      password: "", // Placeholder password for B2B users created via Shopify
      role: "STORE_USER",
      status: "APPROVED", // Auto-approve B2B users created through this flow
      shopId: store.id,
      companyId: companyAccount?.id || null,
      companyRole: "member", // Default role
      shopifyCustomerId: shopifyCustomerId, // Link to Shopify customer
      userCreditLimit: userCreditLimit || 0,
    });

    console.log(`✅ Created local user: ${newUser.id} for email: ${email},`);
  } else {
    // Update existing user with Shopify customer ID and company info if missing
    await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        shopifyCustomerId: shopifyCustomerId,
        companyId: companyAccount?.id || existingUser.companyId,
        firstName: firstName || existingUser.firstName,
        lastName: lastName || existingUser.lastName,
        userCreditLimit: userCreditLimit || existingUser.userCreditLimit,
        status: "APPROVED", // Ensure they're approved
      },
    });

    console.log(
      `✅ Updated existing local user: ${existingUser.id} with Shopify customer ID: ${shopifyCustomerId}`,
    );
  }
}
