import { Prisma } from "@prisma/client";
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

    // Step 2-5: Process each company
    for (const company of allCompanies) {
      try {
        const companyName = company.name;
        const mainContact = company.mainContact?.customer;

        // Check if user exists
        if (mainContact?.email) {
          // Upsert company data to Prisma
          await prisma.companyAccount.upsert({
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

    return {
      success: true,
      syncedCount,
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
