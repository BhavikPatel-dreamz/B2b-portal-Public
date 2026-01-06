import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCompanyUsers } from "../services/company.server";

type LoaderData = {
  company: {
    name: string;
    shopifyCompanyId: string | null;
  };
  users: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    companyRole: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const companyId = params.companyId;
  if (!companyId) {
    throw new Response("Company ID is required", { status: 400 });
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  const data = await getCompanyUsers(companyId, store.id);

  if (!data) {
    throw new Response("Company not found", { status: 404 });
  }

  return Response.json({
    company: {
      name: data.company.name,
      shopifyCompanyId: data.company.shopifyCompanyId,
    },
    users: data.users.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      companyRole: user.companyRole,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    })),
  } satisfies LoaderData);
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStatusBadge(status: string) {
  const isActive = status === "ACTIVE";
  return (
    <span
      style={{
        padding: "4px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor: isActive ? "#d4f3e6" : "#e0e0e0",
        color: isActive ? "#008060" : "#5c5f62",
      }}
    >
      {status}
    </span>
  );
}

function getRoleBadge(role: string) {
  const roleColors: Record<string, { bg: string; text: string }> = {
    admin: { bg: "#fff4cc", text: "#b98900" },
    buyer: { bg: "#e0e0e0", text: "#5c5f62" },
    viewer: { bg: "#e3f2fd", text: "#1976d2" },
  };

  const colors = roleColors[role.toLowerCase()] || roleColors.buyer;

  return (
    <span
      style={{
        padding: "4px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor: colors.bg,
        color: colors.text,
      }}
    >
      {role.toUpperCase()}
    </span>
  );
}

export default function CompanyUsersPage() {
  const data = useLoaderData<LoaderData>();

  return (
    <s-page heading={`${data.company.name} - Users`}>
      <div style={{ marginBottom: 16 }}>
        <Link
          to="/app/companies"
          style={{
            color: "#005bd3",
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          ← Back to Companies
        </Link>
      </div>

      <s-section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h3 style={{ margin: 0 }}>
            All Users ({data.users.length})
          </h3>
          {data.company.shopifyCompanyId && (
            <a
              href={`https://admin.shopify.com/store/${data.company.shopifyCompanyId.replace("gid://shopify/Company/", "")}/customers`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                border: "1px solid #c9ccd0",
                textDecoration: "none",
                color: "#202223",
                fontSize: 14,
                fontWeight: 500,
                backgroundColor: "white",
                cursor: "pointer",
              }}
            >
              View in Shopify →
            </a>
          )}
        </div>

        {data.users.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 800,
              }}
            >
              <thead>
                <tr style={{ borderBottom: "2px solid #e0e0e0" }}>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Name
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Email
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Role
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Company Role
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Created
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Last Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr
                    key={user.id}
                    style={{ borderBottom: "1px solid #e0e0e0" }}
                  >
                    <td style={{ padding: 12, fontSize: 13, fontWeight: 500 }}>
                      {[user.firstName, user.lastName]
                        .filter(Boolean)
                        .join(" ") || "—"}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>{user.email}</td>
                    <td style={{ padding: 12 }}>{getRoleBadge(user.role)}</td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {user.companyRole || "—"}
                    </td>
                    <td style={{ padding: 12 }}>
                      {getStatusBadge(user.status)}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {formatDate(user.createdAt)}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {formatDate(user.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: "center", color: "#5c5f62" }}>
            <p>No users found for this company.</p>
          </div>
        )}
      </s-section>
    </s-page>
  );
}
