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

    // ── Paginated enriched transactions ──────────────────────
    const creditTransactions = await getCreditTransactionsByCompany(companyAccountId, {
      take: limit,
      skip,
    });

    return Response.json({
      success: true,
      data: creditTransactions,
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