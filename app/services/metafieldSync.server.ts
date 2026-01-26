import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { Decimal } from "@prisma/client/runtime/library";
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

/**
 * Create or update customer metafields for credit information
 */
export async function syncCustomerCreditMetafields(
  admin: any,
  customerId: string,
  userId: string
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
      throw new Error('User not found');
    }

    // Prepare metafields to update
    const metafields: MetafieldUpdate[] = [
      {
        namespace: 'b2b_credit',
        key: 'is_b2b_customer',
        value: 'true',
        type: 'single_line_text_field',
      },
      {
        namespace: 'b2b_credit',
        key: 'company_id',
        value: user.companyId || '',
        type: 'single_line_text_field',
      },
      {
        namespace: 'b2b_credit',
        key: 'user_credit_used',
        value: user.userCreditUsed.toString(),
        type: 'number_decimal',
      },
    ];

    // Add user credit limit if it exists
    if (user.userCreditLimit) {
      metafields.push({
        namespace: 'b2b_credit',
        key: 'user_credit_limit',
        value: user.userCreditLimit.toString(),
        type: 'number_decimal',
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

    const metafieldInputs = metafields.map(field => ({
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
      const error = data.errors?.[0]?.message || data.data?.metafieldsSet?.userErrors?.[0]?.message;
      throw new Error(`Failed to update customer metafields: ${error}`);
    }

    return { success: true, data: data.data?.metafieldsSet?.metafields };

  } catch (error: any) {
    console.error('Error syncing customer credit metafields:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Create or update company metafields for credit information
 */
export async function syncCompanyCreditMetafields(
  admin: any,
  companyId: string
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
      throw new Error('Company not found or no Shopify company ID');
    }

    // Calculate available credit
    const creditData = await calculateAvailableCredit(companyId);

    if (!creditData) {
      throw new Error('Unable to calculate credit data');
    }

    const availableCredit = creditData.availableCredit;
    const usedCredit = company.creditLimit.sub(availableCredit);

    // Prepare metafields
    const metafields: MetafieldUpdate[] = [
      {
        namespace: 'b2b_credit',
        key: 'credit_limit',
        value: company.creditLimit.toString(),
        type: 'number_decimal',
      },
      {
        namespace: 'b2b_credit',
        key: 'credit_used',
        value: usedCredit.toString(),
        type: 'number_decimal',
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

    const metafieldInputs = metafields.map(field => ({
      ownerId: company.shopifyCompanyId,
      namespace: field.namespace,
      key: field.key,
      value: field.value,
      type: field.type,
    }));

    const response = await admin.graphql(mutation, {
      variables: {
        metafields: metafieldInputs
      },
    });

    const data = await response.json();
    console.log('Company metafield sync response:', data.data?.metafieldsSet?.metafields);

    if (data.errors || data.data?.metafieldsSet?.userErrors?.length > 0) {
      const error = data.errors?.[0]?.message || data.data?.metafieldsSet?.userErrors?.[0]?.message;
      throw new Error(`Failed to update company metafields: ${error}`);
    }

    return { success: true, data: data.data?.metafieldsSet?.metafields };

  } catch (error: any) {
    console.error('Error syncing company credit metafields:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Sync both customer and company credit metafields
 */
export async function syncAllCreditMetafields(
  shop: string,
  customerId: string,
  userId: string
) {

  try {
    if (!shop) {
      return Response.json({
        success: false,
        error: 'Invalid shop domain',
      });
    }
    const { admin } = await authenticate.admin(shop);

    // Get user to find company
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Sync customer metafields
    const customerResult = await syncCustomerCreditMetafields(
      admin,
      customerId,
      userId
    );

    if (!customerResult.success) {
      return {
        success: false,
        error: customerResult.error,
        customer: customerResult,
        company: { success: false },
      };
    }
    // Sync company metafields
    let companyResult;
    if (user.companyId) {
      companyResult = await syncCompanyCreditMetafields(admin, user.companyId);
    } else {
      companyResult = {
        success: true,
        message: 'User not associated with a company, skipping company sync.',
      };
    }

    return {
      success: customerResult.success && companyResult.success,
      customer: customerResult,
      company: companyResult,
    };

  } catch (error: any) {
    console.error('Error syncing all credit metafields:', error);
    return {
      success: false,
      error: error.message,
      customer: { success: false },
      company: { success: false },
    };
  }
}

/**
 * Auto-sync metafields when credit data changes
 * Call this function whenever credit limits or usage changes
 */
export async function autoSyncCreditMetafields(
  companyId: string,
  userId?: string
) {
  try {
    // Get all users in the company if specific user not provided
    const users = userId
      ? [{ id: userId, shopifyCustomerId: null }]
      : await prisma.user.findMany({
          where: {
            companyId,
            isActive: true,
            shopifyCustomerId: { not: null },
          },
          select: {
            id: true,
            shopifyCustomerId: true,
          },
        });

    // Get company info
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      select: {
        shop: {
          select: { shopDomain: true }
        }
      },
    });
    if (!company?.shop?.shopDomain) {
      throw new Error('Company shop not found');
    }

    const results = [];

    // Sync metafields for each user
    for (const user of users) {
      if (user.shopifyCustomerId) {
        const result = await syncAllCreditMetafields(
          company.shop.shopDomain,
          user.shopifyCustomerId,
          user.id
        );
        results.push({ userId: user.id, result });
      }
    }

    return {
      success: true,
      syncedUsers: results.length,
      results,
    };

  } catch (error: any) {
    console.error('Error in auto-sync credit metafields:', error);
    return {
      success: false,
      error: error.message,
      syncedUsers: 0,
      results: [],
    };
  }
}
