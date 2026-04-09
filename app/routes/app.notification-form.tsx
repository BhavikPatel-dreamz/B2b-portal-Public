import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type TemplateItem = {
  id: TemplateId;
  title: string;
  description: string;
  editorTitle: string;
  helperText: string;
  initialHtml: string;
  audience: "customer" | "admin";
};

type TemplateId =
  | "customer-application-received"
  | "customer-application-approved"
  | "customer-application-rejected"
  | "admin-application-received";

type TemplateStoreValues = Record<
  TemplateId,
  {
    enabled: boolean;
    html: string;
  }
>;

type LoaderData = {
  storeName: string;
  templates: TemplateStoreValues;
};

type ActionData = {
  success: boolean;
  message?: string;
  errors?: string[];
  templateId?: TemplateId;
  html?: string;
  enabled?: boolean;
};

const ToolbarButton = ({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    style={{
      width: 34,
      height: 34,
      background: "#ffffff",
      border: "1px solid #c9cccf",
      borderRadius: 8,
      cursor: "pointer",
      fontSize: 14,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#303030",
      flexShrink: 0,
    }}
  >
    {children}
  </button>
);

const TEMPLATE_ITEMS: TemplateItem[] = [
  {
    id: "customer-application-received",
    title: "Application received",
    description:
      "This email is sent to a customer when they submit the company application form.",
    editorTitle: "Application received email template",
    helperText:
      "This email is sent to a customer when they submit the company application form.",
    initialHtml:
      "Hello {{contactName}},<br /><br />We have received your B2B registration request for {{companyName}} on {{shopName}}.",
    audience: "customer",
  },
  {
    id: "customer-application-approved",
    title: "Application approved",
    description:
      "This email is sent to a customer when their company account is approved.",
    editorTitle: "Application approved email template",
    helperText:
      "This email is sent to a customer when their company account is approved and they can begin placing orders.",
    initialHtml:
      "Hello {{contactName}},<br /><br />Your company account for {{companyName}} has been approved. You can now begin placing orders on {{shopName}}.",
    audience: "customer",
  },
  {
    id: "customer-application-rejected",
    title: "Application rejected",
    description:
      "This email is sent to a customer when their company application is rejected.",
    editorTitle: "Application rejected email template",
    helperText:
      "This email is sent to a customer when their B2B registration request is rejected.",
    initialHtml:
      "Hello {{contactName}},<br /><br />Your B2B application for {{companyName}} has been rejected. Please contact {{storeOwnerName}} for more information.",
    audience: "customer",
  },
  {
    id: "admin-application-received",
    title: "New company registration",
    description:
      "This email is sent to the admin when a new company submits a B2B registration request.",
    editorTitle: "New Company Registration Email Template",
    helperText:
      "This email is sent to the store owner when a new company submits a B2B registration request.",
    initialHtml:
      "Hello {{storeOwnerName}},<br /><br />A new company has submitted a B2B registration request on {{shopName}}.",
    audience: "admin",
  },
];

const TEMPLATE_VARIABLES = [
  { variable: "{{companyName}}", description: "Applying company's name" },
  { variable: "{{contactName}}", description: "Contact person's name" },
  { variable: "{{email}}", description: "Contact email address" },
  { variable: "{{storeOwnerName}}", description: "Store owner's name" },
  { variable: "{{shopName}}", description: "Shopify store's name" },
];

function createDefaultTemplateValues(): TemplateStoreValues {
  return {
    "customer-application-received": {
      enabled: true,
      html: TEMPLATE_ITEMS.find((item) => item.id === "customer-application-received")!
        .initialHtml,
    },
    "customer-application-approved": {
      enabled: true,
      html: TEMPLATE_ITEMS.find((item) => item.id === "customer-application-approved")!
        .initialHtml,
    },
    "customer-application-rejected": {
      enabled: true,
      html: TEMPLATE_ITEMS.find((item) => item.id === "customer-application-rejected")!
        .initialHtml,
    },
    "admin-application-received": {
      enabled: true,
      html: TEMPLATE_ITEMS.find((item) => item.id === "admin-application-received")!
        .initialHtml,
    },
  };
}

function getTemplateDbMapping(templateId: TemplateId) {
  switch (templateId) {
    case "customer-application-received":
      return {
        enabledField: "customerRegistration",
        templateField: "customerRegistrationTemplate",
      } as const;
    case "customer-application-approved":
      return {
        enabledField: "customerRegistrationApproved",
        templateField: "customerRegistrationApprovedTemplate",
      } as const;
    case "customer-application-rejected":
      return {
        enabledField: "customerRegistrationRejectd",
        templateField: "customerRegistrationRejectedTemplate",
      } as const;
    case "admin-application-received":
      return {
        enabledField: "adminRequest",
        templateField: "adminRequestTemplate",
      } as const;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: {
      id: true,
      shopName: true,
    },
  });

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }
  const defaultValues = createDefaultTemplateValues();
  const record = await prisma.emailTemplates.findFirst({
    where: { shopId: store.id },
    orderBy: { updatedAt: "desc" },
  });

  const templates: TemplateStoreValues = record
    ? {
        "customer-application-received": {
          enabled: record.customerRegistration ?? false,
          html:
            record.customerRegistrationTemplate ||
            defaultValues["customer-application-received"].html,
        },
        "customer-application-approved": {
          enabled: record.customerRegistrationApproved ?? false,
          html:
            record.customerRegistrationApprovedTemplate ||
            defaultValues["customer-application-approved"].html,
        },
        "customer-application-rejected": {
          enabled: record.customerRegistrationRejectd ?? false,
          html:
            record.customerRegistrationRejectedTemplate ||
            defaultValues["customer-application-rejected"].html,
        },
        "admin-application-received": {
          enabled: record.adminRequest ?? false,
          html:
            record.adminRequestTemplate ||
            defaultValues["admin-application-received"].html,
        },
      }
    : defaultValues;

  return Response.json({
    storeName: store.shopName || session.shop,
    templates,
  } satisfies LoaderData);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!store) {
    return Response.json(
      { success: false, errors: ["Store not found"] } satisfies ActionData,
      { status: 404 },
    );
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (!["saveTemplate", "toggleCustomerNotifications", "toggleAdminNotifications"].includes(intent)) {
    return Response.json(
      { success: false, errors: ["Unknown intent"] } satisfies ActionData,
      { status: 400 },
    );
  }

  if (intent === "toggleCustomerNotifications") {
    const enabled = String(formData.get("enabled") || "true") === "true";
    const defaults = createDefaultTemplateValues();
    const existing = await prisma.emailTemplates.findFirst({
      where: { shopId: store.id },
      orderBy: { updatedAt: "desc" },
    });

    const toggleData = {
      customerRegistration: enabled,
      customerRegistrationApproved: enabled,
      customerRegistrationRejectd: enabled,
      customerRegistrationTemplate:
        existing?.customerRegistrationTemplate ||
        defaults["customer-application-received"].html,
      customerRegistrationApprovedTemplate:
        existing?.customerRegistrationApprovedTemplate ||
        defaults["customer-application-approved"].html,
      customerRegistrationRejectedTemplate:
        existing?.customerRegistrationRejectedTemplate ||
        defaults["customer-application-rejected"].html,
      adminRequest: existing?.adminRequest ?? true,
      adminRequestTemplate:
        existing?.adminRequestTemplate ||
        defaults["admin-application-received"].html,
    };

    if (existing) {
      await prisma.emailTemplates.update({
        where: { id: existing.id },
        data: toggleData,
      });
    } else {
      await prisma.emailTemplates.create({
        data: {
          shopId: store.id,
          ...toggleData,
        },
      });
    }

    return Response.json({
      success: true,
      message: enabled ? "Customer notifications turned on" : "Customer notifications turned off",
      enabled,
    } satisfies ActionData);
  }

  if (intent === "toggleAdminNotifications") {
    const enabled = String(formData.get("enabled") || "true") === "true";
    const defaults = createDefaultTemplateValues();
    const existing = await prisma.emailTemplates.findFirst({
      where: { shopId: store.id },
      orderBy: { updatedAt: "desc" },
    });

    const toggleData = {
      customerRegistration: existing?.customerRegistration ?? true,
      customerRegistrationApproved: existing?.customerRegistrationApproved ?? true,
      customerRegistrationRejectd: existing?.customerRegistrationRejectd ?? true,
      customerRegistrationTemplate:
        existing?.customerRegistrationTemplate ||
        defaults["customer-application-received"].html,
      customerRegistrationApprovedTemplate:
        existing?.customerRegistrationApprovedTemplate ||
        defaults["customer-application-approved"].html,
      customerRegistrationRejectedTemplate:
        existing?.customerRegistrationRejectedTemplate ||
        defaults["customer-application-rejected"].html,
      adminRequest: enabled,
      adminRequestTemplate:
        existing?.adminRequestTemplate ||
        defaults["admin-application-received"].html,
    };

    if (existing) {
      await prisma.emailTemplates.update({
        where: { id: existing.id },
        data: toggleData,
      });
    } else {
      await prisma.emailTemplates.create({
        data: {
          shopId: store.id,
          ...toggleData,
        },
      });
    }

    return Response.json({
      success: true,
      message: enabled ? "Admin notifications turned on" : "Admin notifications turned off",
      enabled,
    } satisfies ActionData);
  }

  const templateId = String(formData.get("templateId") || "") as TemplateId;
  const html = String(formData.get("html") || "").trim();
  const enabled = String(formData.get("enabled") || "true") === "true";

  if (!TEMPLATE_ITEMS.some((item) => item.id === templateId)) {
    return Response.json(
      { success: false, errors: ["Invalid template id"] } satisfies ActionData,
      { status: 400 },
    );
  }

  if (!html) {
    return Response.json(
      { success: false, errors: ["Template content is required"] } satisfies ActionData,
      { status: 400 },
    );
  }

  const mapping = getTemplateDbMapping(templateId);
  const existing = await prisma.emailTemplates.findFirst({
    where: { shopId: store.id },
    orderBy: { updatedAt: "desc" },
  });

  const data = {
    [mapping.enabledField]: enabled,
    [mapping.templateField]: html,
  };

  if (existing) {
    await prisma.emailTemplates.update({
      where: { id: existing.id },
      data,
    });
  } else {
    await prisma.emailTemplates.create({
      data: {
        shopId: store.id,
        ...data,
      },
    });
  }

  return Response.json({
    success: true,
    message: "Template saved",
    templateId,
    html,
    enabled,
  } satisfies ActionData);
};

