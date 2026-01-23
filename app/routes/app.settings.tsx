import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getStoreByDomain, uninstallStore, updateStore } from "../services/store.server";
import { createUser, getUserByEmail } from "app/services/user.server";
import { getCompaniesByShop } from "app/services/company.server";

interface LoaderData {
  storeMissing: boolean;
  store?: {
    shopDomain: string;
    shopName: string;
    logo: string;
    submissionEmail: string;
    contactEmail: string;
    themeColor: string;
    companyWelcomeEmailTemplate?: string;
    companyWelcomeEmailEnabled?: boolean;
    privacyPolicylink?: string;
    privacyPolicyContent?: string;
  };
}

interface ActionResponse {
  success: boolean;
  message?: string;
  errors?: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json({ storeMissing: true } satisfies LoaderData, {
      status: 404,
    });
  }

  return Response.json(
    {
      storeMissing: false,
      store: {
        shopDomain: store.shopDomain,
        shopName: store.shopName || "",
        logo: store.logo || "",
        submissionEmail: store.submissionEmail || "",
        contactEmail: store.contactEmail || "",
        themeColor: store.themeColor || "",
        companyWelcomeEmailTemplate: store.companyWelcomeEmailTemplate || "",
        companyWelcomeEmailEnabled: store.companyWelcomeEmailEnabled !== false,
        privacyPolicylink: store.privacyPolicylink || "",
        privacyPolicyContent: store.privacyPolicyContent || "",
      },
    } satisfies LoaderData,
    { status: 200 },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { success: false, errors: ["Store not found"] } satisfies ActionResponse,
      { status: 404 },
    );
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "delete") {
    try {
      const shop = session.shop;

     if (session) {
        await prisma.session.deleteMany({ where: { shop } });
      }

      // Delete user sessions first
      const users = await prisma.user.findMany({ where: { shopId: store.id } });
      if (users.length > 0) {
        const userIds = users.map(u => u.id);
        await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
      }

      // Delete order payments
      const orders = await prisma.b2BOrder.findMany({ where: { shopId: store.id } });
      if (orders.length > 0) {
        const orderIds = orders.map(o => o.id);
        await prisma.orderPayment.deleteMany({ where: { orderId: { in: orderIds } } });
      }

      // Delete credit transactions
      const companyAccounts = await prisma.companyAccount.findMany({ where: { shopId: store.id } });
      if (companyAccounts.length > 0) {
        const companyIds = companyAccounts.map(c => c.id);
        await prisma.creditTransaction.deleteMany({ where: { companyId: { in: companyIds } } });
      }

      // Delete main records
      await prisma.wishlist.deleteMany({ where: { shop } });
      await prisma.notification.deleteMany({ where: { shopId: store.id } });
      await prisma.b2BOrder.deleteMany({ where: { shopId: store.id } });
      await prisma.companyAccount.deleteMany({ where: { shopId: store.id } });
      await prisma.registrationSubmission.deleteMany({ where: { shopId: store.id } });
      await prisma.user.deleteMany({ where: { shopId: store.id } });

      // Mark store as uninstalled
      await uninstallStore(shop);

      console.log(`Successfully uninstalled store: ${shop}`);
    
      return Response.json(
        {
          success: true,
          message: "All B2B portal data has been successfully deleted",
        } satisfies ActionResponse,
        { status: 200 },
      );
    } catch (error) {
      console.error("Error deleting store data:", error);
      return Response.json(
        {
          success: false,
          errors: ["Failed to delete store data. Please try again."],
        } satisfies ActionResponse,
        { status: 500 },
      );
    }
  }

  // Handle webhook intent (customers/create)
  if (intent === "webhook") {
    try {
      const { payload, shop, topic } = await authenticate.webhook(request);
      console.log(`Received ${topic} webhook for ${shop}`);

      if (topic !== "CUSTOMERS_CREATE") {
        console.info(
          `Webhook topic ${topic} hit customers/create route. Ignoring.`,
        );
        return new Response();
      }

      if (!payload || !shop) {
        return new Response("Invalid webhook payload", { status: 400 });
      }

      const store = await getStoreByDomain(shop);
      if (!store) {
        console.warn(
          `Store not found for domain ${shop} — skipping customer sync`,
        );
        return new Response();
      }

      const customer = payload as any;
      const customerId = customer.id;
      const customerEmail = customer.email;
      const firstName = customer.first_name;
      const lastName = customer.last_name;
      const customerTags = customer.tags || "";
      const credit = customer.credit || 0;

      if (!customerEmail || !customerId) {
        console.info("Customer has no email or ID; skipping B2B user creation");
        return new Response();
      }

      const customerGid = `gid://shopify/Customer/${customerId}`;

      const existingUser = await getUserByEmail(customerEmail, store.id);
      if (existingUser) {
        console.info(
          `User with email ${customerEmail} already exists; skipping creation`,
        );
        return new Response();
      }

      let assignedCompany = null;

      const isB2BCustomer =
        customerTags.toLowerCase().includes("b2b") ||
        customerTags.toLowerCase().includes("business") ||
        customerTags.toLowerCase().includes("company");

      if (!isB2BCustomer) {
        console.info(
          `Customer ${customerEmail} does not have B2B tags; skipping B2B user creation`,
        );
        return new Response();
      }

      const companies = await getCompaniesByShop(store.id, { take: 1 });

      if (companies.length === 0) {
        console.warn(
          `No companies found for store ${shop}; cannot assign user to company`,
        );
        return new Response();
      }

      assignedCompany = companies[0];

      const newUser = await createUser({
        email: customerEmail,
        firstName: firstName || null,
        lastName: lastName || null,
        password: "",
        role: "STORE_USER",
        status: "PENDING",
        shopId: store.id,
        companyId: assignedCompany.id,
        companyRole: "member",
        shopifyCustomerId: customerGid,
        userCreditLimit: credit,
      });

      console.log(
        `Created B2B user ${newUser.id} for Shopify customer ${customerId} and assigned to company ${assignedCompany.name}`,
      );
      return new Response();
    } catch (error) {
      console.error("Error processing customers/create webhook:", error);
      return new Response("Internal server error", { status: 500 });
    }
  }

  // Handle settings update
  const logoRaw = (formData.get("logo") as string | null)?.trim() || "";
  const shopName = (formData.get("shopName") as string | null)?.trim() || "";
  const submissionEmailRaw =
    (formData.get("submissionEmail") as string | null)?.trim() || "";
  const contactEmailRaw =
    (formData.get("contactEmail") as string | null)?.trim() || "";
  const themeColorRaw =
    (formData.get("themeColor") as string | null)?.trim() || "";
  const companyWelcomeEmailTemplate =
    (formData.get("companyWelcomeEmailTemplate") as string | null)?.trim() ||
    "";
  const companyWelcomeEmailEnabled =
    (formData.get("companyWelcomeEmailEnabled") as string | null) === "on";

  const privacyPolicylink =
    (formData.get("privacyPolicylink") as string | null)?.trim() || null;
  const privacyPolicyContent =
    (formData.get("privacyPolicyContent") as string | null)?.trim() || null;

  const errors: string[] = [];

  const submissionEmail = submissionEmailRaw || null;
  if (submissionEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submissionEmail)) {
    errors.push("Enter a valid registration notification email address.");
  }

  const contactEmail = contactEmailRaw || null;
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    errors.push("Enter a valid contact email address.");
  }

  const themeColor = themeColorRaw || null;
  if (themeColor && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(themeColor)) {
    errors.push("Theme color must be a hex value like #0d6efd or #123.");
  }

  if (privacyPolicylink && !/^https?:\/\/[^\s]+$/.test(privacyPolicylink)) {
    errors.push("Privacy policy link must be a valid URL.");
  }

  if (errors.length > 0) {
    return Response.json({ success: false, errors }, { status: 400 });
  }

  const logo = logoRaw || null;

  await updateStore(store.id, {
    logo,
    shopName,
    submissionEmail,
    contactEmail,
    themeColor,
    companyWelcomeEmailTemplate: companyWelcomeEmailTemplate || null,
    companyWelcomeEmailEnabled,
    privacyPolicylink,
    privacyPolicyContent,
  });

  return Response.json(
    { success: true, message: "Settings saved" } satisfies ActionResponse,
    { status: 200 },
  );
};
const ToolbarButton = ({ onClick, title, children }: any) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    style={{
      padding: "6px 10px",
      background: "#fff",
      border: "1px solid #c9cccf",
      borderRadius: 6,
      cursor: "pointer",
      fontSize: 14,
      minWidth: 32,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = "#f1f2f3";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = "#fff";
    }}
  >
    {children}
  </button>
);

