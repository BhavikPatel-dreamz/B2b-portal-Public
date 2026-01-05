import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import { calculateAvailableCredit } from "../../services/creditService";
import prisma from "../../db.server";

interface CreditStatusRequest {
  companyId: string;
  shop: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    await authenticate.public.appProxy(request);

    const requestData: CreditStatusRequest = await request.json();
    const { companyId, shop } = requestData;

    // Validate required fields
    if (!companyId || !shop) {
      return Response.json(
        {
          error: "Missing required fields: companyId, shop",
        },
        { status: 400 }
      );
    }

    // Get store
    const store = await getStoreByDomain(shop);
    if (!store || !store.accessToken) {
      return Response.json({ error: "Store not found" }, { status: 404 });
    }

    // Get company
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        contactName: true,
        contactEmail: true,
        creditLimit: true,
        shopId: true,
        createdAt: true,
      },
    });

    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }

    if (company.shopId !== store.id) {
      return Response.json(
        { error: "Company does not belong to this store" },
        { status: 403 }
      );
    }

    // Calculate credit availability
    const creditInfo = await calculateAvailableCredit(companyId);

    if (!creditInfo) {
      return Response.json(
        { error: "Unable to calculate credit information" },
        { status: 500 }
      );
    }

    // Get order statistics
    const [totalOrders, paidOrders, unpaidOrders, pendingOrders] = await Promise.all([
      // Total orders (excluding cancelled)
      prisma.b2BOrder.count({
        where: {
          companyId,
          orderStatus: { not: "cancelled" },
        },
      }),
      // Fully paid orders
      prisma.b2BOrder.count({
        where: {
          companyId,
          paymentStatus: "paid",
          orderStatus: { not: "cancelled" },
        },
      }),
      // Unpaid or partially paid orders
      prisma.b2BOrder.count({
        where: {
          companyId,
          paymentStatus: { in: ["pending", "partial"] },
          orderStatus: { not: "cancelled" },
        },
      }),
      // Pending orders (draft, submitted, processing)
      prisma.b2BOrder.count({
        where: {
          companyId,
          orderStatus: { in: ["draft", "submitted", "processing"] },
        },
      }),
    ]);

    // Calculate credit percentage used
    const creditPercentageUsed =
      company.creditLimit.toNumber() > 0
        ? ((creditInfo.usedCredit.toNumber() + creditInfo.pendingCredit.toNumber()) /
            company.creditLimit.toNumber()) *
          100
        : 0;

    return Response.json(
      {
        success: true,
        company: {
          id: company.id,
          name: company.name,
          contactName: company.contactName,
          contactEmail: company.contactEmail,
          createdAt: company.createdAt,
        },
        credit: {
          creditLimit: creditInfo.creditLimit.toNumber(),
          availableCredit: creditInfo.availableCredit.toNumber(),
          usedCredit: creditInfo.usedCredit.toNumber(),
          pendingCredit: creditInfo.pendingCredit.toNumber(),
          creditPercentageUsed: Math.round(creditPercentageUsed * 100) / 100, // Round to 2 decimals
        },
        orders: {
          total: totalOrders,
          paid: paidOrders,
          unpaid: unpaidOrders,
          pending: pendingOrders,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error fetching company credit status:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};
