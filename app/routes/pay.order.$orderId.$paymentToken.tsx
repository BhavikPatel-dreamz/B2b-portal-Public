import type React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "app/db.server";
import { getOrderNumber } from "app/services/sales-order-management.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  if (!params.orderId || !params.paymentToken) {
    throw new Response("Payment request not found", { status: 404 });
  }
  const order = await prisma.b2BOrder.findFirst({
    where: { id: params.orderId, paymentLinkToken: params.paymentToken },
    include: { company: { include: { shop: true } }, items: true },
  });
  if (!order) throw new Response("Payment request not found", { status: 404 });
  return Response.json({
    order: {
      orderNumber: getOrderNumber(order),
      customerName: order.customerName,
      companyName: order.company.name,
      storeName: order.company.shop.shopName || order.company.shop.shopDomain,
      logo: order.company.shop.logo,
      currencyCode: order.currencyCode,
      total: order.orderTotal.toString(),
      paid: order.paidAmount.toString(),
      balance: order.remainingBalance.toString(),
      paymentStatus: order.paymentStatus,
      items: order.items.map((item) => ({
        id: item.id,
        title: item.productTitle,
        variant: item.variantTitle,
        quantity: item.quantity,
        lineTotal: item.lineTotal.toString(),
      })),
    },
  });
};

export default function PaymentRequestPage() {
  const { order } = useLoaderData<any>();
  const money = (amount: string) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: order.currencyCode }).format(Number(amount) || 0);
  return (
    <main style={styles.page}>
      <header style={styles.header}>
        {order.logo && <img src={order.logo} alt="" style={styles.logo} />}
        <div><p style={styles.store}>{order.storeName}</p><h1 style={styles.title}>Payment request</h1><p style={styles.subtitle}>{order.orderNumber} · {order.companyName}</p></div>
        <span style={styles.badge}>{order.paymentStatus.replace(/_/g, " ")}</span>
      </header>
      <div className="payment-grid" style={styles.grid}>
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Order summary</h2>
          <p style={styles.greeting}>Hello {order.customerName || "there"}, please review the payment request below.</p>
          {order.items.length ? order.items.map((item: any) => <div key={item.id} style={styles.item}><div><strong>{item.title}</strong><small style={styles.secondary}>{item.variant || "Default"} · Qty {item.quantity}</small></div><strong>{money(item.lineTotal)}</strong></div>) : <p style={styles.secondary}>Line-item details are unavailable for this order.</p>}
        </section>
        <aside style={styles.card}><h2 style={styles.cardTitle}>Amount due</h2><Row label="Order total" value={money(order.total)} /><Row label="Paid" value={money(order.paid)} /><div style={styles.total}><strong>Balance</strong><strong>{money(order.balance)}</strong></div><p style={styles.notice}>Contact your sales representative to complete payment securely.</p></aside>
      </div>
      <style>{`@media(max-width:760px){main{padding:20px 14px!important}.payment-grid{grid-template-columns:1fr!important}}`}</style>
    </main>
  );
}
function Row({ label, value }: { label: string; value: string }) { return <div style={styles.row}><span>{label}</span><strong>{value}</strong></div>; }
const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", padding: 32, background: "#fafafa", color: "#202223", fontFamily: "'Inter', system-ui, sans-serif" },
  header: { maxWidth: 960, margin: "0 auto 24px", display: "flex", alignItems: "flex-start", gap: 14 }, logo: { width: 48, height: 48, objectFit: "contain", borderRadius: 8 }, store: { margin: 0, color: "#6d7175", fontSize: 12, fontWeight: 700, textTransform: "uppercase" }, title: { margin: "4px 0 2px", fontSize: 28 }, subtitle: { margin: 0, color: "#6d7175", fontSize: 14 }, badge: { marginLeft: "auto", padding: "5px 10px", borderRadius: 8, background: "#fef3c7", color: "#854d0e", fontSize: 12, fontWeight: 700, textTransform: "capitalize" },
  grid: { maxWidth: 960, margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 20, alignItems: "start" }, card: { background: "#fff", border: "1px solid #e1e3e5", borderRadius: 8, padding: 20 }, cardTitle: { margin: "0 0 16px", fontSize: 17 }, greeting: { color: "#4b5563", fontSize: 14 }, item: { display: "flex", justifyContent: "space-between", gap: 16, padding: "13px 0", borderBottom: "1px solid #f1f2f3", fontSize: 13 }, secondary: { display: "block", marginTop: 4, color: "#8c9196", fontSize: 12 }, row: { display: "flex", justifyContent: "space-between", padding: "7px 0", color: "#4b5563", fontSize: 13 }, total: { display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 14, borderTop: "1px solid #e1e3e5", fontSize: 18 }, notice: { margin: "18px 0 0", padding: 12, borderRadius: 8, background: "#f4f6f8", color: "#4b5563", fontSize: 13, lineHeight: 1.5 },
};
