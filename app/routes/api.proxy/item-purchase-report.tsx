import { authenticateApiProxyRequest } from "app/utils/proxy.server";
import { getAdvancedCompanyOrders } from "app/utils/b2b-customer.server";
import { type ActionFunctionArgs } from "react-router";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { filters, pagination } = body;
    const page = Number(pagination?.page || 1);
    const limit = Number(pagination?.limit || 20);
    const searchQuery = filters?.query?.toLowerCase() || "";
    const dateRangePreset = filters?.dateRange?.preset || "current_month";

    const { shop, store, companyId } = await authenticateApiProxyRequest(request);

    if (!store.accessToken) {
        return Response.json({ error: "Store access token not available" }, { status: 500 });
    }

    // Fetch orders for the specified date range
    const result = await getAdvancedCompanyOrders(shop, store.accessToken, {
      companyId,
      filters: {
        dateRange: filters?.dateRange || { preset: "current_month" }
      },
    });

    if (result.error) {
      return Response.json({ error: result.error }, { status: 500 });
    }

    const orders = result.orders || [];

    // Aggregate purchase data by Product/SKU
    const reportMap = new Map();

    for (const order of orders) {
      const lineItems = order.lineItems?.edges || [];
      for (const edge of lineItems) {
        const item = edge.node;
        const sku = item.variant?.sku || "No SKU";
        const productName = item.product?.title || item.name;
        const variantName = item.variant?.title && item.variant.title !== "Default Title" 
          ? ` - ${item.variant.title}` 
          : "";
        const fullProductName = `${productName}${variantName}`;
        
        // Apply text filter (Product name or SKU)
        if (searchQuery && 
            !fullProductName.toLowerCase().includes(searchQuery) && 
            !sku.toLowerCase().includes(searchQuery)) {
          continue;
        }

        const productId = item.product?.id || "Unknown Product";
        const key = `${productId}-${sku}`;
        const quantity = Number(item.quantity || 0);
        const price = Number(item.originalUnitPriceSet?.shopMoney?.amount || 0);
        const totalValue = quantity * price;

        if (reportMap.has(key)) {
          const existing = reportMap.get(key);
          existing.quantityPurchased += quantity;
          existing.totalValue += totalValue;
        } else {
          reportMap.set(key, {
            product: fullProductName,
            sku: sku,
            quantityPurchased: quantity,
            totalValue: totalValue,
            currencyCode: item.originalUnitPriceSet?.shopMoney?.currencyCode || "USD"
          });
        }
      }
    }

    const allReportData = Array.from(reportMap.values());
    
    // Sort by quantity purchased (descending) by default
    allReportData.sort((a, b) => b.quantityPurchased - a.quantityPurchased);

    // Manual Pagination
    const totalCount = allReportData.length;
    const totalPages = Math.ceil(totalCount / limit);
    const startIndex = (page - 1) * limit;
    const paginatedData = allReportData.slice(startIndex, startIndex + limit);

    return Response.json({
      success: true,
      data: paginatedData,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      filters: {
        query: searchQuery,
        dateRange: dateRangePreset
      }
    });

  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Error generating item purchase report:", error);
    return Response.json(
      { error: "Failed to generate report", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
};
