import { authenticateApiProxyRequest } from "app/utils/proxy.server";
import { getAdvancedCompanyOrders } from "app/utils/b2b-customer.server";
import { type ActionFunctionArgs } from "react-router";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { filters } = body;
    const dateRange = filters?.dateRange || { preset: "current_month" };
    
    const { shop, store, companyId, customerId } = await authenticateApiProxyRequest(request);

    if (!store.accessToken) {
      return Response.json({ error: "Store access token not available" }, { status: 500 });
    }

    // Fetch orders for the specified range (entire company)
    const result = await getAdvancedCompanyOrders(shop, store.accessToken, {
      companyId,
      filters: {
        dateRange,
      },
    });

    if (result.error) {
      return Response.json({ error: result.error }, { status: 500 });
    }

    const orders = result.orders || [];

    // Determine aggregation type (daily or monthly)
    // We'll calculate the duration in days
    let isMonthlyAggregation = false;
    const monthlyPresets = ["all", "all_time", "last_year"];
    
    if (monthlyPresets.includes(dateRange.preset)) {
      isMonthlyAggregation = true;
    } else if (dateRange.preset === "custom" && dateRange.start && dateRange.end) {
      const start = new Date(dateRange.start);
      const end = new Date(dateRange.end);
      const diffTime = Math.abs(end.getTime() - start.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays > 90) { // Approx 3 months
        isMonthlyAggregation = true;
      }
    } else {
      // Default to daily for other presets (today, yesterday, last_7_days, last_30_days, last_3_months, last_month, this_month)
      isMonthlyAggregation = false;
    }

    const aggregationMap = new Map();

    for (const order of orders) {
      // Skip cancelled orders for report accuracy
      if (order.cancelledAt) continue;

      const date = new Date(order.createdAt);
      let key = "";
      
      if (isMonthlyAggregation) {
        // YYYY-MM
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      } else {
        // YYYY-MM-DD
        key = date.toISOString().split("T")[0];
      }

      const amount = Number(order.totalPriceSet?.shopMoney?.amount || 0);

      if (aggregationMap.has(key)) {
        aggregationMap.set(key, aggregationMap.get(key) + amount);
      } else {
        aggregationMap.set(key, amount);
      }
    }

    // Convert map to sorted array
    const chartData = Array.from(aggregationMap.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return Response.json({
      success: true,
      aggregationType: isMonthlyAggregation ? "monthly" : "daily",
      data: chartData,
      currencyCode: orders[0]?.totalPriceSet?.shopMoney?.currencyCode || "USD"
    });

  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Error generating spend report:", error);
    return Response.json(
      { error: "Failed to generate report", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
};
