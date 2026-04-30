import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyRequest } from "../../utils/proxy.server";

/**
 * Loader function to handle GET requests for current user company information
 * Used by the useCurrentUser hook
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Authenticate the proxy request and get company info
    const { customerId, companyInfo } = await authenticateApiProxyRequest(request);

    // Return the company information
    return Response.json({
      success: true,
      hasCompany: true,
      customerId,
      customerName: companyInfo.customerName,
      customerEmail: companyInfo.customerEmail,

      // Credit
      CreditLimit: companyInfo.CreditLimit,
      usedCredit: companyInfo.usedCredit,
      pendingCredit: companyInfo.pendingCredit,
      availableCredit: companyInfo.availableCredit,
      creditUsagePercentage: companyInfo.creditUsagePercentage,

      // Stats
      currentMonthOrderCount: companyInfo.currentMonthOrderCount,
      pendingDraftOrderCount: companyInfo.pendingDraftOrderCount,
      currentMonthUsedCredit: companyInfo.currentMonthUsedCredit,
      totalLocationCount: companyInfo.totalLocationCount,
      userCount: companyInfo.userCount,
      currencyCode: companyInfo.companies?.[0]?.totalSpent?.currencyCode || "USD",

      // Access Flags
      isAdmin: companyInfo.isAdmin,
      isMainContact: companyInfo.isMainContact,

      companies: companyInfo.companies,
    });
  } catch (error) {
    if (error instanceof Response) throw error;

    console.error("Error fetching customer company info:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        hasCompany: false,
      },
      { status: 500 },
    );
  }
};

/**
 * Action function to handle POST requests (e.g. for quick summary updates)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // Authenticate the proxy request and get company info
    const { companyInfo } = await authenticateApiProxyRequest(request);

    // Use the first company for summary data
    const company = companyInfo.companies[0];

    // Format currency for total spend
    const currency = company.totalSpent?.currencyCode || "USD";
    const amount = company.totalSpent?.amount || 0;
    const formattedSpend = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency,
    }).format(Number(amount));

    return Response.json({
      success: true,
      companyName: company.companyName,
      ordersCount: companyInfo.currentMonthOrderCount,
      totalSpend: formattedSpend,
      currencyCode: currency,
      locationsCount: company.locationsCount,
      isAdmin: companyInfo.isAdmin,
      isMainContact: companyInfo.isMainContact,
    });
  } catch (error) {
    if (error instanceof Response) throw error;

    console.error("Proxy action error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
};
