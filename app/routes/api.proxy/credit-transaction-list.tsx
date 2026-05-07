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
    // Authenticate and get company context
    const { companyAccountId, store, companyInfo } = await authenticateApiProxyWithPermissions(request);

    if (!store.accessToken) {
      return Response.json({ error: "Store access token not available" }, { status: 500 });
    }

    const url = new URL(request.url);
    const page  = Math.max(1, parseInt(url.searchParams.get("page")  ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)));
    const skip  = (page - 1) * limit;

    // ── Total count for company-wide transactions ─────────────────────
    const total = await prisma.creditTransaction.count({
      where: { companyId: companyAccountId },
    });

    // ── Paginated enriched transactions (all for company) ──────────────
    const creditTransactions = await getCreditTransactionsByCompany(companyAccountId, {
      take: limit,
      skip,
      orderBy: { createdAt: "desc" },
    });

    // We want to return company-wide stats even for Ordering Only users
    let summary = {
      totalAssignCredit: companyInfo.CreditLimit,
      usedCredit: companyInfo.usedCredit,
      availableCredit: companyInfo.availableCredit,
      currentMonthBalance: (companyInfo as any).companyCurrentMonthUsedCredit ?? companyInfo.currentMonthUsedCredit,
    };

    // If the user is Ordering Only, companyInfo.currentMonthUsedCredit might be personal.
    // However, the transaction list summary should typically show company-wide status.
    // If we need to ensure company-wide current month balance, we could recalculate it here.

    return Response.json({
      success: true,
      data: creditTransactions,
      summary,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    });

  } catch (error) {
    console.error("❌ Credit Transaction List Loader error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  } finally {
    console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
  }
};