export default function NotificationForm() {
  const { storeName, templates: loaderTemplates } =
    useLoaderData<typeof loader>() as LoaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const saveFetcher = useFetcher<ActionData>();
  const toggleFetcher = useFetcher<ActionData>();
  const adminToggleFetcher = useFetcher<ActionData>();
  const [showDropdown, setShowDropdown] = useState(false);
  const [templateValues, setTemplateValues] =
    useState<TemplateStoreValues>(loaderTemplates);
  const [editorHasContent, setEditorHasContent] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const selectedTemplateId = searchParams.get("template") as TemplateId | null;

  const selectedTemplate = useMemo(
    () => TEMPLATE_ITEMS.find((template) => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId],
  );

  useEffect(() => {
    setTemplateValues(loaderTemplates);
  }, [loaderTemplates]);

  useEffect(() => {
    if (!selectedTemplate || !editorRef.current) {
      return;
    }

    editorRef.current.innerHTML = templateValues[selectedTemplate.id].html;
    setEditorHasContent(editorRef.current.innerText.trim().length > 0);
  }, [selectedTemplate, templateValues]);

  useEffect(() => {
    if (!saveFetcher.data?.success || !saveFetcher.data.templateId || !saveFetcher.data.html) {
      return;
    }

    setTemplateValues((prev) => ({
      ...prev,
      [saveFetcher.data!.templateId!]: {
        enabled: saveFetcher.data!.enabled ?? true,
        html: saveFetcher.data!.html!,
      },
    }));
  }, [saveFetcher.data]);

  useEffect(() => {
    if (!toggleFetcher.data?.success || typeof toggleFetcher.data.enabled !== "boolean") {
      return;
    }

    setTemplateValues((prev) => ({
      ...prev,
      "customer-application-received": {
        ...prev["customer-application-received"],
        enabled: toggleFetcher.data!.enabled!,
      },
      "customer-application-approved": {
        ...prev["customer-application-approved"],
        enabled: toggleFetcher.data!.enabled!,
      },
      "customer-application-rejected": {
        ...prev["customer-application-rejected"],
        enabled: toggleFetcher.data!.enabled!,
      },
    }));
  }, [toggleFetcher.data]);

  useEffect(() => {
    if (!adminToggleFetcher.data?.success || typeof adminToggleFetcher.data.enabled !== "boolean") {
      return;
    }

    setTemplateValues((prev) => ({
      ...prev,
      "admin-application-received": {
        ...prev["admin-application-received"],
        enabled: adminToggleFetcher.data!.enabled!,
      },
    }));
  }, [adminToggleFetcher.data]);

  const format = (command: string) => {
    document.execCommand(command, false);
    editorRef.current?.focus();
  };

  const handleEditorInput = () => {
    if (!editorRef.current) {
      return;
    }

    setEditorHasContent(editorRef.current.innerText.trim().length > 0);
  };

  const insertVariable = (variable: string) => {
    if (!editorRef.current) {
      return;
    }

    const selection = window.getSelection();

    if (!selection || !selection.rangeCount) {
      editorRef.current.focus();
      return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const textNode = document.createTextNode(variable);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);

    handleEditorInput();
    editorRef.current.focus();
    setShowDropdown(false);
  };

  const saveCurrentTemplate = () => {
    if (!selectedTemplate || !editorRef.current) {
      return;
    }

    saveFetcher.submit(
      {
        intent: "saveTemplate",
        templateId: selectedTemplate.id,
        html: editorRef.current.innerHTML,
        enabled: "true",
      },
      { method: "post" },
    );
  };

  const customerTemplates = TEMPLATE_ITEMS.filter((item) => item.audience === "customer");
  const adminTemplates = TEMPLATE_ITEMS.filter((item) => item.audience === "admin");
  const customerNotificationsEnabled = customerTemplates.every(
    (item) => templateValues[item.id].enabled,
  );
  const adminNotificationsEnabled = adminTemplates.every(
    (item) => templateValues[item.id].enabled,
  );

  if (selectedTemplate) {
    return (
      <s-page>
        <div
          style={{
            background: "#f6f6f7",
            minHeight: "100vh",
            padding: "8px 28px 40px",
          }}
        >
          <div style={{ maxWidth: 1080, margin: "0 auto" }}>
            <button
              type="button"
              onClick={() => setSearchParams({})}
              style={{
                border: "none",
                background: "transparent",
                color: "#0a61c7",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                padding: 0,
                marginBottom: 18,
              }}
            >
              Back to notifications
            </button>

            <div
              style={{
                background: "#ffffff",
                border: "1px solid #d8dadd",
                borderRadius: 16,
                boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                padding: 18,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 16,
                  marginBottom: 14,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <h2
                    style={{
                      margin: "0 0 6px",
                      fontSize: 16,
                      lineHeight: 1.2,
                      fontWeight: 700,
                      color: "#303030",
                    }}
                  >
                    {selectedTemplate.editorTitle}
                  </h2>
                  <div style={{ fontSize: 12, color: "#6d7175" }}>
                    Saving for {storeName}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {saveFetcher.data?.message ? (
                    <span style={{ fontSize: 12, color: "#008060", fontWeight: 600 }}>
                      {saveFetcher.data.message}
                    </span>
                  ) : null}
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={saveCurrentTemplate}
                    loading={saveFetcher.state !== "idle"}
                  >
                    Save template
                  </s-button>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  padding: 8,
                  background: "#f6f6f7",
                  border: "1px solid #c9cccf",
                  borderRadius: "10px 10px 0 0",
                }}
              >
                <ToolbarButton onClick={() => format("bold")} title="Bold">
                  <strong>B</strong>
                </ToolbarButton>
                <ToolbarButton onClick={() => format("italic")} title="Italic">
                  <em>I</em>
                </ToolbarButton>
                <ToolbarButton onClick={() => format("underline")} title="Underline">
                  <u>U</u>
                </ToolbarButton>
                <div style={{ width: 1, background: "#c9cccf", margin: "0 2px" }} />
                <ToolbarButton
                  onClick={() => format("insertUnorderedList")}
                  title="Bullet list"
                >
                  ≡
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => format("insertOrderedList")}
                  title="Numbered list"
                >
                  ≣
                </ToolbarButton>
                <div style={{ width: 1, background: "#c9cccf", margin: "0 2px" }} />
                <ToolbarButton onClick={() => format("justifyLeft")} title="Align left">
                  ⫷
                </ToolbarButton>
                <ToolbarButton onClick={() => format("justifyCenter")} title="Align center">
                  ≡
                </ToolbarButton>
                <ToolbarButton onClick={() => format("justifyRight")} title="Align right">
                  ⫸
                </ToolbarButton>
                <div style={{ width: 1, background: "#c9cccf", margin: "0 2px" }} />
                <ToolbarButton onClick={() => format("removeFormat")} title="Clear format">
                  ✕
                </ToolbarButton>
              </div>

              <div style={{ position: "relative" }}>
                {!editorHasContent && (
                  <div
                    style={{
                      position: "absolute",
                      top: 14,
                      left: 12,
                      right: 12,
                      color: "#8c9196",
                      fontSize: 14,
                      pointerEvents: "none",
                      lineHeight: 1.65,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {templateValues[selectedTemplate.id].html
                      .replace(/<br\s*\/?>/g, "\n")
                      .replace(/<[^>]*>/g, "")}
                  </div>
                )}

                <div
                  ref={editorRef}
                  contentEditable
                  onInput={handleEditorInput}
                  style={{
                    padding: "12px 12px",
                    border: "1px solid #c9cccf",
                    borderTop: "none",
                    borderRadius: "0 0 10px 10px",
                    fontSize: 14,
                    outline: "none",
                    minHeight: 140,
                    background: "#fff",
                    lineHeight: 1.65,
                    color: "#303030",
                  }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                  marginTop: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#6d7175",
                    flex: 1,
                    minWidth: 240,
                  }}
                >
                  {selectedTemplate.helperText}
                </div>

                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => setShowDropdown((prev) => !prev)}
                    style={{
                      padding: "8px 12px",
                      background: "#ffffff",
                      color: "#202223",
                      border: "1px solid #c9cccf",
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    Available variables
                    <span style={{ fontSize: 11 }}>⌄</span>
                  </button>

                  {showDropdown && (
                    <div
                      style={{
                        position: "absolute",
                        right: 0,
                        top: "calc(100% + 6px)",
                        width: 320,
                        background: "#ffffff",
                        border: "1px solid #c9cccf",
                        borderRadius: 10,
                        boxShadow: "0 10px 24px rgba(15, 23, 42, 0.12)",
                        padding: 8,
                        zIndex: 20,
                      }}
                    >
                      <div style={{ display: "grid", gap: 4 }}>
                        {TEMPLATE_VARIABLES.map(({ variable, description }) => (
                          <button
                            key={variable}
                            type="button"
                            onClick={() => insertVariable(variable)}
                            style={{
                              padding: "8px 10px",
                              border: "none",
                              background: "#ffffff",
                              borderRadius: 8,
                              textAlign: "left",
                              cursor: "pointer",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "#303030",
                                marginBottom: 2,
                              }}
                            >
                              {variable}
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: "#6d7175",
                              }}
                            >
                              {description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    <s-page>
      <div
        style={{
          background: "#f6f6f7",
          minHeight: "100vh",
          padding: "8px 28px 40px",
        }}
      >
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <h1
            style={{
              margin: "0 0 24px",
              fontSize: 22,
              lineHeight: 1.2,
              fontWeight: 700,
              color: "#303030",
            }}
          >
            Email notifications
          </h1>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "290px minmax(0, 1fr)",
              gap: 36,
              alignItems: "start",
            }}
          >
            <div style={{ paddingTop: 18 }}>
              <h2
                style={{
                  margin: "0 0 8px",
                  fontSize: 16,
                  lineHeight: 1.2,
                  fontWeight: 700,
                  color: "#303030",
                }}
              >
                Customer notifications
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "#6d7175",
                  fontSize: 14,
                  lineHeight: 1.5,
                  fontWeight: 600,
                }}
              >
                Manage the customer email templates for registration events.
              </p>
            </div>

            <div style={{ display: "grid", gap: 18 }}>
              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 14,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 15,
                        fontWeight: 600,
                        color: "#303030",
                      }}
                    >
                      Admin email notifications
                    </h3>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: 30,
                        height: 20,
                        padding: "0 10px",
                        borderRadius: 999,
                        background: adminNotificationsEnabled ? "#a7f3b7" : "#f1f2f4",
                        color: adminNotificationsEnabled ? "#166534" : "#6d7175",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {adminNotificationsEnabled ? "On" : "Off"}
                    </span>
                    {adminToggleFetcher.data?.message ? (
                      <span style={{ fontSize: 12, color: "#008060", fontWeight: 600 }}>
                        Success
                      </span>
                    ) : null}
                  </div>

                  <adminToggleFetcher.Form method="post">
                    <input type="hidden" name="intent" value="toggleAdminNotifications" />
                    <input
                      type="hidden"
                      name="enabled"
                      value={adminNotificationsEnabled ? "false" : "true"}
                    />
                    <s-button
                      type="submit"
                      variant="secondary"
                      loading={adminToggleFetcher.state !== "idle"}
                    >
                      {adminNotificationsEnabled ? "Turn off" : "Turn on"}
                    </s-button>
                  </adminToggleFetcher.Form>
                </div>

                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    color: "#303030",
                    lineHeight: 1.6,
                    fontWeight: 600,
                  }}
                >
                  Admins can receive notifications when a new company registration is submitted.
                </p>
              </section>

              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 14,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 15,
                        fontWeight: 600,
                        color: "#303030",
                      }}
                    >
                      Customer email notifications
                    </h3>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: 30,
                        height: 20,
                        padding: "0 10px",
                        borderRadius: 999,
                        background: customerNotificationsEnabled ? "#a7f3b7" : "#f1f2f4",
                        color: customerNotificationsEnabled ? "#166534" : "#6d7175",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {customerNotificationsEnabled ? "On" : "Off"}
                    </span>
                    {toggleFetcher.data?.message ? (
                      <span style={{ fontSize: 12, color: "#008060", fontWeight: 600 }}>
                        Success
                      </span>
                    ) : null}
                  </div>

                  <toggleFetcher.Form method="post">
                    <input type="hidden" name="intent" value="toggleCustomerNotifications" />
                    <input
                      type="hidden"
                      name="enabled"
                      value={customerNotificationsEnabled ? "false" : "true"}
                    />
                    <s-button
                      type="submit"
                      variant="secondary"
                      loading={toggleFetcher.state !== "idle"}
                    >
                      {customerNotificationsEnabled ? "Turn off" : "Turn on"}
                    </s-button>
                  </toggleFetcher.Form>
                </div>

                <p
                  style={{
                    margin: "0 0 10px",
                    fontSize: 14,
                    color: "#303030",
                    lineHeight: 1.45,
                  }}
                >
                  Customers can receive notifications when:
                </p>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 20,
                    color: "#303030",
                    fontSize: 14,
                    lineHeight: 1.75,
                    fontWeight: 600,
                  }}
                >
                  <li>Their application is pending review</li>
                  <li>Their application is approved</li>
                  <li>Their application is rejected</li>
                </ul>
              </section>

              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 14,
                  }}
                >
                  <div>
                    <h3
                      style={{
                        margin: "0 0 8px",
                        fontSize: 15,
                        fontWeight: 600,
                        color: "#303030",
                      }}
                    >
                      Sender email
                    </h3>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          color: "#303030",
                          fontWeight: 500,
                        }}
                      >
                        noreply@onboardb2b.com
                      </span>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          height: 24,
                          padding: "0 10px",
                          borderRadius: 999,
                          background: "#f1f2f4",
                          color: "#6d7175",
                          fontSize: 12,
                          fontWeight: 500,
                        }}
                      >
                        App default
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    style={{
                      border: "1px solid #303030",
                      background: "#2f2f2f",
                      color: "#ffffff",
                      borderRadius: 10,
                      padding: "8px 14px",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Connect custom email domain
                  </button>
                </div>

                <p
                  style={{
                    margin: 0,
                    color: "#303030",
                    fontSize: 14,
                    lineHeight: 1.5,
                    fontWeight: 600,
                  }}
                >
                  The app is using its default sender email to send email notifications to your customers.
                </p>
              </section>

              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <h3
                  style={{
                    margin: "0 0 14px",
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#303030",
                  }}
                >
                  Customer email templates
                </h3>

                <div
                  style={{
                    border: "1px solid #eceef1",
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "#ffffff",
                  }}
                >
                  {customerTemplates.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSearchParams({ template: item.id })}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 16,
                        width: "100%",
                        padding: "14px 14px 12px",
                        background: "#ffffff",
                        border: "none",
                        borderTop: index === 0 ? "none" : "1px solid #eceef1",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            marginBottom: 4,
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#303030",
                          }}
                        >
                          {item.title}
                        </div>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 14,
                            lineHeight: 1.45,
                            color: "#6d7175",
                            fontWeight: 500,
                          }}
                        >
                          {item.description}
                        </p>
                      </div>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minWidth: 34,
                            height: 22,
                            padding: "0 10px",
                            borderRadius: 999,
                            background: templateValues[item.id].enabled ? "#d9f5e5" : "#f1f2f4",
                            color: templateValues[item.id].enabled ? "#0f5132" : "#6d7175",
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {templateValues[item.id].enabled ? "On" : "Off"}
                        </span>
                        <span
                          aria-hidden="true"
                          style={{
                            color: "#4a4f55",
                            fontSize: 28,
                            lineHeight: 1,
                          }}
                        >
                          ›
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>


          <div
            style={{
              display: "grid",
              gridTemplateColumns: "290px minmax(0, 1fr)",
              gap: 36,
              alignItems: "start",
              marginTop: 28,
            }}
          >
            <div style={{ paddingTop: 18 }}>
              <h2
                style={{
                  margin: "0 0 8px",
                  fontSize: 16,
                  lineHeight: 1.2,
                  fontWeight: 700,
                  color: "#303030",
                }}
              >
                Admin email notifications
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "#6d7175",
                  fontSize: 14,
                  lineHeight: 1.5,
                  fontWeight: 600,
                }}
              >
                Manage admin email notification content and activity for new company registration alerts.
              </p>
            </div>

            <div style={{ display: "grid", gap: 18 }}>
              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                
                <h3
                  style={{
                    margin: "0 0 14px",
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#303030",
                  }}
                >
                  Admin email templates
                </h3>

                <div
                  style={{
                    border: "1px solid #eceef1",
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "#ffffff",
                  }}
                >
                  
                  {adminTemplates.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSearchParams({ template: item.id })}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 16,
                        width: "100%",
                        padding: "14px 14px 12px",
                        background: "#ffffff",
                        border: "none",
                        borderTop: index === 0 ? "none" : "1px solid #eceef1",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            marginBottom: 4,
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#303030",
                          }}
                        >
                          {item.title}
                        </div>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 14,
                            lineHeight: 1.45,
                            color: "#6d7175",
                            fontWeight: 500,
                          }}
                        >
                          {item.description}
                        </p>
                      </div>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minWidth: 34,
                            height: 22,
                            padding: "0 10px",
                            borderRadius: 999,
                            background: templateValues[item.id].enabled ? "#d9f5e5" : "#f1f2f4",
                            color: templateValues[item.id].enabled ? "#0f5132" : "#6d7175",
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {templateValues[item.id].enabled ? "On" : "Off"}
                        </span>
                        <span
                          aria-hidden="true"
                          style={{
                            color: "#4a4f55",
                            fontSize: 28,
                            lineHeight: 1,
                          }}
                        >
                          ›
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = () => {
  return {};
};
