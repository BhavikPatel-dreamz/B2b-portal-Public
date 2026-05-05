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

    const { shop, store, companyId, customerId } = await authenticateApiProxyRequest(request);

    if (!store.accessToken) {
        return Response.json({ error: "Store access token not available" }, { status: 500 });
    }

    // Fetch orders for the specified date range and the current user
    const result = await getAdvancedCompanyOrders(shop, store.accessToken, {
      companyId,
      filters: {
        customerId,
        dateRange: filters?.dateRange || { preset: "current_month" }
      },
    });

    if (result.error) {
      console.error("getAdvancedCompanyOrders error:", result.error);
      return Response.json({ error: result.error }, { status: 500 });
    }

    const orders = result.orders || [];
    console.log(`Processing ${orders.length} orders for item report`);

    // Aggregate purchase data by Product/SKU
    const reportMap = new Map();

    for (const order of orders) {
      // Skip cancelled orders for report accuracy
      if (order.cancelledAt) continue;

      const lineItems = order.lineItems?.edges || [];
      const shippingLines = order.shippingLines?.edges || [];

      // Calculate order totals for proportional distribution
      const orderProductSubtotal = lineItems.reduce((sum: number, edge: any) => {
        const item = edge.node;
        const price = Number(item.originalUnitPriceSet?.shopMoney?.amount || 0);
        const qty = Number(item.quantity || 0);
        const discount = Number(item.totalDiscountSet?.shopMoney?.amount || 0);
        return sum + (price * qty - discount);
      }, 0);

      const totalOrderShipping = shippingLines.reduce((sum: number, edge: any) => {
        return sum + Number(edge.node.discountedPriceSet?.shopMoney?.amount || 0);
      }, 0);

      const totalOrderShippingTax = shippingLines.reduce((sum: number, edge: any) => {
        const taxLines = edge.node.taxLines || [];
        return sum + taxLines.reduce((s: number, t: any) => s + Number(t.priceSet?.shopMoney?.amount || 0), 0);
      }, 0);

      for (const edge of lineItems) {
        const item = edge.node;
        if (!item) continue;

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
        
        const originalQuantity = Number(item.quantity || 0);
        if (originalQuantity <= 0) continue;

        const originalUnitPrice = Number(item.originalUnitPriceSet?.shopMoney?.amount || 0);
        const totalDiscounts = Number(item.totalDiscountSet?.shopMoney?.amount || 0);
        
        const netLineTotal = (originalUnitPrice * originalQuantity) - totalDiscounts;
        
        // Proportional shipping distribution
        const ratio = orderProductSubtotal > 0 ? netLineTotal / orderProductSubtotal : 0;
        const distributedShipping = ratio * totalOrderShipping;
        const distributedShippingTax = ratio * totalOrderShippingTax;

        const lineTax = (item.taxLines || []).reduce((sum: number, taxLine: any) => {
          return sum + Number(taxLine.priceSet?.shopMoney?.amount || 0);
        }, 0);
        
        // Landed Values (Item + Distributed Shipping)
        const totalValue = netLineTotal + distributedShipping;
        const totalTax = lineTax + distributedShippingTax;
        const quantityPurchased = originalQuantity;
        const landedUnitPrice = totalValue / quantityPurchased;

        if (reportMap.has(key)) {
          const existing = reportMap.get(key);
          existing.quantityPurchased += quantityPurchased;
          existing.totalValue += totalValue;
          existing.totalTax += totalTax;
          existing.totalIncludingTax += (totalValue + totalTax);
        } else {
          reportMap.set(key, {
            product: fullProductName,
            sku: sku,
            quantityPurchased: quantityPurchased,
            unitPrice: landedUnitPrice,
            totalValue: totalValue,
            totalTax: totalTax,
            totalIncludingTax: totalValue + totalTax,
            currencyCode: item.totalDiscountSet?.shopMoney?.currencyCode || item.originalUnitPriceSet?.shopMoney?.currencyCode || "USD"
          });
        }
      }
    }

    const allReportData = Array.from(reportMap.values()).map((item: any) => ({
      ...item,
      // Calculate average unit price across all purchases of this item
      unitPrice: item.quantityPurchased > 0 ? item.totalValue / item.quantityPurchased : item.unitPrice
    }));
    
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
