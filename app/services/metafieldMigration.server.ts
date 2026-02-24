import prisma from "../db.server";
import { authenticate } from "../shopify.server";

interface AdminApiContext {
  graphql: (
    query: string,
    options?: { variables?: Record<string, any> },
  ) => Promise<Response>;
}

/**
 * Migration script to update company metafield keys from old naming to new naming
 * Old: credit_limit, credit_used
 * New: company_credit_limit, company_credit_used
 */
export async function migrateCompanyMetafieldKeys(admin: AdminApiContext, shopifyCompanyId: string) {
  try {
    console.log(`Starting metafield migration for company ${shopifyCompanyId}`);

    // Step 1: Query existing metafields with old keys
    const queryOldMetafields = `
      query getCompanyMetafields($ownerId: ID!) {
        metafields(ownerResource: COMPANY, first: 10, namespace: "b2b_credit", ownerId: $ownerId) {
          edges {
            node {
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    `;

    const queryResponse = await admin.graphql(queryOldMetafields, {
      variables: { ownerId: shopifyCompanyId },
    });

    const queryData = await queryResponse.json();

    if (queryData.errors) {
      throw new Error(`Failed to query metafields: ${queryData.errors[0]?.message}`);
    }

    const existingMetafields = queryData.data?.metafields?.edges || [];
    console.log(`Found ${existingMetafields.length} existing metafields`);

    // Step 2: Find old metafields and prepare new ones
    const oldCreditLimit = existingMetafields.find((edge: any) =>
      edge.node.key === "credit_limit"
    );
    const oldCreditUsed = existingMetafields.find((edge: any) =>
      edge.node.key === "credit_used"
    );

    const metafieldsToCreate = [];
    const metafieldsToDelete = [];

    if (oldCreditLimit) {
      console.log(`Found old credit_limit metafield: ${oldCreditLimit.node.value}`);
      metafieldsToCreate.push({
        ownerId: shopifyCompanyId,
        namespace: "b2b_credit",
        key: "company_credit_limit",
        value: oldCreditLimit.node.value,
        type: "number_decimal",
      });
      metafieldsToDelete.push(oldCreditLimit.node.id);
    }

    if (oldCreditUsed) {
      console.log(`Found old credit_used metafield: ${oldCreditUsed.node.value}`);
      metafieldsToCreate.push({
        ownerId: shopifyCompanyId,
        namespace: "b2b_credit",
        key: "company_credit_used",
        value: oldCreditUsed.node.value,
        type: "number_decimal",
      });
      metafieldsToDelete.push(oldCreditUsed.node.id);
    }

    // Step 3: Create new metafields if we have old ones to migrate
    if (metafieldsToCreate.length > 0) {
      const createMutation = `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const createResponse = await admin.graphql(createMutation, {
        variables: { metafields: metafieldsToCreate },
      });

      const createData = await createResponse.json();

      if (createData.errors || createData.data?.metafieldsSet?.userErrors?.length > 0) {
        const error = createData.errors?.[0]?.message ||
          createData.data?.metafieldsSet?.userErrors?.[0]?.message;
        throw new Error(`Failed to create new metafields: ${error}`);
      }

      console.log(`✅ Created ${metafieldsToCreate.length} new metafields with updated keys`);

      // Step 4: Delete old metafields
      for (const metafieldId of metafieldsToDelete) {
        const deleteMutation = `
          mutation metafieldDelete($input: MetafieldDeleteInput!) {
            metafieldDelete(input: $input) {
              deletedId
              userErrors {
                field
                message
              }
            }
          }
        `;

        const deleteResponse = await admin.graphql(deleteMutation, {
          variables: {
            input: { id: metafieldId }
          },
        });

        const deleteData = await deleteResponse.json();

        if (deleteData.errors || deleteData.data?.metafieldDelete?.userErrors?.length > 0) {
          const error = deleteData.errors?.[0]?.message ||
            deleteData.data?.metafieldDelete?.userErrors?.[0]?.message;
          console.warn(`Warning: Failed to delete old metafield ${metafieldId}: ${error}`);
        } else {
          console.log(`✅ Deleted old metafield ${metafieldId}`);
        }
      }

      return {
        success: true,
        message: `Migrated ${metafieldsToCreate.length} metafields to new naming convention`,
        migratedFields: metafieldsToCreate.length,
      };
    } else {
      console.log(`No old metafields found to migrate for company ${shopifyCompanyId}`);
      return {
        success: true,
        message: "No migration needed - no old metafields found",
        migratedFields: 0,
      };
    }

  } catch (error) {
    console.error(`Error migrating metafields for company ${shopifyCompanyId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      migratedFields: 0,
    };
  }
}

/**
 * Migrate all companies' metafields to new naming convention
 */
export async function migrateAllCompanyMetafields() {
  try {
    console.log("🚀 Starting metafield migration for all companies");

    // Get all companies with Shopify company IDs
    const companies = await prisma.companyAccount.findMany({
      where: {
        shopifyCompanyId: { not: null },
      },
      include: {
        shop: {
          select: { shopDomain: true },
        },
      },
    });

    console.log(`Found ${companies.length} companies with Shopify company IDs`);

    const results = [];

    for (const company of companies) {
      if (!company.shopifyCompanyId || !company.shop?.shopDomain) {
        console.warn(`Skipping company ${company.id} - missing Shopify data`);
        continue;
      }

      try {
        const { admin } = await authenticate.admin(company.shop.shopDomain);

        const result = await migrateCompanyMetafieldKeys(
          admin,
          company.shopifyCompanyId
        );

        results.push({
          companyId: company.id,
          companyName: company.name,
          shopifyCompanyId: company.shopifyCompanyId,
          ...result,
        });

        console.log(`✅ Migration completed for ${company.name}: ${result.message}`);
      } catch (error) {
        console.error(`❌ Migration failed for company ${company.name}:`, error);
        results.push({
          companyId: company.id,
          companyName: company.name,
          shopifyCompanyId: company.shopifyCompanyId,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          migratedFields: 0,
        });
      }
    }

    const successful = results.filter(r => r.success);
    const totalMigrated = results.reduce((sum, r) => sum + r.migratedFields, 0);

    console.log(`🎉 Migration completed: ${successful.length}/${results.length} companies successful, ${totalMigrated} fields migrated`);

    return {
      success: true,
      totalCompanies: results.length,
      successfulCompanies: successful.length,
      totalMigratedFields: totalMigrated,
      results,
    };
  } catch (error) {
    console.error("❌ Error in bulk metafield migration:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      results: [],
    };
  }
}