export default function SettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { storeMissing } = loaderData;

  // TypeScript now knows if storeMissing is false, store exists
  if (loaderData.storeMissing) {
    return (
      <s-page heading="Store settings">
        <s-section>
          <s-banner tone="critical" title="Store not found">
            <s-paragraph>
              The current shop is missing from the database. Please reinstall
              the app to continue.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const [showDropdown, setShowDropdown] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [content, setContent] = useState("");

  // Refs
  const editorRef = useRef<HTMLDivElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const privacyEditorRef = useRef<HTMLDivElement>(null);
  const privacyHiddenInputRef = useRef<HTMLInputElement>(null);

  // Fetchers
  const fetcher = useFetcher<ActionResponse>();
  const deleteFetcher = useFetcher<ActionResponse>();

  const isSaving = fetcher.state !== "idle";
  const isDeleting = deleteFetcher.state !== "idle";

  // Variables for email template
  const variables = [
    { var: "{{companyName}}", desc: "Applying company's name" },
    { var: "{{contactName}}", desc: "Contact person's name" },
    { var: "{{email}}", desc: "Contact email address" },
    { var: "{{storeOwnerName}}", desc: "Store owner's name" },
    { var: "{{shopName}}", desc: "Shopify store's name" },
  ];

  // Email editor functions
  const format = (command: string, value: string | null = null) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  };

  const handleInput = () => {
    if (editorRef.current && hiddenInputRef.current) {
      const htmlContent = editorRef.current.innerHTML;
      setContent(htmlContent);
      hiddenInputRef.current.value = htmlContent;
    }
  };

  const insertVariable = (variable: string) => {
    if (editorRef.current) {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;

      const range = selection.getRangeAt(0);
      range.deleteContents();

      const textNode = document.createTextNode(variable);
      range.insertNode(textNode);

      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);

      handleInput();
      editorRef.current.focus();
    }
    setShowDropdown(false);
  };

  const formatPrivacy = (command: string, value: string | null = null) => {
    document.execCommand(command, false, value);
    privacyEditorRef.current?.focus();
  };

  const handlePrivacyInput = () => {
    if (privacyEditorRef.current && privacyHiddenInputRef.current) {
      const htmlContent = privacyEditorRef.current.innerHTML;
      privacyHiddenInputRef.current.value = htmlContent;
    }
  };

