import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { countCompanies } from "../services/company.server";
import { countRegistrations } from "../services/registration.server";
import prisma from "../db.server";

interface LoaderData {
  totalCompanies: number;
  pendingRegistrations: number;
  approvedRegistrations: number;
  rejectedRegistrations: number;
  totalUsers: number;
  totalOrders: number;
  totalCreditAllowed: number;
  totalCreditUsed: number;
  availableCredit: number;
  pendingCreditAmount: number;
  totalOrderValue: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Get the store based on the session
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  // Fetch all the statistics

    const totalOrders = await prisma.b2BOrder.groupBy({
        by: ["shopifyOrderId"],
        where: {
          orderStatus: {
            not: "cancelled",
          },
          shopId: store.id,
        },
        _count: {
          shopifyOrderId: true,
        },
      });
    


  const [totalCompanies, pendingRegistrations, approvedRegistrations, rejectedRegistrations, totalUsers] = await Promise.all([
    countCompanies(store.id),
    countRegistrations(store.id, "PENDING"),
    countRegistrations(store.id, "APPROVED"),
    countRegistrations(store.id, "REJECTED"),
    prisma.user.count({ where: { shopId: store.id } }),
  ]);

  // Fetch credit statistics
  const creditStats = await prisma.companyAccount.aggregate({
    where: { shopId: store.id },
    _sum: {
      creditLimit: true,
    },
  });

  // Calculate total used credit from all unpaid orders (new business logic)
  // All unpaid orders are considered "used credit" regardless of status
  const usedCreditStats = await prisma.b2BOrder.aggregate({
    where: {
      shopId: store.id,
      paymentStatus: { in: ["pending", "partial"] }, // All unpaid orders
      orderStatus: { notIn: ["cancelled"] }, // Exclude cancelled orders
    },
    _sum: {
      remainingBalance: true, // Use remainingBalance instead of creditUsed
    },
  });

  // With the new logic, pending credit is always 0
  // All unpaid orders are counted as "used credit"
  const pendingCreditAmount = 0;

  const totalCreditAllowed = Number(creditStats._sum.creditLimit || 0);
  const totalCreditUsed = Number(usedCreditStats._sum.remainingBalance || 0);
  const availableCredit = totalCreditAllowed - totalCreditUsed;

  return {
    totalCompanies,
    pendingRegistrations,
    approvedRegistrations,
    rejectedRegistrations,
    totalUsers,
    totalOrders:totalOrders.length,
    totalCreditAllowed,
    totalCreditUsed,
    availableCredit,
    pendingCreditAmount,
  };
};




