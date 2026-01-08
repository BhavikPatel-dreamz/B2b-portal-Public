import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { validateTieredCreditForOrder } from "../../services/tieredCreditService";
import prisma from "../../db.server";

interface CreditValidationRequest {
  companyId: string;
  userId: string;
  orderAmount: number;
  shop: string;
}

/**
 * Validate credit for add-to-cart and checkout scenarios
 * Returns detailed credit information for both company and user levels
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    await authenticate.public.appProxy(request);

    const requestData: CreditValidationRequest = await request.json();
    const { companyId, userId, orderAmount, shop } = requestData;

    // Validate required fields
    if (!companyId || !userId || orderAmount === undefined || !shop) {
      return Response.json(
        {
          error: "Missing required fields: companyId, userId, orderAmount, shop",
        },
        { status: 400 }
      );
    }

    // Validate user belongs to company
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        companyId,
        isActive: true,
        status: "APPROVED",
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        userCreditLimit: true,
        userCreditUsed: true,
        company: {
          select: {
            id: true,
            name: true,
            creditLimit: true,
          },
        },
      },
    });

    if (!user || !user.company) {
      return Response.json(
        { error: "User not found or not authorized for this company" },
        { status: 403 }
      );
    }

    // Perform tiered credit validation
    const validation = await validateTieredCreditForOrder(
      companyId,
      userId,
      orderAmount
    );

    return Response.json({
      success: true,
      canCreateOrder: validation.canCreate,
      limitingFactor: validation.limitingFactor,
      message: validation.message,
      user: {
        id: user.id,
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        email: user.email,
        creditLimit: user.userCreditLimit?.toNumber() || null,
        creditUsed: user.userCreditUsed.toNumber(),
        creditAvailable: validation.creditInfo?.user.userCreditAvailable.toNumber() || null,
        hasUserLimit: validation.creditInfo?.user.hasUserLimit || false,
      },
      company: {
        id: user.company.id,
        name: user.company.name,
        creditLimit: validation.creditInfo?.company.creditLimit.toNumber() || 0,
        creditUsed: validation.creditInfo?.company.usedCredit.toNumber() || 0,
        creditAvailable: validation.creditInfo?.company.availableCredit.toNumber() || 0,
      },
      orderAmount,
      validationDetails: {
        companyCreditSufficient: validation.creditInfo 
          ? validation.creditInfo.company.availableCredit.greaterThanOrEqualTo(orderAmount)
          : false,
        userCreditSufficient: validation.creditInfo
          ? !validation.creditInfo.user.hasUserLimit || 
            validation.creditInfo.user.userCreditAvailable.greaterThanOrEqualTo(orderAmount)
          : false,
      },
    });
  } catch (error) {
    console.error("Error validating tiered credit:", error);
    return Response.json(
      { error: "Failed to validate credit" },
      { status: 500 }
    );
  }
};