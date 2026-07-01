import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyWithPermissions } from "../../utils/proxy.server";
import prisma from "app/db.server";
import { getCreditTransactionsByCompany } from "app/services/company.server";
import { calculateAvailableCredit } from "app/services/creditService";

// ============================================================
// 📦 LOADER — GET request
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();
  try {
    const { companyId, store, shop } = await authenticateApiProxyWithPermissions(request);

    if (!store.accessToken) {
      return Response.json({ error: "Store access token not available" }, { status: 500 });
    }

    const url = new URL(request.url);
    const page  = Math.max(1, parseInt(url.searchParams.get("page")  ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)));
    const skip  = (page - 1) * limit;

    const companydata = await prisma.companyAccount.findFirst({
      where: { shopifyCompanyId: companyId },
      select: { id: true, name: true, creditLimit: true },
    });

    if (!companydata) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }

    const companyAccountId = companydata.id;

    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    // ── Fetch total count, transactions, credit info, and current month balance in parallel ──
    const [total, creditTransactions, creditInfo, currentMonthAggregation] = await Promise.all([
      prisma.creditTransaction.count({
        where: { companyId: companyAccountId },
      }),
      getCreditTransactionsByCompany(companyAccountId, {
        take: limit,
        skip,
        shop,
        accessToken: store.accessToken,
      }),
      calculateAvailableCredit(companyAccountId),
      prisma.creditTransaction.aggregate({
        where: {
          companyId: companyAccountId,
          createdAt: { gte: firstDayOfMonth },
        },
        _sum: {
          creditAmount: true,
        },
      }),
    ]);

    const summary = {
      totalAssignCredit: companydata.creditLimit.toNumber(),
      usedCredit: creditInfo?.usedCredit.toNumber() ?? 0,
      availableCredit: creditInfo?.availableCredit.toNumber() ?? 0,
      currentMonthBalance: currentMonthAggregation._sum.creditAmount?.toNumber() ?? 0,
    };

    return Response.json({
      success: true,
      data: creditTransactions,
      summary,
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