export type SalesOrderAccessLevel = "agent" | "manager" | "admin";

export function getSalesOrderAccessLevel(
  user: { companyRole?: string | null },
): SalesOrderAccessLevel {
  const role = (user.companyRole || "").toLowerCase().replace(/[\s_-]/g, "");
  if (role.includes("admin")) return "admin";
  if (role.includes("manager") || role.includes("lead")) return "manager";
  return "agent";
}

export function getOrderNumber(order: {
  orderNumber: string | null;
  shopifyOrderId: string | null;
  id: string;
}) {
  return (
    order.orderNumber ||
    (order.shopifyOrderId
      ? `#${order.shopifyOrderId.split("/").pop()}`
      : null) ||
    `ORD-${order.id.slice(-8).toUpperCase()}`
  );
}

export function isSalesPortalPaymentLinkEligible(order: {
  source: string | null;
  paymentStatus: string;
  orderStatus: string;
}) {
  const source = (order.source || "").toLowerCase();
  return (
    (source === "sales portal" || source === "sales portal quote") &&
    order.paymentStatus.toLowerCase() === "pending" &&
    order.orderStatus.toLowerCase() !== "cancelled"
  );
}
