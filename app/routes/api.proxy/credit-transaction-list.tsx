import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyWithPermissions } from "../../utils/proxy.server";
import prisma from "app/db.server";
import { getCreditTransactionsByCompany } from "app/services/company.server";

// ============================================================
// 📦 LOADER — GET request
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();
  try {
    const { companyId, store } = await authenticateApiProxyWithPermissions(request);

    if (!store.accessToken) {
      return Response.json({ error: "Store access token not available" }, { status: 500 });
    }

    const url = new URL(request.url);
    const page  = Math.max(1, parseInt(url.searchParams.get("page")  ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)));
    const skip  = (page - 1) * limit;

    const companydata = await prisma.companyAccount.findFirst({
      where: { shopifyCompanyId: companyId },
      select: { id: true, name: true },
    });

    const companyAccountId = companydata?.id!;

    // ── Total count for pagination meta ─────────────────────
    const total = await prisma.creditTransaction.count({
      where: { companyId: companyAccountId },
    });

    // ── Paginated enriched transactions from DB ──────────────────────
    const dbTransactions = await getCreditTransactionsByCompany(companyAccountId, {
      take: limit,
      skip,
    });

    // ── REAL-TIME: Fetch recent orders from Shopify to bridge the webhook gap ─
    // We only do this for the first page to keep it fast
    let finalTransactions = [...dbTransactions];
    
    if (page === 1) {
      try {
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const shopifyUrl = `https://${store.shopDomain}/admin/api/2025-01/graphql.json`;
        const shopifyRes = await fetch(shopifyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": store.accessToken,
          },
          body: JSON.stringify({
            query: `
              query ($companyId: ID!, $processedAt: String) {
                orders(first: 20, query: "purchasing_entity_id:$companyId created_at:>=$processedAt") {
                  edges {
                    node {
                      id
                      name
                      createdAt
                      displayFinancialStatus
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
              }
            `,
            variables: { 
              companyId: companyId, // Shopify GID
              processedAt: startOfMonth.toISOString()
            },
          }),
        });

        const shopifyData = await shopifyRes.json();
        const shopifyOrders = shopifyData?.data?.orders?.edges || [];

        // Check which Shopify orders are missing from our DB transactions
        const existingOrderIds = new Set(
          dbTransactions.map((tx) => tx.orderId).filter(Boolean)
        );

        const missingTransactions = shopifyOrders
          .filter((edge: any) => {
            const order = edge.node;
            const isUnpaid = ["PENDING", "PARTIALLY_PAID"].includes(order.displayFinancialStatus);
            return isUnpaid && !existingOrderIds.has(order.id);
          })
          .map((edge: any) => {
            const order = edge.node;
            return {
              id: `virtual-${order.id}`,
              companyId: companyAccountId,
              orderId: order.id,
              transactionType: "order_created",
              creditAmount: new Decimal(order.totalPriceSet.shopMoney.amount).negated(),
              previousBalance: new Decimal(0), // We don't know the exact balance without a full crawl
              newBalance: new Decimal(0),
              notes: `Order ${order.name} (Syncing...)`,
              createdBy: "Shopify Checkout",
              createdByName: order.customer 
                ? `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim() || order.customer.email
                : "Customer",
              createdAt: new Date(order.createdAt),
              isVirtual: true,
            };
          });

        if (missingTransactions.length > 0) {
          finalTransactions = [...missingTransactions, ...finalTransactions]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, limit);
        }
      } catch (err) {
        console.warn("⚠️ Failed to fetch real-time orders for transaction list:", err);
      }
    }

    return Response.json({
      success: true,
      data: finalTransactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    });

  } catch (error) {
    console.error("Loader error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  } finally {
    console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
  }
};