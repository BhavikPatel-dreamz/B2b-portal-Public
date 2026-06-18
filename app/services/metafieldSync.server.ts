import prisma from "../db.server";
import { getAdminForShop } from "../shopify.server";
import { calculateAvailableCredit } from "./tieredCreditService";

/**
 * Sync credit data to Shopify metafields
 * This allows the checkout extension to read credit limits without external API calls
 */

interface MetafieldUpdate {
  namespace: string;
  key: string;
  value: string;
  type: string;
}
interface AdminApiContext {
  graphql: (
    query: string,
    options?: { variables?: Record<string, string> },
  ) => Promise<Response>;
}

/**
 * Create or update customer metafields for credit information
 */
export async function syncCustomerCreditMetafields(
  admin: AdminApiContext,
  customerId: string,
  userId: string,
) {
  try {
    // Get user credit info from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        userCreditLimit: true,
        userCreditUsed: true,
        companyId: true,
      },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Prepare metafields to update
    const metafields: MetafieldUpdate[] = [
      {
        namespace: "custom",
        key: "is_b2b_customer",
        value: "true",
        type: "single_line_text_field",
      },
      {
        namespace: "custom",
        key: "company_id",
        value: user.companyId || "",
        type: "single_line_text_field",
      },
      {
        namespace: "custom",
        key: "user_credit_used",
        value: user.userCreditUsed.toString(),
        type: "number_decimal",
      },
    ];

    // Add user credit limit if it exists
    if (user.userCreditLimit) {
      metafields.push({
        namespace: "custom",
        key: "user_credit_limit",
        value: user.userCreditLimit.toString(),
        type: "number_decimal",
      });
    }

    // Update customer metafields using metafieldsSet mutation
    const mutation = `
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

    const metafieldInputs = metafields.map((field) => ({
      ownerId: customerId,
      namespace: field.namespace,
      key: field.key,
      value: field.value,
      type: field.type,
    }));

    const response = await admin.graphql(mutation, {
      variables: { metafields: metafieldInputs },
    });

    const data = await response.json();

    if (data.errors || data.data?.metafieldsSet?.userErrors?.length > 0) {
      const error =
        data.errors?.[0]?.message ||
        data.data?.metafieldsSet?.userErrors?.[0]?.message;
      throw new Error(`Failed to update customer metafields: ${error}`);
    }

    return { success: true, data: data.data?.metafieldsSet?.metafields };
  } catch (error: { message: string }) {
    console.error("Error syncing customer credit metafields:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Create or update company metafields for credit information
 */
export async function syncCompanyCreditMetafields(
  admin: AdminApiContext,
  companyId: string,
) {
  try {
    // Get company credit info from database
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      select: {
        creditLimit: true,
        shopifyCompanyId: true,
      },
    });

    if (!company || !company.shopifyCompanyId) {
      throw new Error("Company not found or no Shopify company ID");
    }

    // Calculate available credit
    const creditData = await calculateAvailableCredit(companyId);

    if (!creditData) {
      throw new Error("Unable to calculate credit data");
    }

    const availableCredit = creditData.availableCredit;
    const usedCredit = company.creditLimit.sub(availableCredit);

    // Prepare metafields
    const metafields: MetafieldUpdate[] = [
      {
        namespace: "custom",
        key: "company_credit_limit",
        value: company.creditLimit.toString(),
        type: "number_decimal",
      },
      {
        namespace: "custom",
        key: "company_credit_used",
        value: usedCredit.toString(),
        type: "number_decimal",
      },
    ];

    // Update company metafields using metafieldsSet mutation
    const mutation = `
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

    const metafieldInputs = metafields.map((field) => ({
      ownerId: company.shopifyCompanyId,
      namespace: field.namespace,
      key: field.key,
      value: field.value,
      type: field.type,
    }));

    const response = await admin.graphql(mutation, {
      variables: {
        metafields: metafieldInputs,
      },
    });

    const data = await response.json();

    const userErrors = data.data?.metafieldsSet?.userErrors;
    const errorMessage =
      data.errors?.[0]?.message ||
      userErrors?.find((err: any) => err?.message)?.message ||
      (userErrors?.length ? JSON.stringify(userErrors) : undefined) ||
      (data.errors ? JSON.stringify(data.errors) : undefined);

    if (data.errors || userErrors?.length > 0 || !data.data?.metafieldsSet) {
      throw new Error(
        `Failed to update company metafields: ${errorMessage || "Unknown metafieldsSet response"}`,
      );
    }

    return { success: true, data: data.data?.metafieldsSet?.metafields };
  } catch (error: { message: string }) {
    console.error("Error syncing company credit metafields:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Sync both customer and company credit metafields
 */
export async function syncAllCreditMetafields(
  shop: string,
  customerId: string,
  userId: string,
  admin?: AdminApiContext,
) {
  try {
    if (!shop) {
      throw new Error("Invalid shop domain");
    }

    // Use provided admin context or authenticate
    const shopifyAdmin = admin || (await getAdminForShop(shop));

    // Get user to find company
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Update customer and company metafields using a single metafieldsSet mutation
    const company = user.companyId
      ? await prisma.companyAccount.findUnique({
          where: { id: user.companyId },
          select: { creditLimit: true, shopifyCompanyId: true },
        })
      : null;

    let companyMetafields: MetafieldUpdate[] = [];
    if (company && company.shopifyCompanyId) {
      const creditData = await calculateAvailableCredit(user.companyId!);
      if (creditData) {
        const availableCredit = creditData.availableCredit;
        const usedCredit = company.creditLimit.sub(availableCredit);
        companyMetafields = [
          {
            namespace: "custom",
            key: "company_credit_limit",
            value: company.creditLimit.toString(),
            type: "number_decimal",
          },
          {
            namespace: "custom",
            key: "company_credit_used",
            value: usedCredit.toString(),
            type: "number_decimal",
          },
        ];
      }
    }

    const mutation = `
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

    const metafieldInputs = [
      ...metafields.map((field) => ({
        ownerId: customerId,
        namespace: field.namespace,
        key: field.key,
        value: field.value,
        type: field.type,
      })),
      ...companyMetafields.map((field) => ({
        ownerId: company!.shopifyCompanyId!,
        namespace: field.namespace,
        key: field.key,
        value: field.value,
        type: field.type,
      })),
    ];

    const response = await shopifyAdmin.graphql(mutation, {
      variables: { metafields: metafieldInputs },
    });

    const data = await response.json();

    if (data.errors || data.data?.metafieldsSet?.userErrors?.length > 0) {
      const error =
        data.errors?.[0]?.message ||
        data.data?.metafieldsSet?.userErrors?.[0]?.message;
      throw new Error(`Failed to update metafields: ${error}`);
    }

    return {
      success: true,
      customer: {
        success: true,
        data: data.data?.metafieldsSet?.metafields.filter(
          (m: any) => m.ownerId === customerId,
        ),
      },
      company: company
        ? {
            success: true,
            data: data.data?.metafieldsSet?.metafields.filter(
              (m: any) => m.ownerId === company.shopifyCompanyId,
            ),
          }
        : { success: true },
    };
  } catch (error: unknown) {
    console.error("Error syncing all credit metafields:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Auto-sync metafields when credit data changes
 * Call this function whenever credit limits or usage changes
 */
export async function autoSyncCreditMetafields(
  companyId: string,
  userId?: string,
) {
  try {
    // Get all users in the company if specific user not provided
    // If specific user is provided, fetch their shopifyCustomerId
    const users = await prisma.user.findMany({
      where: {
        companyId,
        isActive: true,
        id: userId || undefined,
        shopifyCustomerId: { not: null },
      },
      select: {
        id: true,
        shopifyCustomerId: true,
      },
    });

    if (users.length === 0) {
      return { success: true, syncedUsers: 0, results: [] };
    }

    // Get company info
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      select: {
        shop: {
          select: { shopDomain: true },
        },
      },
    });

    if (!company?.shop?.shopDomain) {
      throw new Error("Company shop not found");
    }

    // Authenticate once for all users
    const admin = await getAdminForShop(company.shop.shopDomain);

    // Sync metafields for each user in parallel
    const syncPromises = users.map(async (user) => {
      const result = await syncAllCreditMetafields(
        company.shop.shopDomain,
        user.shopifyCustomerId!,
        user.id,
        admin as any,
      );
      return { userId: user.id, result };
    });

    const results = await Promise.all(syncPromises);

    return {
      success: results.every((r) => r.result.success),
      syncedUsers: results.length,
      results,
    };
  } catch (error: any) {
    console.error("Error in auto-sync credit metafields:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
      syncedUsers: 0,
      results: [],
    };
  }
}

/**
 * Sync the store's plan to the Shop metafields
 */
export async function syncStorePlanToShopMetafields(
  admin: any,
  shopDomain: string,
) {
  try {
    const store = await prisma.store.findUnique({
      where: { shopDomain },
      select: { plan: true },
    });

    // Map internal plan names to extension-expected values
    let planValue = "free";
    if (
      store?.plan === "approved payment" ||
      store?.plan === "Paid subscription"
    ) {
      planValue = "approved payment";
    } else if (
      store?.plan === "usage subscription" ||
      store?.plan === "Usage subscription"
    ) {
      planValue = "usage subscription";
    }

    const mutation = `
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

    // Fetch Shop ID
    const shopQuery = `
      query {
        shop {
          id
        }
      }
    `;
    const shopResponse = await admin.graphql(shopQuery);
    const shopData = await shopResponse.json();
    const shopId = shopData.data?.shop?.id;

    if (!shopId) {
      throw new Error("Could not fetch Shop ID");
    }

    const response = await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "custom",
            key: "store_plan",
            value: planValue,
            type: "single_line_text_field",
          },
        ],
      },
    });

    const data = await response.json();
    console.log(
      "Shop plan metafield sync response:",
      data.data?.metafieldsSet?.metafields,
    );

    if (data.errors || data.data?.metafieldsSet?.userErrors?.length > 0) {
      const error =
        data.errors?.[0]?.message ||
        data.data?.metafieldsSet?.userErrors?.[0]?.message;
      throw new Error(`Failed to update shop plan metafield: ${error}`);
    }

    return { success: true, plan: planValue };
  } catch (error: any) {
    console.error("Error syncing shop plan metafield:", error);
    return { success: false, error: error.message };
  }
}