export default function Index() {
  const data = useLoaderData<LoaderData>();

  // Credit statistics calculations
  const creditUsagePercentage = data.totalCreditAllowed > 0
    ? Math.round((data.totalCreditUsed / data.totalCreditAllowed) * 100)
    : 0;
  const pendingCreditPercentage = data.totalCreditAllowed > 0
    ? Math.round((data.pendingCreditAmount / data.totalCreditAllowed) * 100)
    : 0;
  const availableCreditPercentage = data.totalCreditAllowed > 0
    ? Math.round((data.availableCredit / data.totalCreditAllowed) * 100)
    : 100;

  // Credit management statistics
  const creditStatsData = [
    {
      label: 'Total Credit Allowed',
      value: `$${data.totalCreditAllowed.toLocaleString()}`,
      description: 'Total credit limit across all companies',
      tone: 'info' as const,
      percentage: 100
    },
    {
      label: 'Credit Used',
      value: `$${data.totalCreditUsed.toLocaleString()}`,
      description: `${creditUsagePercentage}% of total credit`,
      tone: creditUsagePercentage > 80 ? 'critical' as const : creditUsagePercentage > 60 ? 'warning' as const : 'success' as const,
      percentage: creditUsagePercentage
    },
    {
      label: 'Available Credit',
      value: `$${data.availableCredit.toLocaleString()}`,
      description: `${availableCreditPercentage}% remaining`,
      tone: availableCreditPercentage < 20 ? 'critical' as const : availableCreditPercentage < 40 ? 'warning' as const : 'success' as const,
      percentage: availableCreditPercentage
    }
    // {
    //   label: 'Pending Credit',
    //   value: `$${data.pendingCreditAmount.toLocaleString()}`,
    //   description: `${pendingCreditPercentage}% awaiting payment`,
    //   tone: pendingCreditPercentage > 30 ? 'warning' as const : 'info' as const,
    //   percentage: pendingCreditPercentage
    // },
  ];

  // Company registration statistics
  const companyStatsData = [
    {
      label: 'Total Companies Registered',
      value: data.totalCompanies.toString(),
      description: 'Active companies in your B2B portal',
      tone: 'info' as const
    },
    {
      label: 'Pending Registrations',
      value: data.pendingRegistrations.toString(),
      description: 'Applications awaiting approval',
      tone: 'warning' as const
    },
    {
      label: 'Approved Registrations',
      value: data.approvedRegistrations.toString(),
      description: 'Successfully approved applications',
      tone: 'success' as const
    },
    {
      label: 'Total B2B Users',
      value: data.totalUsers.toString(),
      description: 'Active users across all companies',
      tone: 'info' as const
    },
  ];

  const orderStatsData = [
    {
      label: 'Total B2B Orders',
      value: data.totalOrders.toString(),
      description: 'Orders processed through B2B portal',
      tone: 'info' as const
    },
    {
      label: 'Rejected Applications',
      value: data.rejectedRegistrations.toString(),
      description: 'Declined registration requests',
      tone: 'critical' as const
    },
  ];

  return (
    <s-page heading="B2B Portal Dashboard">
      {/* Credit Management Overview */}
      <s-section>
        <s-stack direction="block" gap="large">
          <s-text variant="headingLg" weight="bold">Credit Management Overview</s-text>
          <s-stack direction="inline" gap="base" wrap="wrap">
            {creditStatsData.map((stat, index) => (
              <s-card key={index} style={{ flex: '1 1 calc(25% - 12px)', minWidth: '250px' }}>
                <s-stack direction="block" gap="small">
                  <s-text variant="bodyMd" tone="subdued">{stat.label}</s-text>
                  <s-text variant="heading2xl" weight="bold">{stat.value}</s-text>
                  <s-badge tone={stat.tone}>{stat.description}</s-badge>
                  {/* Simple progress bar visualization */}
                  <div style={{
                    width: '100%',
                    height: '8px',
                    backgroundColor: '#f1f2f3',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    marginTop: '8px'
                  }}>
                    <div style={{
                      width: `${Math.min(stat.percentage, 100)}%`,
                      height: '100%',
                      backgroundColor: stat.tone === 'success' ? '#008060' :
                                      stat.tone === 'warning' ? '#ffc453' :
                                      stat.tone === 'critical' ? '#d73e3e' : '#5c6ac4',
                      transition: 'width 0.3s ease'
                    }}></div>
                  </div>
                  <s-text variant="bodySm" tone="subdued">{stat.percentage}%</s-text>
                </s-stack>
              </s-card>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      {/* Credit Summary Chart */}
      <s-section>
        <s-card>
          <s-stack direction="block" gap="base">
            <s-text variant="headingMd" weight="bold">Credit Utilization Summary</s-text>
            <s-stack direction="inline" gap="large">
              <div style={{ flex: '1' }}>
                <s-stack direction="block" gap="small">
                  <s-text variant="bodyMd">Credit Distribution</s-text>
                  <div style={{
                    display: 'flex',
                    height: '40px',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: '1px solid #e1e3e5'
                  }}>
                    <div
                      style={{
                        width: `${creditUsagePercentage}%`,
                        backgroundColor: '#d73e3e',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'white',
                        fontSize: '12px',
                        fontWeight: 'bold'
                      }}
                      title={`Used: $${data.totalCreditUsed.toLocaleString()}`}
                    >
                      {creditUsagePercentage > 15 ? `${creditUsagePercentage}%` : ''}
                    </div>
                    <div
                      style={{
                        width: `${pendingCreditPercentage}%`,
                        backgroundColor: '#ffc453',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'black',
                        fontSize: '12px',
                        fontWeight: 'bold'
                      }}
                      title={`Pending: $${data.pendingCreditAmount.toLocaleString()}`}
                    >
                      {pendingCreditPercentage > 10 ? `${pendingCreditPercentage}%` : ''}
                    </div>
                    <div
                      style={{
                        width: `${availableCreditPercentage}%`,
                        backgroundColor: '#008060',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'white',
                        fontSize: '12px',
                        fontWeight: 'bold'
                      }}
                      title={`Available: $${data.availableCredit.toLocaleString()}`}
                    >
                      {availableCreditPercentage > 15 ? `${availableCreditPercentage}%` : ''}
                    </div>
                  </div>
                </s-stack>
              </div>
              <div style={{ flex: '1' }}>
                <s-stack direction="block" gap="small">
                  <s-text variant="bodyMd">Legend</s-text>
                  <s-stack direction="block" gap="tiny">
                    <s-stack direction="inline" gap="small" alignment="center">
                      <div style={{ width: '16px', height: '16px', backgroundColor: '#d73e3e', borderRadius: '2px' }}></div>
                      <s-text variant="bodySm">Used Credit: ${data.totalCreditUsed.toLocaleString()}</s-text>
                    </s-stack>
                    {/* <s-stack direction="inline" gap="small" alignment="center">
                      <div style={{ width: '16px', height: '16px', backgroundColor: '#ffc453', borderRadius: '2px' }}></div>
                      <s-text variant="bodySm">Pending Credit: ${data.pendingCreditAmount.toLocaleString()}</s-text>
                    </s-stack> */}
                    <s-stack direction="inline" gap="small" alignment="center">
                      <div style={{ width: '16px', height: '16px', backgroundColor: '#008060', borderRadius: '2px' }}></div>
                      <s-text variant="bodySm">Available Credit: ${data.availableCredit.toLocaleString()}</s-text>
                    </s-stack>
                  </s-stack>
                </s-stack>
              </div>
            </s-stack>
          </s-stack>
        </s-card>
      </s-section>

      {/* Company Registration Overview */}
      <s-section>
        <s-stack direction="block" gap="large">
          <s-text variant="headingLg" weight="bold">Company Registration Overview</s-text>
          <s-stack direction="inline" gap="base" wrap="wrap">
            {companyStatsData.map((stat, index) => (
              <s-card key={index} style={{ flex: '1 1 calc(25% - 12px)', minWidth: '220px' }}>
                <s-stack direction="block" gap="small">
                  <s-text variant="bodyMd" tone="subdued">{stat.label}</s-text>
                  <s-text variant="heading2xl" weight="bold">{stat.value}</s-text>
                  <s-badge tone={stat.tone}>{stat.description}</s-badge>
                </s-stack>
              </s-card>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      {/* Additional Statistics */}
      <s-section>
        <s-stack direction="block" gap="large">
          <s-text variant="headingLg" weight="bold">Additional Statistics</s-text>
          <s-stack direction="inline" gap="base" wrap="wrap">
            {orderStatsData.map((stat, index) => (
              <s-card key={index} style={{ flex: '1 1 calc(50% - 12px)', minWidth: '220px' }}>
                <s-stack direction="block" gap="small">
                  <s-text variant="bodyMd" tone="subdued">{stat.label}</s-text>
                  <s-text variant="heading2xl" weight="bold">{stat.value}</s-text>
                  <s-badge tone={stat.tone}>{stat.description}</s-badge>
                </s-stack>
              </s-card>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      {/* Quick Actions */}
      <s-section>
  <s-stack direction="block" gap="base">
    <s-text variant="headingLg" weight="bold">Quick Actions</s-text>
    <s-stack direction="inline" gap="base">
      <Link to="/app/companies">
        <s-button variant="primary">
          View All Companies
        </s-button>
      </Link>
      <Link to="/app/registrations">
        <s-button variant="secondary">
          Review Pending Registrations
        </s-button>
      </Link>
    </s-stack>
  </s-stack>
</s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
