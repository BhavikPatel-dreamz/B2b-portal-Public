import {
  Page,
  Layout,
  Card,
  IndexTable,
  Button,
  Modal,
  FormLayout,
  TextField,
  Badge,
  Text,
  BlockStack,
  InlineStack,
} from "@shopify/polaris";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useLoaderData, useFetcher, Link } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "app/db.server";
import { authenticate } from "app/shopify.server";
import { sendSalesUserInvitationEmail } from "app/utils/email";
import crypto from "crypto";

const COMPANY_PICKER_LARGE_LIST_THRESHOLD = 100;
const COMPANY_PICKER_PAGE_SIZE = 50;

type CompanyOption = {
  id: string;
  name: string;
};

type SalesUserRow = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  isActive: boolean;
  invitation: {
    isActive: boolean;
    token: string;
  } | null;
  salesCompanies: Array<{
    company: {
      name: string;
    };
  }>;
};

type SalesUsersLoaderData = {
  salesUsers: SalesUserRow[];
  companies: CompanyOption[];
  storeId: string;
  appUrl: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  const salesUsers = await prisma.user.findMany({
    where: { shopId: store.id, role: "SALES_USER" },
    include: {
      invitation: true,
      salesCompanies: { include: { company: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const companies = await prisma.companyAccount.findMany({
    where: { shopId: store.id },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return Response.json({ salesUsers, companies, storeId: store.id, appUrl: process.env.SHOPIFY_APP_URL });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json({ success: false, error: "Store not found" });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const email = formData.get("email") as string;
    const firstName = formData.get("firstName") as string;
    const lastName = formData.get("lastName") as string;
    const companyIds = formData.getAll("companyIds") as string[];

    const existingUser = await prisma.user.findFirst({
      where: { email, shopId: store.id },
    });

    if (existingUser) {
      return Response.json({ success: false, error: "Email already exists" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days valid

    const user = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        password: "PENDING",
        role: "SALES_USER",
        status: "PENDING",
        shopId: store.id,
        invitation: {
          create: {
            token,
            shopId: store.id,
            expiresAt,
          },
        },
        salesCompanies: {
          create: companyIds.map(id => ({ companyId: id })),
        },
      },
    });

    const inviteLink = `${process.env.SHOPIFY_APP_URL}/support/login?storeid=${store.id}&userid=${user.id}&token=${token}`;
    await sendSalesUserInvitationEmail({
      storeId: store.id,
      email,
      firstName,
      inviteLink,
    });

    return Response.json({ success: true, message: "Sales User Created and Invite Sent", intent: "create" });
  }

  if (intent === "deactivate" || intent === "activate") {
    const userId = formData.get("userId") as string;
    await prisma.user.update({
      where: { id: userId, shopId: store.id },
      data: { isActive: intent === "activate" },
    });
    return Response.json({ success: true, message: `User ${intent}d` });
  }

  if (intent === "delete") {
    const userId = formData.get("userId") as string;
    await prisma.user.delete({
      where: { id: userId, shopId: store.id },
    });
    return Response.json({ success: true, message: "User deleted" });
  }

  if (intent === "generate_link") {
    const userId = formData.get("userId") as string;
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Update or create invitation
    await prisma.invitation.upsert({
      where: { userId },
      update: { token, expiresAt, isActive: true },
      create: {
        userId,
        shopId: store.id,
        token,
        expiresAt,
        isActive: true,
      },
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      const inviteLink = `${process.env.SHOPIFY_APP_URL}/support/login?storeid=${store.id}&userid=${userId}&token=${token}`;
      await sendSalesUserInvitationEmail({
        storeId: store.id,
        email: user.email,
        firstName: user.firstName || "there",
        inviteLink,
      });
    }

    return Response.json({ success: true, message: "Link Generated and Invite Sent" });
  }

  if (intent === "resend_email") {
    const userId = formData.get("userId") as string;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { invitation: true }
    });

    if (user && user.invitation && user.invitation.isActive) {
      const inviteLink = `${process.env.SHOPIFY_APP_URL}/support/login?storeid=${store.id}&userid=${userId}&token=${user.invitation.token}`;
      await sendSalesUserInvitationEmail({
        storeId: store.id,
        email: user.email,
        firstName: user.firstName || "there",
        inviteLink,
      });
      return Response.json({ success: true, message: "Email Resent Successfully" });
    }
    return Response.json({ success: false, error: "Active invitation not found" });
  }

  return Response.json({ success: false, error: "Unknown intent" });
};

export default function SalesUsers() {
  const { salesUsers, companies, storeId, appUrl } =
    useLoaderData<typeof loader>() as unknown as SalesUsersLoaderData;
  const fetcher = useFetcher();
  const [isModalOpen, setIsModalOpen] = useState(false);
  
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<string[]>([]);
  const [companySearch, setCompanySearch] = useState("");
  const [companyPickerPage, setCompanyPickerPage] = useState(1);

  const toggleModal = useCallback(() => setIsModalOpen((open) => !open), []);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && fetcher.data?.intent === "create") {
      setIsModalOpen(false);
      setFirstName("");
      setLastName("");
      setEmail("");
      setSelectedCompanyIds([]);
      setCompanySearch("");
      setCompanyPickerPage(1);
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    setCompanyPickerPage(1);
  }, [companySearch]);

  const handleCreate = () => {
    const formData = new FormData();
    formData.append("intent", "create");
    formData.append("email", email);
    formData.append("firstName", firstName);
    formData.append("lastName", lastName);
    selectedCompanyIds.forEach(id => formData.append("companyIds", id));

    fetcher.submit(formData, { method: "post" });
  };

  const handleToggleStatus = (userId: string, currentStatus: boolean) => {
    fetcher.submit(
      { intent: currentStatus ? "deactivate" : "activate", userId },
      { method: "post" }
    );
  };

  const handleGenerateLink = (userId: string) => {
    fetcher.submit(
      { intent: "generate_link", userId },
      { method: "post" }
    );
  };

  const handleResendEmail = (userId: string) => {
    fetcher.submit(
      { intent: "resend_email", userId },
      { method: "post" }
    );
  };

  const handleDelete = (userId: string) => {
    if (confirm("Are you sure you want to delete this sales user? This action cannot be undone.")) {
      fetcher.submit(
        { intent: "delete", userId },
        { method: "post" }
      );
    }
  };

  const normalizedCompanySearch = companySearch.trim().toLowerCase();
  const filteredCompanies = useMemo(
    () =>
      companies.filter((company) =>
        company.name.toLowerCase().includes(normalizedCompanySearch),
      ),
    [companies, normalizedCompanySearch],
  );
  const shouldPaginateCompanyPicker =
    companies.length >= COMPANY_PICKER_LARGE_LIST_THRESHOLD &&
    filteredCompanies.length > COMPANY_PICKER_PAGE_SIZE;
  const totalCompanyPages = Math.max(
    1,
    Math.ceil(filteredCompanies.length / COMPANY_PICKER_PAGE_SIZE),
  );
  const visibleCompanies = shouldPaginateCompanyPicker
    ? filteredCompanies.slice(
        (companyPickerPage - 1) * COMPANY_PICKER_PAGE_SIZE,
        companyPickerPage * COMPANY_PICKER_PAGE_SIZE,
      )
    : filteredCompanies;
  const selectedCompanyCount = selectedCompanyIds.length;

  const toggleCompanySelection = (companyId: string) => {
    setSelectedCompanyIds((current) =>
      current.includes(companyId)
        ? current.filter((id) => id !== companyId)
        : [...current, companyId],
    );
  };

  const selectAllFilteredCompanies = () => {
    const filteredCompanyIds = filteredCompanies.map((company) => company.id);
    setSelectedCompanyIds((current) => Array.from(new Set([...current, ...filteredCompanyIds])));
  };

  const clearAllCompanies = () => {
    setSelectedCompanyIds([]);
  };

  const portalLoginUrl = `${appUrl}/sales/login`;

  const rowMarkup = salesUsers.map(
    ({ id, email, firstName, lastName, status, isActive, invitation, salesCompanies }, index) => {
      
      const link = invitation?.isActive 
        ? `${appUrl}/support/login?storeid=${storeId}&userid=${id}&token=${invitation.token}` 
        : null;

      const isApproved = status === "APPROVED";

      return (
        <IndexTable.Row id={id} key={id} position={index}>
          <IndexTable.Cell>
            <Text variant="bodyMd" fontWeight="bold" as="span">
              {firstName} {lastName}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>{email}</IndexTable.Cell>
          <IndexTable.Cell>
            {salesCompanies.map(sc => sc.company.name).join(", ")}
          </IndexTable.Cell>
          <IndexTable.Cell>
            {isActive ? <Badge tone="success">Active</Badge> : <Badge tone="critical">Inactive</Badge>}
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="200" align="start">
              <Button size="micro" onClick={() => handleToggleStatus(id, isActive)} tone={isActive ? "critical" : "success"}>
                {isActive ? "Deactivate" : "Activate"}
              </Button>
              {!link && (
                <Button size="micro" onClick={() => handleGenerateLink(id)}>Generate Link</Button>
              )}
              {link && (
                <>
                  <Button size="micro" onClick={() => handleResendEmail(id)}>Resend Email</Button>
                  <Button size="micro" onClick={() => navigator.clipboard.writeText(link)}>
                    Copy Invite Link
                  </Button>
                </>
              )}
              {isApproved && (
                <Button size="micro" onClick={() => navigator.clipboard.writeText(portalLoginUrl)}>
                  Copy Portal Login
                </Button>
              )}
              <Button size="micro" tone="critical" onClick={() => handleDelete(id)}>Delete</Button>
            </InlineStack>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
    boxSizing: "border-box",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const;

  const pageHeroStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    padding: "0px 0px 16px 0px",  
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  } as const;

  const pageHeroTitleStyle = {
    fontSize: "22px",
    lineHeight: 1.15,
    fontWeight: 650,
    color: "#202223",
    margin: "15px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center"
  } as const;

  const pageHeroTextStyle = {
    fontSize: "14px",
    color: "#5c5f62",
    margin: "0 15px 0",
  } as const;

  const contentPanelStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
    boxSizing: "border-box",
  } as const;

  const companyPickerHeaderStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
    marginBottom: "10px",
  } as const;

  const companyPickerCountStyle = {
    fontSize: "13px",
    color: "#5c5f62",
    fontWeight: 600,
  } as const;

  const companyPickerActionsStyle = {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  } as const;

  const companyPickerListStyle = {
    border: "1px solid #dfe3e8",
    borderRadius: "10px",
    maxHeight: "300px",
    overflowY: "auto",
    background: "#ffffff",
  } as const;

  const companyPickerRowStyle = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 12px",
    cursor: "pointer",
    borderBottom: "1px solid #f1f2f4",
    transition: "background-color 0.15s ease",
  } as const;

  const companyPickerEmptyStyle = {
    padding: "28px 16px",
    textAlign: "center",
    color: "#6d7175",
    background: "#ffffff",
  } as const;

  const companyPickerPaginationStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginTop: "10px",
  } as const;

  return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <Link
          to="/app"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#2c6ecb",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
            margin: "15px 15px 5px",
          }}
        >
          <svg
            viewBox="0 0 20 20"
            style={{ width: "16px", height: "16px" }}
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          Back to Dashboard
        </Link>
        <div style={pageHeroTitleStyle}>
          Sales Users
          <Button variant="primary" onClick={toggleModal}>Create Sales User</Button>
        </div>
        <p style={pageHeroTextStyle}>
          Manage sales users, assign them to companies, and control their access.
        </p>
      </div>
      
      <div style={contentPanelStyle}>
        {/* Sales Portal Login URL Banner */}
        <div style={{
          marginBottom: "16px",
          padding: "14px 18px",
          borderRadius: "12px",
          backgroundColor: "#fff0f4",
          border: "1px solid #f8d7e3",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap" as const,
        }}>
          <div>
            <Text variant="bodyMd" fontWeight="semibold" as="span">Sales Portal Login: </Text>
            <Text variant="bodyMd" as="span">{portalLoginUrl}</Text>
          </div>
          <Button size="micro" onClick={() => navigator.clipboard.writeText(portalLoginUrl)}>
            Copy URL
          </Button>
        </div>

        <Card padding="0">
            <IndexTable
              resourceName={{ singular: "user", plural: "users" }}
              itemCount={salesUsers.length}
              headings={[
                { title: "Name" },
                { title: "Email" },
                { title: "Assigned Companies" },
                { title: "Status" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
          </Card>
      <Modal
        open={isModalOpen}
        onClose={toggleModal}
        title="Create New Sales User"
        primaryAction={{
          content: "Create",
          onAction: handleCreate,
          loading: fetcher.state !== "idle",
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: toggleModal,
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="First Name"
              value={firstName}
              onChange={setFirstName}
              autoComplete="off"
            />
            <TextField
              label="Last Name"
              value={lastName}
              onChange={setLastName}
              autoComplete="off"
            />
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
            />
            <BlockStack gap="300">
              <div style={companyPickerHeaderStyle}>
                <Text variant="headingSm" as="h3">Assign Companies</Text>
                <span style={companyPickerCountStyle}>
                  {selectedCompanyCount} {selectedCompanyCount === 1 ? "company" : "companies"} selected
                </span>
              </div>

              <TextField
                label="Search companies"
                labelHidden
                placeholder="Search companies by name..."
                value={companySearch}
                onChange={setCompanySearch}
                autoComplete="off"
              />

              <div style={companyPickerActionsStyle}>
                <Button
                  size="micro"
                  onClick={selectAllFilteredCompanies}
                  disabled={filteredCompanies.length === 0}
                >
                  Select All
                </Button>
                <Button
                  size="micro"
                  onClick={clearAllCompanies}
                  disabled={selectedCompanyIds.length === 0}
                >
                  Clear All
                </Button>
                <Text variant="bodySm" tone="subdued" as="span">
                  {filteredCompanies.length} {filteredCompanies.length === 1 ? "match" : "matches"}
                </Text>
              </div>

              <div style={companyPickerListStyle} role="group" aria-label="Assign companies">
                {visibleCompanies.length > 0 ? (
                  visibleCompanies.map((company, index) => {
                    const isSelected = selectedCompanyIds.includes(company.id);
                    const baseBackground = index % 2 === 0 ? "#ffffff" : "#fafbfb";

                    return (
                      <label
                        key={company.id}
                        style={{
                          ...companyPickerRowStyle,
                          backgroundColor: isSelected ? "#f0f7ff" : baseBackground,
                        }}
                        onMouseEnter={(event) => {
                          event.currentTarget.style.backgroundColor = isSelected ? "#e4f0ff" : "#f6f6f7";
                        }}
                        onMouseLeave={(event) => {
                          event.currentTarget.style.backgroundColor = isSelected ? "#f0f7ff" : baseBackground;
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleCompanySelection(company.id)}
                          style={{
                            width: "16px",
                            height: "16px",
                            accentColor: "#2c6ecb",
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: "14px", color: "#202223", lineHeight: 1.35 }}>
                          {company.name}
                        </span>
                      </label>
                    );
                  })
                ) : (
                  <div style={companyPickerEmptyStyle}>
                    No companies found
                  </div>
                )}
              </div>

              {shouldPaginateCompanyPicker && (
                <div style={companyPickerPaginationStyle}>
                  <Button
                    size="micro"
                    onClick={() => setCompanyPickerPage((page) => Math.max(1, page - 1))}
                    disabled={companyPickerPage <= 1}
                  >
                    Previous
                  </Button>
                  <Text variant="bodySm" tone="subdued" as="span">
                    Page {companyPickerPage} of {totalCompanyPages}
                  </Text>
                  <Button
                    size="micro"
                    onClick={() => setCompanyPickerPage((page) => Math.min(totalCompanyPages, page + 1))}
                    disabled={companyPickerPage >= totalCompanyPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </BlockStack>
          </FormLayout>
        </Modal.Section>
      </Modal>
      </div>
    </div>
  );
}
