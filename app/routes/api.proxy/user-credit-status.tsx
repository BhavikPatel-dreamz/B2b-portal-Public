import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getUserCreditSummary } from "../../services/tieredCreditService";

interface UserCreditStatusRequest {
  userId: string;
  shop: string;
}

/**
 * Get detailed credit status for a specific user including both personal and company limits
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    await authenticate.public.appProxy(request);

    const requestData: UserCreditStatusRequest = await request.json();
    const { userId, shop } = requestData;

    // Validate required fields
    if (!userId || !shop) {
      return Response.json(
        {
          error: "Missing required fields: userId, shop",
        },
        { status: 400 }
      );
    }

    // Get comprehensive user credit summary
    const creditSummary = await getUserCreditSummary(userId);

    if (!creditSummary) {
      return Response.json(
        { error: "User not found or not associated with a company" },
        { status: 404 }
      );
    }

    return Response.json({
      success: true,
      user: {
        id: creditSummary.user.id,
        name: creditSummary.user.name,
        email: creditSummary.user.email,
        personalCredit: {
          limit: creditSummary.user.userCreditLimit?.toNumber() || null,
          used: creditSummary.user.userCreditUsed.toNumber(),
          available: creditSummary.user.hasUserLimit
            ? creditSummary.creditInfo.user.userCreditAvailable.toNumber()
            : null,
          hasLimit: creditSummary.user.hasUserLimit,
          status: creditSummary.user.hasUserLimit
            ? (creditSummary.creditInfo.user.userCreditAvailable.greaterThan(0) ? "active" : "exceeded")
            : "unlimited",
        },
      },
      company: {
        id: creditSummary.company.id,
        name: creditSummary.company.name,
        totalCredit: {
          limit: creditSummary.company.creditLimit.toNumber(),
          used: creditSummary.creditInfo.company.usedCredit.toNumber(),
          pending: creditSummary.creditInfo.company.pendingCredit.toNumber(),
          available: creditSummary.creditInfo.company.availableCredit.toNumber(),
          status: creditSummary.creditInfo.company.availableCredit.greaterThan(0) ? "active" : "exceeded",
        },
      },
      recentOrders: creditSummary.recentOrders.map(order => ({
        id: order.id,
        total: order.orderTotal.toNumber(),
        userCreditUsed: order.userCreditUsed.toNumber(),
        status: order.orderStatus,
        paymentStatus: order.paymentStatus,
        createdAt: order.createdAt.toISOString(),
      })),
      summary: {
        canPlaceOrders: creditSummary.creditInfo.company.availableCredit.greaterThan(0) &&
                       (!creditSummary.user.hasUserLimit ||
                        creditSummary.creditInfo.user.userCreditAvailable.greaterThan(0)),
        primaryLimitingFactor: creditSummary.creditInfo.company.availableCredit.lessThanOrEqualTo(0)
          ? "company"
          : (creditSummary.user.hasUserLimit &&
             creditSummary.creditInfo.user.userCreditAvailable.lessThanOrEqualTo(0))
            ? "user"
            : "none",
      },
    });
  } catch (error) {
    console.error("Error getting user credit status:", error);
    return Response.json(
      { error: "Failed to get credit status" },
      { status: 500 }
    );
  }
};