const handleDelete = () => {
  deleteFetcher.submit({ intent: "delete" }, { method: "post" });
};

// Update the useEffect for successful deletion
useEffect(() => {
  if (deleteFetcher.data?.success) {
    setShowDeleteModal(false);
    setConfirmText("");
    
    // Optional: Reload the page to show fresh state
    setTimeout(() => {
      window.location.reload();
    }, 2000);
  }
}, [deleteFetcher.data]);

  // Initialize editor content from store data
  useEffect(() => {
    if (!storeMissing && loaderData.store) {
      if (editorRef.current) {
        editorRef.current.innerHTML =
          loaderData.store.companyWelcomeEmailTemplate || "";
        if (hiddenInputRef.current) {
          hiddenInputRef.current.value =
            loaderData.store.companyWelcomeEmailTemplate || "";
        }
      }

      if (privacyEditorRef.current) {
        privacyEditorRef.current.innerHTML =
          loaderData.store.privacyPolicyContent || "";
        if (privacyHiddenInputRef.current) {
          privacyHiddenInputRef.current.value =
            loaderData.store.privacyPolicyContent || "";
        }
      }
    }
  }, [
    loaderData.store?.companyWelcomeEmailTemplate,
    loaderData.store?.privacyPolicyContent,
    storeMissing,
  ]);


  // Feeprismaack message
  const feeprismaack = useMemo(() => {
    const data = fetcher.data || deleteFetcher.data;
    if (!data) return null;

    if (!data.success && data.errors?.length) {
      return {
        tone: "critical" as const,
        title: "Error",
        messages: data.errors,
      };
    }
    if (data.success && data.message) {
      return {
        tone: "success" as const,
        title: data.message,
        messages: [],
      };
    }
    return null;
  }, [fetcher.data, deleteFetcher.data]);

  // Early return if store is missing
  if (storeMissing) {
    return (
      <s-page heading="Store settings">
        <s-section>
          <s-banner tone="critical" title="Store not found">
            <s-paragraph>
              The current shop is missing from the database. Please reinstall
              the app to continue.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const { store } = loaderData;

  return (
    <s-page heading="Store settings">
      <s-section heading="Branding & notifications">
        {feeprismaack && (
          <s-banner
            tone={feeprismaack.tone}
            title={feeprismaack.title}
            style={{ marginBottom: 12 }}
          >
            {feeprismaack.messages.length > 0 && (
              <s-unordered-list>
                {feeprismaack.messages.map((msg) => (
                  <s-list-item key={msg}>{msg}</s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-banner>
        )}

        <s-card>
          <fetcher.Form method="post" style={{ display: "grid", gap: 16 }}>
            {/* Store Name */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="shopName"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Store name
              </label>
              <input
                id="shopName"
                name="shopName"
                type="text"
                defaultValue={store?.shopName}
                placeholder="Store name"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Store name shown across emails or customer views.
              </s-text>
            </div>

            {/* Logo URL */}
            <div style={{ display: "grid", gap: 6 }}>
              <label htmlFor="logo" style={{ fontWeight: 600, fontSize: 14 }}>
                Logo URL
              </label>
              <input
                id="logo"
                name="logo"
                type="url"
                defaultValue={store?.logo}
                placeholder="https://your-cdn.com/logo.png"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Storefront logo URL shown across emails or customer views.
              </s-text>

              {store?.logo && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginTop: 8,
                  }}
                >
                  <div
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "1px solid #ebedef",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "#f6f6f7",
                    }}
                  >
                    <img
                      src={store.logo}
                      alt="Current logo"
                      style={{ maxWidth: "100%", maxHeight: "100%" }}
                    />
                  </div>
                  <s-text tone="subdued" variant="bodySm">
                    Preview of the stored logo.
                  </s-text>
                </div>
              )}
            </div>

            {/* Registration Email */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="submissionEmail"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Registration notification email
              </label>
              <input
                id="submissionEmail"
                name="submissionEmail"
                type="email"
                defaultValue={store?.submissionEmail}
                placeholder="ops@yourstore.com"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Email address that receives new B2B registration submissions.
              </s-text>
            </div>

            {/* Contact Email */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="contactEmail"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Primary contact email
              </label>
              <input
                id="contactEmail"
                name="contactEmail"
                type="email"
                defaultValue={store?.contactEmail}
                placeholder="support@yourstore.com"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Shared contact inbox for customers and notifications.
              </s-text>
            </div>

            {/* Company Sync Notifications */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="companyWelcomeEmailEnabled"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Company sync notifications
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="companyWelcomeEmailEnabled"
                  name="companyWelcomeEmailEnabled"
                  type="checkbox"
                  defaultChecked={store?.companyWelcomeEmailEnabled}
                  style={{ width: 18, height: 18, cursor: "pointer" }}
                />
                <label
                  htmlFor="companyWelcomeEmailEnabled"
                  style={{ cursor: "pointer" }}
                >
                  Send email notifications when companies are synced
                </label>
              </div>
              <s-text tone="subdued" variant="bodySm">
                Enable to receive email notifications whenever companies are
                synced from Shopify B2B.
              </s-text>
            </div>

            {/* Theme Color */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="themeColor"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Theme color
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input
                  id="themeColor"
                  type="color"
                  defaultValue={store?.themeColor || "#005bd3"}
                  style={{
                    width: 52,
                    height: 36,
                    border: "1px solid #c9cccf",
                    borderRadius: 8,
                    padding: 0,
                    cursor: "pointer",
                    background: "#fff",
                  }}
                  onChange={(e) => {
                    const textInput = document.getElementById(
                      "themeColorText",
                    ) as HTMLInputElement | null;
                    if (textInput) {
                      textInput.value = e.target.value;
                    }
                  }}
                />
                <input
                  id="themeColorText"
                  name="themeColor"
                  type="text"
                  defaultValue={store?.themeColor || ""}
                  placeholder="#005bd3"
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #c9cccf",
                    fontSize: 14,
                    outline: "none",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "#005bd3";
                    e.target.style.boxShadow = "0 0 0 1px #005bd3";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "#c9cccf";
                    e.target.style.boxShadow = "none";
                  }}
                  onChange={(e) => {
                    const colorInput = document.getElementById(
                      "themeColor",
                    ) as HTMLInputElement | null;
                    if (
                      colorInput &&
                      /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)
                    ) {
                      colorInput.value = e.target.value;
                    }
                  }}
                />
              </div>
              <s-text tone="subdued" variant="bodySm">
                Primary accent color used across storefront surfaces. Accepts
                hex values.
              </s-text>
            </div>

            {/* Email Template Editor */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="companyWelcomeEmailTemplate"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                New Company Registration Email Template
              </label>

              {/* Formatting Toolbar */}
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  padding: 8,
                  background: "#f6f6f7",
                  border: "1px solid #c9cccf",
                  borderRadius: "8px 8px 0 0",
                  flexWrap: "wrap",
                }}
              >
                <ToolbarButton onClick={() => format("bold")} title="Bold">
                  <strong>B</strong>
                </ToolbarButton>
                <ToolbarButton onClick={() => format("italic")} title="Italic">
                  <em>I</em>
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => format("underline")}
                  title="Underline"
                >
                  <u>U</u>
                </ToolbarButton>

                <div
                  style={{ width: 1, background: "#c9cccf", margin: "0 4px" }}
                />

                <ToolbarButton
                  onClick={() => format("insertUnorderedList")}
                  title="Bullet List"
                >
                  ≡
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => format("insertOrderedList")}
                  title="Numbered List"
                >
                  ≣
                </ToolbarButton>

                <div
                  style={{ width: 1, background: "#c9cccf", margin: "0 4px" }}
                />

                <ToolbarButton
                  onClick={() => format("justifyLeft")}
                  title="Align Left"
                >
                  ⫴
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => format("justifyCenter")}
                  title="Align Center"
                >
                  ≡
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => format("justifyRight")}
                  title="Align Right"
                >
                  ⫵
                </ToolbarButton>

                <div
                  style={{ width: 1, background: "#c9cccf", margin: "0 4px" }}
                />

                <ToolbarButton
                  onClick={() => format("removeFormat")}
                  title="Clear Formatting"
                >
                  ✕
                </ToolbarButton>
              </div>

              {/* Rich Text Editor */}
              <div
                ref={editorRef}
                contentEditable
                onInput={handleInput}
                style={{
                  padding: "10px 12px",
                  border: "1px solid #c9cccf",
                  borderTop: "none",
                  borderRadius: "0 0 8px 8px",
                  fontSize: 14,
                  outline: "none",
                  minHeight: 120,
                  maxHeight: 400,
                  overflowY: "auto",
                  background: "#fff",
                  lineHeight: 1.5,
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "#005bd3";
                  e.currentTarget.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "#c9cccf";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />

              <input
                ref={hiddenInputRef}
                type="hidden"
                name="companyWelcomeEmailTemplate"
                id="companyWelcomeEmailTemplate"
              />

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ fontSize: 12, color: "#6d7175" }}>
                  This email is sent to the store owner when a new company
                  submits a B2B registration request.
                </div>

                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => setShowDropdown(!showDropdown)}
                    style={{
                      padding: "6px 12px",
                      background: showDropdown ? "#f1f2f3" : "transparent",
                      color: "#202223",
                      border: "1px solid #c9cccf",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                    onMouseEnter={(e) => {
                      if (!showDropdown)
                        e.currentTarget.style.background = "#f6f6f7";
                    }}
                    onMouseLeave={(e) => {
                      if (!showDropdown)
                        e.currentTarget.style.background = "transparent";
                    }}
                  >
                    Available variables
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M3 4.5L6 7.5L9 4.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  {showDropdown && (
                    <>
                      <div
                        style={{
                          position: "fixed",
                          top: 0,
                          left: 0,
                          right: 0,
                          bottom: 0,
                          zIndex: 999,
                        }}
                        onClick={() => setShowDropdown(false)}
                      />
                      <div
                        style={{
                          position: "absolute",
                          top: "calc(100% + 4px)",
                          right: 0,
                          background: "#fff",
                          border: "1px solid #c9cccf",
                          borderRadius: 8,
                          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                          minWidth: 320,
                          zIndex: 1000,
                          padding: 8,
                        }}
                      >
                        <div style={{ display: "grid", gap: 4 }}>
                          {variables.map(({ var: variable, desc }) => (
                            <button
                              key={variable}
                              type="button"
                              onClick={() => insertVariable(variable)}
                              style={{
                                padding: "8px 10px",
                                background: "#fff",
                                border: "1px solid #c9cccf",
                                borderRadius: 6,
                                textAlign: "left",
                                cursor: "pointer",
                                fontSize: 13,
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = "#f1f2f3";
                                e.currentTarget.style.borderColor = "#005bd3";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = "#fff";
                                e.currentTarget.style.borderColor = "#c9cccf";
                              }}
                            >
                              <code
                                style={{
                                  background: "#e3f2fd",
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                  fontSize: 12,
                                  color: "#0066cc",
                                  fontFamily: "monospace",
                                }}
                              >
                                {variable}
                              </code>
                              <span
                                style={{
                                  color: "#6d7175",
                                  fontSize: 12,
                                  marginLeft: 8,
                                }}
                              >
                                {desc}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Privacy Policy Section */}
            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="privacyPolicylink"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Privacy Policy
              </label>

              <input
                id="privacyPolicylink"
                name="privacyPolicylink"
                type="url"
                defaultValue={store?.privacyPolicylink}
                placeholder="https://www.example.com/privacy"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />

              <s-text tone="subdued" variant="bodySm">
                or use custom privacy policy text instead
              </s-text>

              {/* Privacy Policy Rich Text Editor */}
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  padding: 8,
                  background: "#f6f6f7",
                  border: "1px solid #c9cccf",
                  borderRadius: "8px 8px 0 0",
                  flexWrap: "wrap",
                }}
              >
                <ToolbarButton
                  onClick={() => formatPrivacy("bold")}
                  title="Bold"
                >
                  <strong>B</strong>
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => formatPrivacy("italic")}
                  title="Italic"
                >
                  <em>I</em>
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => formatPrivacy("underline")}
                  title="Underline"
                >
                  <u>U</u>
                </ToolbarButton>

                <div
                  style={{ width: 1, background: "#c9cccf", margin: "0 4px" }}
                />

                <ToolbarButton
                  onClick={() => formatPrivacy("insertUnorderedList")}
                  title="Bullet List"
                >
                  ≡
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => formatPrivacy("insertOrderedList")}
                  title="Numbered List"
                >
                  ≣
                </ToolbarButton>

                <div
                  style={{ width: 1, background: "#c9cccf", margin: "0 4px" }}
                />

                <ToolbarButton
                  onClick={() => formatPrivacy("justifyLeft")}
                  title="Align Left"
                >
                  ⫴
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => formatPrivacy("justifyCenter")}
                  title="Align Center"
                >
                  ≡
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => formatPrivacy("justifyRight")}
                  title="Align Right"
                >
                  ⫵
                </ToolbarButton>

                <div
                  style={{ width: 1, background: "#c9cccf", margin: "0 4px" }}
                />

                <ToolbarButton
                  onClick={() => formatPrivacy("removeFormat")}
                  title="Clear Formatting"
                >
                  ✕
                </ToolbarButton>
              </div>

              <div
                ref={privacyEditorRef}
                contentEditable
                onInput={handlePrivacyInput}
                style={{
                  padding: "10px 12px",
                  border: "1px solid #c9cccf",
                  borderTop: "none",
                  borderRadius: "0 0 8px 8px",
                  fontSize: 14,
                  outline: "none",
                  minHeight: 120,
                  maxHeight: 400,
                  overflowY: "auto",
                  background: "#fff",
                  lineHeight: 1.5,
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "#005bd3";
                  e.currentTarget.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "#c9cccf";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />

              <input
                ref={privacyHiddenInputRef}
                type="hidden"
                name="privacyPolicyContent"
                id="privacyPolicyContent"
              />
            </div>

            {/* Save Button */}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <s-button
                type="submit"
                variant="primary"
                {...(isSaving ? { loading: true } : {})}
              >
                Save settings
              </s-button>
            </div>
          </fetcher.Form>

          {/* Delete App Data Section */}
          <div style={{ marginTop: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>
              Delete App Data
            </h2>

            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fca5a5",
                borderRadius: 8,
                padding: 24,
              }}
            >
              <p
                style={{
                  fontSize: 14,
                  color: "#1f2937",
                  marginBottom: 16,
                  lineHeight: 1.5,
                }}
              >
                This will permanently delete all{" "}
                <strong style={{ color: "#dc2626" }}>B2B portal data</strong>{" "}
                for this store, including companies, registrations, users,
                credit information, and app settings.
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 16,
                  marginBottom: 16,
                }}
              >
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 20,
                    fontSize: 14,
                    color: "#374151",
                  }}
                >
                  <li style={{ marginBottom: 4 }}>Companies & contacts</li>
                  <li style={{ marginBottom: 4 }}>Registrations & approvals</li>
                  <li style={{ marginBottom: 4 }}>Users & permissions</li>
                </ul>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 20,
                    fontSize: 14,
                    color: "#374151",
                  }}
                >
                  <li style={{ marginBottom: 4 }}>Locations</li>
                  <li style={{ marginBottom: 4 }}>Wishlist items</li>
                  <li style={{ marginBottom: 4 }}>
                    Store B2B settings (logo, colors, emails)
                  </li>
                </ul>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 12,
                  background: "#fee2e2",
                  borderRadius: 6,
                  marginBottom: 20,
                }}
              >
                <span
                  style={{
                    fontSize: 18,
                    color: "#dc2626",
                    fontWeight: "bold",
                    flexShrink: 0,
                  }}
                >
                  ⚠
                </span>
                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    color: "#7f1d1d",
                    fontWeight: 600,
                  }}
                >
                  This action cannot be undone.
                </p>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  onClick={() => setShowDeleteModal(true)}
                  disabled={isDeleting}
                  style={{
                    padding: "10px 16px",
                    background: isDeleting ? "#f87171" : "#dc2626",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: isDeleting ? "not-allowed" : "pointer",
                    opacity: isDeleting ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!isDeleting) {
                      e.currentTarget.style.background = "#b91c1c";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isDeleting) {
                      e.currentTarget.style.background = "#dc2626";
                    }
                  }}
                >
                  {isDeleting ? "Deleting..." : "Delete App Data"}
                </button>
              </div>
            </div>
          </div>

          {/* Delete Confirmation Modal */}
          {showDeleteModal && (
            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(0, 0, 0, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
              onClick={() => !isDeleting && setShowDeleteModal(false)}
            >
              <div
                style={{
                  background: "#fff",
                  borderRadius: 12,
                  padding: 24,
                  maxWidth: 500,
                  width: "90%",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    marginBottom: 12,
                    color: "#dc2626",
                  }}
                >
                  ⚠️ Confirm Deletion
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    color: "#374151",
                    marginBottom: 16,
                    lineHeight: 1.6,
                  }}
                >
                  You are about to{" "}
                  <strong>permanently delete all B2B portal data</strong> for
                  this store. This includes:
                </p>

                <ul
                  style={{
                    fontSize: 14,
                    color: "#374151",
                    marginBottom: 24,
                    paddingLeft: 20,
                    lineHeight: 1.8,
                  }}
                >
                  <li>All companies and their contacts</li>
                  <li>All registration submissions</li>
                  <li>All users and their sessions</li>
                  <li>All orders and payment records</li>
                  <li>All credit accounts and transactions</li>
                  <li>All locations and wishlist items</li>
                  <li>All store B2B settings</li>
                </ul>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: 12,
                    background: "#fee2e2",
                    borderRadius: 6,
                    marginBottom: 20,
                  }}
                >
                  <span
                    style={{
                      fontSize: 18,
                      color: "#dc2626",
                      fontWeight: "bold",
                    }}
                  >
                    ⚠
                  </span>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 13,
                      color: "#7f1d1d",
                      fontWeight: 600,
                    }}
                  >
                    This action is <strong>irreversible</strong>. All data will
                    be permanently lost.
                  </p>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    onClick={() => setShowDeleteModal(false)}
                    disabled={isDeleting}
                    style={{
                      padding: "10px 16px",
                      background: "#fff",
                      color: "#374151",
                      border: "1px solid #d1d5prisma",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: isDeleting ? "not-allowed" : "pointer",
                      opacity: isDeleting ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!isDeleting) {
                        e.currentTarget.style.background = "#f9fafb";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isDeleting) {
                        e.currentTarget.style.background = "#fff";
                      }
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting}
                    style={{
                      padding: "10px 16px",
                      background: isDeleting ? "#f87171" : "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: isDeleting ? "not-allowed" : "pointer",
                      opacity: isDeleting ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!isDeleting) {
                        e.currentTarget.style.background = "#b91c1c";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isDeleting) {
                        e.currentTarget.style.background = "#dc2626";
                      }
                    }}
                  >
                    {isDeleting
                      ? "Deleting all data..."
                      : "Yes, Delete Everything"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </s-card>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
