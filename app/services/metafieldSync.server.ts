import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { Decimal } from "@prisma/client/runtime/library";

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
        value: user.companyId,
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

    // Update customer metafields
    const mutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            metafields(first: 20) {
              edges {
                node {
                  id
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

    const customerInput = {
      id: customerId,
      metafields: metafields.map(field => ({
        namespace: field.namespace,
        key: field.key,
        value: field.value,
        type: field.type,
      })),
    };

    const response = await admin.graphql(mutation, {
      variables: { input: customerInput },
    });

    const data = await response.json();

    if (data.errors || data.data?.customerUpdate?.userErrors?.length > 0) {
      const error = data.errors?.[0]?.message || data.data?.customerUpdate?.userErrors?.[0]?.message;
      throw new Error(`Failed to update customer metafields: ${error}`);
    }

    return { success: true, data: data.data?.customerUpdate?.customer };

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

    // Calculate used credit
    const usedCredit = await prisma.b2BOrder.aggregate({
      where: {
        companyId,
        paymentStatus: { in: ['pending', 'partial'] },
        orderStatus: { notIn: ['cancelled'] },
      },
      _sum: {
        remainingBalance: true,
      },
    });

    const creditUsed = usedCredit._sum.remainingBalance || new Decimal(0);

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
        value: creditUsed.toString(),
        type: 'number_decimal',
      },
    ];

    // Update company metafields
    const mutation = `
      mutation companyUpdate($companyId: ID!, $input: CompanyInput!) {
        companyUpdate(companyId: $companyId, input: $input) {
          company {
            id
            metafields(first: 20) {
              edges {
                node {
                  id
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

    const companyInput = {
      metafields: metafields.map(field => ({
        namespace: field.namespace,
        key: field.key,
        value: field.value,
        type: field.type,
      })),
    };

    const response = await admin.graphql(mutation, {
      variables: {
        companyId: company.shopifyCompanyId,
        input: companyInput
      },
    });

    const data = await response.json();

    if (data.errors || data.data?.companyUpdate?.userErrors?.length > 0) {
      const error = data.errors?.[0]?.message || data.data?.companyUpdate?.userErrors?.[0]?.message;
      throw new Error(`Failed to update company metafields: ${error}`);
    }

    return { success: true, data: data.data?.companyUpdate?.company };

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

    // Sync company metafields
    const companyResult = await syncCompanyCreditMetafields(
      admin,
      user.companyId
    );

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
          select: { domain: true }
        }
      },
    });

    if (!company?.shop?.domain) {
      throw new Error('Company shop not found');
    }

    const results = [];

    // Sync metafields for each user
    for (const user of users) {
      if (user.shopifyCustomerId) {
        const result = await syncAllCreditMetafields(
          company.shop.domain,
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
