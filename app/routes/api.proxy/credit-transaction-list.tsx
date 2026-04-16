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

    const companydata = await prisma.companyAccount.findFirst({
      where: { shopifyCompanyId: companyId },
      select: { id: true, name: true },
    });

    // ── Single call, returns enriched transactions ───────────
    const creditTransactions = await getCreditTransactionsByCompany(companydata?.id!);

    return Response.json({ success: true, data: creditTransactions });

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