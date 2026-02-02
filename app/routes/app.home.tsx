import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { countCompanies } from "../services/company.server";
import { countRegistrations } from "../services/registration.server";
import prisma from "../db.server";


type LoaderData = {
  totalCompanies?: number;
  pendingRegistrations?: number;
  approvedRegistrations?: number;
  rejectedRegistrations?: number;
  totalUsers?: number;
  totalOrders?: number;
  totalCreditAllowed?: number;
  totalCreditUsed?: number;
  availableCredit?: number;
  pendingCreditAmount?: number;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Try to authenticate the session
    const { session } = await authenticate.admin(request);

    // Get the store based on the session
    const store = await prisma.store.findUnique({
      where: { shopDomain: session.shop },
    });
    console.log(store, "store in dashboard");
    // If no store found, return unauthenticated state
    if (!store?.shopDomain) {
    return Response.json({
       message: "Store not found",
      });
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

    const [
      totalCompanies,
      pendingRegistrations,
      approvedRegistrations,
      rejectedRegistrations,
      totalUsers,
    ] = await Promise.all([
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

    // Calculate total used credit from all unpaid orders
    const usedCreditStats = await prisma.b2BOrder.aggregate({
      where: {
        shopId: store.id,
        paymentStatus: { in: ["pending", "partial"] },
        orderStatus: { notIn: ["cancelled"] },
      },
      _sum: {
        remainingBalance: true,
      },
    });

    const pendingCreditAmount = 0;
    const totalCreditAllowed = Number(creditStats._sum.creditLimit || 0);
    const totalCreditUsed = Number(usedCreditStats._sum.remainingBalance || 0);
    const availableCredit = totalCreditAllowed - totalCreditUsed;

    return Response.json({
      totalCompanies,
      pendingRegistrations,
      approvedRegistrations,
      rejectedRegistrations,
      totalUsers,
      totalOrders: totalOrders.length,
      totalCreditAllowed,
      totalCreditUsed,
      availableCredit,
      pendingCreditAmount,
    });
  } catch (error) {
    // If authentication fails, return unauthenticated state
    console.error("Authentication error:", error);
    return Response.json({
      message: "Authentication failed",
    });
  }
};

export default function Home() {
  const data = useLoaderData<LoaderData>();

  // Credit statistics calculations
  const creditUsagePercentage =
    data.totalCreditAllowed > 0
      ? Math.round((data.totalCreditUsed / data.totalCreditAllowed) * 100)
      : 0;
  // const pendingCreditPercentage =
  //   data.totalCreditAllowed > 0
  //     ? Math.round((data.pendingCreditAmount / data.totalCreditAllowed) * 100)
  //     : 0;
  // const availableCreditPercentage =
  //   data.totalCreditAllowed > 0
  //     ? Math.round((data.availableCredit / data.totalCreditAllowed) * 100)
  //     : 100;

  // Calculate percentages for company stats
  const totalRegistrations = data.totalCompanies;
  const approvedPercentage =
    totalRegistrations > 0
      ? Math.round((data.approvedRegistrations / totalRegistrations) * 100)
      : 0;
  const pendingPercentage =
    totalRegistrations > 0
      ? Math.round((data.pendingRegistrations / totalRegistrations) * 100)
      : 0;
  const rejectedPercentage =
    totalRegistrations > 0
      ? Math.round((data.rejectedRegistrations / totalRegistrations) * 100)
      : 0;

  return (
    <div style={{ background: "#f1f2f4", minHeight: "100vh", padding: "12px" }}>
      <style>{`
        * {
          box-sizing: border-box;
        }

        .dashboard-container {
          max-width: 1400px;
          margin: 0 auto;
        }

        /* Main Content Grid */
        .main-grid {
          display: grid;
          grid-template-columns: 60% 40%;
          gap: 12px;
          margin-bottom: 12px;
        }

        /* Credit Management Card */
  /* Credit Management Card */
.credit-card {
  background: white;
  border-radius: 8px;
  padding: 14px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.card-title {
  font-size: 14px;
  font-weight: 600;
  color: #202223;
}

.manage-link {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #2c6ecb;
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
}

.manage-link:hover {
  text-decoration: underline;
}

.credit-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}

.credit-stat {
  display: flex;
  flex-direction: column;
  padding: 12px;
  background: white;
  border-radius: 6px;
  border: 1px solid #e4e5e7;
}

.credit-label {
  font-size: 11px;
  color: #6d7175;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.credit-label a {
  color: #2c6ecb;
  text-decoration: none;
  font-size: 11px;
}

.credit-label a:hover {
  text-decoration: underline;
}

.credit-value {
  font-size: 20px;
  font-weight: 700;
  color: #202223;
  margin-bottom: 8px;
}

.credit-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  width: fit-content;
  font-weight: 500;
}

        .credit-badge.success {
  background: #d1fae5;
  color: #008060;
}

.credit-badge.info {
  background: #dbeafe;
  color: #1e40af;
}

.credit-badge.warning {
  background: #fef3c7;
  color: #92400e;
}

.main-progress-bar {
  height: 6px;
  background: #e4e5e7;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 6px;
}

.main-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #008060 0%, #00a97a 100%);
}

.progress-percentage {
  text-align: right;
  font-size: 11px;
  color: #202223;
  font-weight: 500;
}

/* Company Registration Card - Compact */
.company-card {
  background: white;
  border-radius: 8px;
  padding: 14px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
  margin-bottom: 12px;
}

.company-content-wrapper {
          display: grid;
          grid-template-columns: 1fr 160px;
          gap: 16px;
          align-items: center;
        }

        .company-stats-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
        }

        .company-stat {
          display: flex;
          flex-direction: column;
          padding: 10px;
          border-radius: 6px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
          transition: transform 0.2s, box-shadow 0.2s;
        }

        .company-stat:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }

        .company-value {
          font-size: 22px;
          font-weight: 700;
          color: #202223;
          margin-bottom: 6px;
        }

        .company-label {
          font-size: 11px;
          color: #202223;
          margin-bottom: 6px;
          font-weight: 500;
        }

        .company-badge {
          display: inline-block;
          padding: 3px 6px;
          border-radius: 4px;
          font-size: 10px;
          width: fit-content;
        }

        .company-badge.blue {
          background: #e0f0ff;
          color: #1a7ac6;
        }

        .company-badge.yellow {
          background: #fef3c7;
          color: #9a6700;
        }

        .company-badge.green {
          background: #d1fae5;
          color: #008060;
        }

        .company-badge.red {
          background: #fee;
          color: #d73e3e;
        }

        /* Donut Chart - Compact */
        .chart-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
        }

        .donut-chart {
          position: relative;
          width: 130px;
          height: 130px;
        }

        .donut-chart svg {
          transform: rotate(-90deg);
        }

        .chart-center {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          text-align: center;
        }

        .chart-center-value {
          font-size: 22px;
          font-weight: 700;
          color: #202223;
        }

        .chart-center-label {
          font-size: 10px;
          color: #6d7175;
        }

        .chart-legend {
          display: flex;
          flex-direction: column;
          gap: 6px;
          width: 100%;
        }

        .legend-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 10px;
        }

        .legend-color {
          width: 10px;
          height: 10px;
          border-radius: 2px;
          margin-right: 6px;
        }

        .legend-left {
          display: flex;
          align-items: center;
        }

        .legend-value {
          font-weight: 600;
          color: #202223;
        }

        /* Quick Actions Card - Compact */
        .quick-actions-card {
          background: white;
          border-radius: 8px;
          padding: 14px;
          box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
        }

        .quick-actions-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 12px;
        }

        .quick-actions-title {
          font-size: 14px;
          font-weight: 600;
          color: #202223;
        }

        .action-item {
          border: 1px solid #c9cccf;
          border-radius: 8px;
          padding: 12px;
          transition: all 0.2s;
          cursor: pointer;
        }

        .action-item:hover {
          border-color: #2c6ecb;
          box-shadow: 0 2px 8px rgba(44, 110, 203, 0.15);
        }

        .action-header {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          margin-bottom: 8px;
        }

        .action-icon {
          width: 32px;
          height: 32px;
          background: #f6f6f7;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          flex-shrink: 0;
        }

        .action-content {
          flex: 1;
        }

        .action-title {
          font-size: 13px;
          font-weight: 600;
          color: #202223;
          margin: 0 0 4px 0;
        }

        .action-description {
          font-size: 11px;
          color: #6d7175;
          margin: 0;
        }

        .action-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid #e4e5e7;
        }

        .action-meta-text {
          font-size: 11px;
          color: #6d7175;
        }

        .action-button {
          background: #2c6ecb;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.2s;
        }

        .action-button:hover {
          background: #1f5199;
        }

        .action-button.secondary {
          background: transparent;
          color: #202223;
          border: 1px solid #c9cccf;
        }

        .action-button.secondary:hover {
          background: #f6f6f7;
        }

        .action-button-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .toggle-wrapper {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .toggle {
          width: 32px;
          height: 18px;
          background: #e4e5e7;
          border-radius: 9px;
          position: relative;
          cursor: pointer;
        }

        .toggle-handle {
          width: 14px;
          height: 14px;
          background: white;
          border-radius: 50%;
          position: absolute;
          top: 2px;
          left: 2px;
          transition: left 0.2s;
        }

        .toggle-label {
          font-size: 11px;
          color: #6d7175;
        }

        /* About Card - Compact */
        .about-card {
          background: white;
          border-radius: 8px;
          padding: 14px;
          box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
          border: 1px solid #e4e5e7;
        }

        .about-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 10px;
        }

        .about-icon {
          font-size: 18px;
        }

        .about-title {
          font-size: 14px;
          font-weight: 600;
          color: #202223;
        }

        .about-subtitle {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          color: #6d7175;
          margin-bottom: 10px;
        }

        .about-description {
          font-size: 11px;
          line-height: 1.5;
          color: #202223;
          margin-bottom: 10px;
        }

        .feature-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
          margin-bottom: 10px;
        }

        .feature-item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 10px;
          background: #f9fafb;
          border-radius: 6px;
          font-size: 11px;
          color: #202223;
          border: 1px solid #e4e5e7;
        }

        .feature-icon {
          font-size: 14px;
        }

        .about-buttons {
          display: flex;
          gap: 6px;
          margin-bottom: 10px;
        }

        .contact-button {
          flex: 1;
          background: white;
          color: #202223;
          border: 1px solid #c9cccf;
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .contact-button:hover {
          background: #f6f6f7;
          border-color: #8a9099;
        }

        .book-button {
          flex: 1;
          background: #008060;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .book-button:hover {
          background: #006e52;
        }

        .about-note {
          font-size: 10px;
          color: #6d7175;
          margin-bottom: 10px;
          padding: 8px;
          background: #fef9e6;
          border-radius: 6px;
          border-left: 3px solid #f1c40f;
        }

        .about-footer {
          font-size: 10px;
          color: #6d7175;
          padding-top: 10px;
          border-top: 1px solid #e4e5e7;
        }

        .help-link {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px;
          color: #2c6ecb;
          text-decoration: none;
          font-size: 12px;
          font-weight: 500;
          border-top: 1px solid #e4e5e7;
          margin-top: 10px;
          border-radius: 6px;
          transition: background 0.2s;
        }

        .help-link:hover {
          background: #f0f6ff;
        }

      /* Order Overview Card */
.order-card {
  width: 100%;
  background: white;
  border-radius: 8px;
  padding: 14px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
  margin-top: 12px;
}

.order-stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.order-stat {
  display: flex;
  flex-direction: column;
  padding: 14px;
  border-radius: 6px;
  border: 1px solid #e4e5e7;
}

.order-value {
  font-size: 28px;
  font-weight: 700;
  color: #202223;
  margin-bottom: 8px;
}

.order-label {
  font-size: 12px;
  color: #202223;
  margin-bottom: 8px;
  font-weight: 600;
}

.order-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  width: fit-content;
  font-weight: 500;
}

.order-badge.blue {
  background: #dbeafe;
  color: #1e40af;
}

.order-badge.yellow {
  background: #fef3c7;
  color: #92400e;
}

        @media (max-width: 1200px) {
          .main-grid {
            grid-template-columns: 1fr;
          }

          .company-content-wrapper {
            grid-template-columns: 1fr;
          }

          .feature-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="dashboard-container">
        {/* Company Registration Overview */}
        <div className="company-card">
          <h2 className="card-title" style={{ marginBottom: "14px" }}>
            Company Registration Overview
          </h2>

          <div className="company-content-wrapper">
            <div className="company-stats-grid">

               {/* Approved - WITH LINK */}
              <Link to="/app/registrations?status=approved" style={{ textDecoration: "none" }}>
                <div className="company-stat" style={{ background: "#e8f5e9" }}>
                  <div className="company-value">
                    {data.approvedRegistrations}
                  </div>
                  <div className="company-label">Approved</div>
                  <div className="company-badge green">Successfully approved</div>
                </div>
              </Link>
              

              {/* Pending Registrations */}
              <Link to="/app/registrations" style={{ textDecoration: "none" }}>
                <div className="company-stat" style={{ background: "#fef9e6" }}>
                  <div className="company-value">
                    {data.pendingRegistrations}
                  </div>
                  <div className="company-label">Pending</div>
                  <div className="company-badge yellow">Awaiting approval</div>
                </div>
              </Link>
              
                {/* Rejected - WITH LINK */}
              <Link to="/app/registrations?status=rejected" style={{ textDecoration: "none" }}>
                <div className="company-stat" style={{ background: "#ffebee" }}>
                  <div className="company-value">
                    {data.rejectedRegistrations}
                  </div>
                  <div className="company-label">Rejected</div>
                  <div className="company-badge red">Declined requests</div>
                </div>
              </Link>

             {/* Total Companies */}
              <Link to="/app/companies" style={{ textDecoration: "none" }}>
                <div className="company-stat" style={{ background: "#e0f0ff" }}>
                  <div className="company-value">{data.totalCompanies}</div>
                  <div className="company-label">Total Companies</div>
                  <div className="company-badge blue">Active in portal</div>
                </div>
              </Link>

              {/* Total Users */}
              <div className="company-stat" style={{ background: "#f3e5f5" }}>
                <div className="company-value">{data.totalUsers}</div>
                <div className="company-label">Total B2B Users</div>
                <div className="company-badge blue">Active users</div>
              </div>

            

              {/* Approval Rate */}
              <div className="company-stat" style={{ background: "#e1f5fe" }}>
                <div className="company-value">{approvedPercentage}%</div>
                <div className="company-label">Approval Rate</div>
                <div className="company-badge blue">Success rate</div>
              </div>
            </div>

            {/* Donut Chart */}
            <div className="chart-container">
              <div className="donut-chart">
                <svg width="130" height="130" viewBox="0 0 130 130">
                  {/* Background circle */}
                  <circle
                    cx="65"
                    cy="65"
                    r="55"
                    fill="none"
                    stroke="#f0f0f0"
                    strokeWidth="16"
                  />
                  {/* Approved segment */}
                  <circle
                    cx="65"
                    cy="65"
                    r="55"
                    fill="none"
                    stroke="#008060"
                    strokeWidth="16"
                    strokeDasharray={`${approvedPercentage * 3.45} 345`}
                    strokeDashoffset="0"
                  />
                  {/* Pending segment */}
                  <circle
                    cx="65"
                    cy="65"
                    r="55"
                    fill="none"
                    stroke="#f1c40f"
                    strokeWidth="16"
                    strokeDasharray={`${pendingPercentage * 3.45} 345`}
                    strokeDashoffset={`-${approvedPercentage * 3.45}`}
                  />
                  {/* Rejected segment */}
                  <circle
                    cx="65"
                    cy="65"
                    r="55"
                    fill="none"
                    stroke="#d73e3e"
                    strokeWidth="16"
                    strokeDasharray={`${rejectedPercentage * 3.45} 345`}
                    strokeDashoffset={`-${(approvedPercentage + pendingPercentage) * 3.45}`}
                  />
                </svg>
                <div className="chart-center">
                  <div className="chart-center-value">
                    {data.totalCompanies}
                  </div>
                  <div className="chart-center-label">Total</div>
                </div>
              </div>

              <div className="chart-legend">
                <div className="legend-item">
                  <div className="legend-left">
                    <div
                      className="legend-color"
                      style={{ background: "#008060" }}
                    ></div>
                    <span>Approved</span>
                  </div>
                  <span className="legend-value">{approvedPercentage}%</span>
                </div>
                <div className="legend-item">
                  <div className="legend-left">
                    <div
                      className="legend-color"
                      style={{ background: "#f1c40f" }}
                    ></div>
                    <span>Pending</span>
                  </div>
                  <span className="legend-value">{pendingPercentage}%</span>
                </div>
                <div className="legend-item">
                  <div className="legend-left">
                    <div
                      className="legend-color"
                      style={{ background: "#d73e3e" }}
                    ></div>
                    <span>Rejected</span>
                  </div>
                  <span className="legend-value">{rejectedPercentage}%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Grid */}
        <div className="main-grid">
          {/* Left Column */}
          <div>
            {/* Credit Management Overview */}

            <div className="credit-card">
              <div className="card-header">
                <h2 className="card-title">Credit Management Overview</h2>
                <a href="#" className="manage-link">
                  ⚙️ Manage credit
                </a>
              </div>

              <div className="credit-stats-grid">
                {/* Total Credit Allowed */}
                <div className="credit-stat">
                  <div className="credit-label">
                    Total Credit Allowed • <a href="#">Learn more →</a>
                  </div>
                  <div className="credit-value">
                    ${data.totalCreditAllowed.toLocaleString()}
                  </div>
                  <div className="credit-badge success">
                    ✓ Healthy credit balance
                  </div>
                </div>

                {/* Credit Used */}
                <div className="credit-stat">
                  <div className="credit-label">Credit Used</div>
                  <div className="credit-value">
                    ${data.totalCreditUsed.toLocaleString()}
                  </div>
                  <div className="credit-badge info">
                    {creditUsagePercentage}% Almost used
                  </div>
                </div>

                {/* Available Credit */}
                <div className="credit-stat">
                  <div className="credit-label">Available Credit</div>
                  <div className="credit-value">
                    ${data.availableCredit.toLocaleString()}
                  </div>
                  <div className="credit-badge success">✓ No risk detected</div>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="main-progress-bar">
                <div
                  className="main-progress-fill"
                  style={{ width: "100%" }}
                ></div>
              </div>
              <div className="progress-percentage">100%</div>
            </div>

            {/* Order Overview */}
            <div className="order-card">
              <h2 className="card-title" style={{ marginBottom: "14px" }}>
                Order Overview
              </h2>

              <div className="order-stats-grid">
                {/* Total Orders */}
                <div className="order-stat" style={{ background: "#f0f9ff" }}>
                  <div className="order-value">{data.totalOrders}</div>
                  <div className="order-label">Total Orders</div>
                  <div className="order-badge blue">All B2B orders</div>
                </div>

                {/* Rejected Registrations */}
                <div className="order-stat" style={{ background: "#fef9e6" }}>
                  <div className="order-value">
                    {data.rejectedRegistrations}
                  </div>
                  <div className="order-label">Rejected Applications</div>
                  <div className="order-badge yellow">Declined requests</div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - About B2B Portal */}
          <div>
            <div className="about-card">
              <div className="about-header">
                <span className="about-icon">🛒</span>
                <h2 className="about-title">About the B2B Portal</h2>
              </div>

              <div className="about-subtitle">
                <span>🔧</span>
                <span>
                  <strong>Built by Dynamic Dreamz</strong>
                </span>
              </div>

              <div className="about-description">
                This B2B Portal is built to help <strong>merchants</strong>{" "}
                manage wholesale customers, companies, locations, and credit
                workflows efficiently inside Shopify.
                <br />
                <br />
                It is developed and maintained by{" "}
                <strong>Dynamic Dreamz</strong>, a team specializing in custom
                Shopify and B2B solutions.
              </div>

              <div className="feature-grid">
                <div className="feature-item">
                  <span className="feature-icon">👥</span>
                  <span>Company Management</span>
                </div>
                <div className="feature-item">
                  <span className="feature-icon">💳</span>
                  <span>Credit Control</span>
                </div>
                <div className="feature-item">
                  <span className="feature-icon">📦</span>
                  <span>Order Tracking</span>
                </div>
                <div className="feature-item">
                  <span className="feature-icon">📊</span>
                  <span>Analytics & Reports</span>
                </div>
              </div>

              <div className="about-buttons">
                <button className="contact-button">Contact us</button>
                <button className="book-button">
                  Book a free consultation
                </button>
              </div>

              <p className="about-note">
                💡 No obligation. We will help you evaluate your requirements.
              </p>

              <div className="about-footer">
                © 2024 Dynamic Dreamz — Shopify & B2B Solutions
              </div>

              <a href="#" className="help-link">
                <span>❓ Help center & Documentation</span>
                <span>→</span>
              </a>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="quick-actions-card" style={{ marginTop: "12px" }}>
          <div className="quick-actions-header">
            <span style={{ fontSize: "18px" }}>📋</span>
            <h2 className="quick-actions-title">Quick Actions</h2>
          </div>

          {/* Flex container to display actions in a row */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            {/* Action 1 */}
            <Link
              to="/app/registrations"
              style={{
                textDecoration: "none",
                color: "inherit",
                flex: "1",
                minWidth: "280px",
              }}
            >
              <div className="action-item">
                <div className="action-header">
                  <div className="action-icon">📄</div>
                  <div className="action-content">
                    <h3 className="action-title">
                      Review {data.pendingRegistrations} pending registrations
                    </h3>
                    <p className="action-description">
                      {data.pendingRegistrations} companies awaiting approval
                    </p>
                  </div>
                </div>
                <div className="action-footer">
                  <span className="action-meta-text">23 & tasks cast</span>
                  <button className="action-button">Review →</button>
                </div>
              </div>
            </Link>

            {/* Action 2 */}
            <div style={{ flex: "1", minWidth: "280px" }}>
              <div className="action-item">
                <div className="action-header">
                  <div className="action-icon">🛡️</div>
                  <div className="action-content">
                    <h3 className="action-title">Approve top new companies</h3>
                    <p className="action-description">
                      Fast-track the most promising businesses
                    </p>
                  </div>
                </div>
                <div className="action-footer">
                  <div className="action-button-group">
                    <div className="toggle-wrapper">
                      <div className="toggle">
                        <div className="toggle-handle"></div>
                      </div>
                      <span className="toggle-label">Start approving</span>
                    </div>
                  </div>
                  <Link to="/app/companies">
                    <button className="action-button secondary">Start →</button>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};