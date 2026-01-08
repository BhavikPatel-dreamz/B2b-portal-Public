import { Prisma, UserRole, UserStatus } from "@prisma/client";
import prisma from "../db.server";
import { sendCompanyWelcomeEmail } from "../services/notification.server";

/**
 * Sync Shopify B2B companies to local database
 * Fetches all companies from Shopify, imports contact data, and sends notifications
 * SERVER ONLY - Uses Prisma and admin context
 */
export const syncShopifyCompanies = async (
  admin: any,
  store: any,
  submissionEmail: string | null,
) => {
  try {
    // Step 1: Fetch all Shopify B2B companies with pagination
    let allCompanies: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const companiesQuery = `
        query GetAllCompanies($cursor: String) {
          companies(first: 100, after: $cursor) {
            nodes {
              id
              name
              externalId
              mainContact {
                id
                customer {
                  id
                  email
                  firstName
                  lastName
                  phone
                }
              }
              locations(first: 1) {
                nodes {
                  id
                  name
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const response = await admin.graphql(companiesQuery, {
        variables: { cursor },
      });
      const result = await response.json();
      const data = result?.data?.companies;

      if (data?.nodes) {
        allCompanies = [...allCompanies, ...data.nodes];
      }

      hasNextPage = data?.pageInfo?.hasNextPage || false;
      cursor = data?.pageInfo?.endCursor || null;
    }

    let syncedCount = 0;
    const errors: string[] = [];
    // Collect all Shopify company IDs
    const shopifyCompanyIds = allCompanies.map(company => company.id);

    // Step 2-5: Process each company
    for (const company of allCompanies) {
      try {
        const companyName = company.name;
        const mainContact = company.mainContact?.customer;

        // Check if user exists
        if (mainContact?.email) {
          const shopifyCustomerId = mainContact.id;

          // Upsert company data to Prisma
          const upsertedCompany = await prisma.companyAccount.upsert({
            where: {
              shopId_shopifyCompanyId: {
                shopId: store.id,
                shopifyCompanyId: company.id,
              },
            },
            update: {
              name: companyName,
              contactName: mainContact.firstName
                ? `${mainContact.firstName} ${mainContact.lastName || ""}`.trim()
                : null,
              contactEmail: mainContact.email,
            },
            create: {
              shopId: store.id,
              shopifyCompanyId: company.id,
              name: companyName,
              contactName: mainContact.firstName
                ? `${mainContact.firstName} ${mainContact.lastName || ""}`.trim()
                : null,
              contactEmail: mainContact.email,
              creditLimit: new Prisma.Decimal(0),
            },
          });

          // Ensure the company's main contact exists as a store admin user
          await prisma.user.upsert({
            where: { shopId_email: { shopId: store.id, email: mainContact.email } },
            update: {
              firstName: mainContact.firstName || null,
              lastName: mainContact.lastName || null,
              shopifyCustomerId,
              shopId: store.id,
              companyId: upsertedCompany.id,
              companyRole: "admin",
              role: UserRole.STORE_ADMIN,
              status: UserStatus.APPROVED,
              isActive: true,
            },
            create: {
              email: mainContact.email,
              firstName: mainContact.firstName || null,
              lastName: mainContact.lastName || null,
              password: "", // Placeholder password; Shopify-auth users don't log in directly
              shopifyCustomerId,
              shopId: store.id,
              companyId: upsertedCompany.id,
              companyRole: "admin",
              role: UserRole.STORE_ADMIN,
              status: UserStatus.APPROVED,
              isActive: true,
            },
          });

          // Send welcome email if email is configured
          if (
            submissionEmail &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submissionEmail)
          ) {
            try {
              await sendCompanyWelcomeEmail(
                submissionEmail,
                companyName,
                mainContact.firstName || "Customer",
              );
            } catch (emailError) {
              console.error("Failed to send email:", emailError);
            }
          }

          syncedCount++;
        }
      } catch (companyError) {
        console.error(`Error syncing company:`, companyError);
        errors.push(
          `Failed to sync ${company.name}: ${companyError instanceof Error ? companyError.message : "Unknown error"}`,
        );
      }
    }

    // Step 6: Delete companies that don't exist in Shopify anymore
    try {
      const deleteResult = await prisma.companyAccount.deleteMany({
        where: {
          shopId: store.id,
          shopifyCompanyId: {
            not: null,
            notIn: shopifyCompanyIds,
          },
        },
      });

      console.log(`Deleted ${deleteResult.count} companies that no longer exist in Shopify`);

      if (deleteResult.count > 0) {
        return {
          success: true,
          syncedCount,
          deletedCount: deleteResult.count,
          errors,
          message:
            errors.length > 0
              ? `Synced ${syncedCount} companies, deleted ${deleteResult.count} companies with ${errors.length} errors`
              : `Successfully synced ${syncedCount} companies and deleted ${deleteResult.count} obsolete companies`,
        };
      }
    } catch (deleteError) {
      console.error("Error deleting obsolete companies:", deleteError);
      errors.push(
        `Failed to delete obsolete companies: ${deleteError instanceof Error ? deleteError.message : "Unknown error"}`,
      );
    }

    return {
      success: true,
      syncedCount,
      deletedCount: 0,
      errors,
      message:
        errors.length > 0
          ? `Synced ${syncedCount} companies with ${errors.length} errors`
          : `Successfully synced ${syncedCount} companies`,
    };
  } catch (error) {
    console.error("Sync error:", error);
    return {
      success: false,
      syncedCount: 0,
      deletedCount: 0,
      errors: [
        error instanceof Error ? error.message : "Unknown sync error occurred",
      ],
      message: "Sync failed",
    };
  }
};

/**
 * Parse form data from request
 * SERVER ONLY
 */
export const parseForm = async (request: Request) => {
  const formData = await request.formData();
  return Object.fromEntries(formData);
};

/**
 * Parse and validate credit limit value
 */
export const parseCredit = (value?: string) => {
  if (!value) return new Prisma.Decimal(0);
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return new Prisma.Decimal(numeric);
};

/**
 * Sync Shopify B2B customers/users to local database
 * Fetches customers with B2B access, creates/updates User records
 * SERVER ONLY - Uses Prisma and admin context
 */
export const syncShopifyUsers = async (
  admin: any,
  store: any,
  companyId?: string,
) => {
  try {
    // Fetch all customers with B2B company contact profiles
    let allCustomers: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const customersQuery = `
        query GetB2BCustomers($cursor: String) {
          customers(first: 100, after: $cursor, query: "has_company_contact_profile:true") {
            nodes {
              id
              email
              firstName
              lastName
              phone
              companyContactProfiles {
                id
                company {
                  id
                  name
                  mainContact {
                    id
                    customer {
                      id
                    }
                  }
                }
                title
                roleAssignments(first: 10) {
                  edges {
                    node {
                      role {
                        name
                      }
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
      `;

      const response = await admin.graphql(customersQuery, {
        variables: { cursor },
      });
      const result = await response.json();
      const data = result?.data?.customers;

      if (data?.nodes) {
        allCustomers = [...allCustomers, ...data.nodes];
      }

      hasNextPage = data?.pageInfo?.hasNextPage || false;
      cursor = data?.pageInfo?.endCursor || null;
    }

    let syncedCount = 0;
    const errors: string[] = [];

    // Get the shopify company ID if filtering by company
    let targetShopifyCompanyId: string | null = null;
    if (companyId) {
      const localCompany = await prisma.companyAccount.findUnique({
        where: { id: companyId },
        select: { shopifyCompanyId: true },
      });
      if (!localCompany) {
        return {
          success: false,
          syncedCount: 0,
          errors: ["Company not found"],
          message: "Company not found",
        };
      }
      targetShopifyCompanyId = localCompany.shopifyCompanyId;
    }

    // Process each customer with B2B company profiles
    for (const customer of allCustomers) {
      try {
        if (!customer.email) continue;

        const customerGid = customer.id; // Already a GID from Shopify
        const profiles = customer.companyContactProfiles || [];

        // For each company profile this customer has, create/update a user
        for (const profile of profiles) {
          try {
            const shopifyCompanyId = profile.company?.id;
            if (!shopifyCompanyId) continue;

            // If filtering by company, skip profiles that don't match
            if (targetShopifyCompanyId && shopifyCompanyId !== targetShopifyCompanyId) {
              continue;
            }

            // Find the company in our local DB
            const localCompany = await prisma.companyAccount.findFirst({
              where: {
                shopId: store.id,
                shopifyCompanyId: shopifyCompanyId,
              },
              select: { id: true },
            });

            if (!localCompany) continue;

            // Determine company role from Shopify role assignments
            let companyRole = "member";
            const roles = profile.roleAssignments?.edges || [];
            if (roles.some((r: any) => r.node?.role?.name?.includes("Admin"))) {
              companyRole = "admin";
            } else if (roles.some((r: any) => r.node?.role?.name?.includes("Approver"))) {
              companyRole = "approver";
            }

            // Check if this customer is the main contact of the company
            const isMainContact = profile.company?.mainContact?.customer?.id === customerGid;
            const userRole = isMainContact ? "STORE_ADMIN" : "STORE_USER";

            // Upsert user in local DB
            await prisma.user.upsert({
              where: { shopId_email: { shopId: store.id, email: customer.email } },
              update: {
                firstName: customer.firstName || null,
                lastName: customer.lastName || null,
                shopifyCustomerId: customerGid,
                companyId: localCompany.id,
                companyRole,
                shopId: store.id,
                status: "APPROVED",
                isActive: true,
                role: userRole,
              },
              create: {
                email: customer.email,
                firstName: customer.firstName || null,
                lastName: customer.lastName || null,
                password: "", // B2B users register themselves
                role: userRole,
                status: "APPROVED",
                isActive: true,
                shopId: store.id,
                companyId: localCompany.id,
                companyRole,
                shopifyCustomerId: customerGid,
              },
            });

            syncedCount++;
          } catch (profileError) {
            console.error(`Error syncing user profile:`, profileError);
            errors.push(
              `Failed to sync profile for ${customer.email}: ${profileError instanceof Error ? profileError.message : "Unknown error"}`,
            );
          }
        }
      } catch (customerError) {
        console.error(`Error syncing customer:`, customerError);
        errors.push(
          `Failed to sync ${customer.email}: ${customerError instanceof Error ? customerError.message : "Unknown error"}`,
        );
      }
    }

    return {
      success: true,
      syncedCount,
      errors,
      message:
        errors.length > 0
          ? `Synced ${syncedCount} users with ${errors.length} errors`
          : `Successfully synced ${syncedCount} users`,
    };
  } catch (error) {
    console.error("Sync error:", error);
    return {
      success: false,
      syncedCount: 0,
      errors: [
        error instanceof Error ? error.message : "Unknown sync error occurred",
      ],
      message: "Sync failed",
    };
  }
};
