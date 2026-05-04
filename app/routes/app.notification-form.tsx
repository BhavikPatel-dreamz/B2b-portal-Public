import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActionFunctionArgs,
  FetcherWithComponents,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type TemplateItem = {
  id: TemplateId;
  title: string;
  description: string;
  editorTitle: string;
  helperText: string;
  initialSubject: string;
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
    subject: string;
    html: string;
    scheduleEnabled?: boolean;
    scheduleStartTime?: string;
    scheduleEndTime?: string;
  }
>;

type LoaderData = {
  storeName: string;
  storeLogo: string;
  contactEmail: string;
  templates: TemplateStoreValues;
};

type ActionData = {
  success: boolean;
  message?: string;
  errors?: string[];
  templateId?: TemplateId;
  subject?: string;
  html?: string;
  enabled?: boolean;
  storeLogo?: string;
  contactEmail?: string;
  scheduleEnabled?: boolean;
  scheduleStartTime?: string;
  scheduleEndTime?: string;
};

const PREVIEW_VARIABLE_VALUES: Record<string, string> = {
  "{{companyName}}": "Sanjay-New Company",
  "{{contactName}}": "John Doe",
  "{{email}}": "john@sanjaynew.com",
  "{{storeOwnerName}}": "Store Admin",
  "{{shopName}}": "Sanjay-New",
  "{{reviewNotes}}": "Please contact our team if you would like more details.",
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
    initialSubject: "We received your B2B registration request",
    initialHtml: `Hello {{contactName}},<br /><br />

Thank you for submitting a B2B registration request for <strong>{{companyName}}</strong> on <strong>{{shopName}}</strong>.<br /><br />

We have received your application and our team is currently reviewing it. Here is a summary of your submission:<br /><br />

<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;width:45%;">Company</td>
    <td style="padding:10px 0;color:#111827;font-weight:600;">{{companyName}}</td>
  </tr>
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;">Contact Person</td>
    <td style="padding:10px 0;color:#111827;">{{contactName}}</td>
  </tr>
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;">Email</td>
    <td style="padding:10px 0;color:#111827;">{{email}}</td>
  </tr>
  <tr>
    <td style="padding:10px 0;color:#6b7280;">Store</td>
    <td style="padding:10px 0;color:#111827;">{{shopName}}</td>
  </tr>
</table>

<div style="background:#fefce8;border-left:4px solid #ca8a04;padding:12px 16px;margin-bottom:16px;border-radius:4px;">
  <strong style="color:#854d0e;">Status: Under Review</strong><br />
  <span style="color:#713f12;font-size:13px;">Our team typically responds within 1–3 business days.</span>
</div>

Once a decision has been made, you will receive a follow-up email at <strong>{{email}}</strong>.<br /><br />

If you have any questions in the meantime, feel free to reach out to us.<br /><br />

Warm regards,<br />
<strong>{{storeOwnerName}}</strong><br />
{{shopName}}`,
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
    initialSubject: "Your B2B registration has been approved",
    initialHtml: `Hello {{contactName}},<br /><br />

Great news! Your B2B registration request for <strong>{{companyName}}</strong> on <strong>{{shopName}}</strong> has been <strong style="color:#15803d;">approved</strong>.<br /><br />

Here is a summary of your approved account:<br /><br />

<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;width:45%;">Company</td>
    <td style="padding:10px 0;color:#111827;font-weight:600;">{{companyName}}</td>
  </tr>
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;">Contact Person</td>
    <td style="padding:10px 0;color:#111827;">{{contactName}}</td>
  </tr>
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;">Email</td>
    <td style="padding:10px 0;color:#111827;">{{email}}</td>
  </tr>
  <tr>
    <td style="padding:10px 0;color:#6b7280;">Store</td>
    <td style="padding:10px 0;color:#111827;">{{shopName}}</td>
  </tr>
</table>

<div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:12px 16px;margin-bottom:16px;border-radius:4px;">
  <strong style="color:#15803d;">Status: Approved</strong><br />
  <span style="color:#166534;font-size:13px;">{{reviewNotes}}</span>
</div>

You can now log in to <strong>{{shopName}}</strong> and enjoy full B2B access including wholesale pricing, bulk ordering, and your dedicated account dashboard.<br /><br />

Welcome aboard, and thank you for partnering with us!<br /><br />

Warm regards,<br />
<strong>{{storeOwnerName}}</strong><br />
{{shopName}}`,
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
    initialSubject: "Your B2B registration has been rejected",
    initialHtml: `Hello {{contactName}},<br /><br />

Thank you for your interest in partnering with <strong>{{shopName}}</strong>. After carefully reviewing your B2B registration request for <strong>{{companyName}}</strong>, we are unable to approve your application at this time.<br /><br />

<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;width:45%;">Company</td>
    <td style="padding:10px 0;color:#111827;font-weight:600;">{{companyName}}</td>
  </tr>
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;">Contact Person</td>
    <td style="padding:10px 0;color:#111827;">{{contactName}}</td>
  </tr>
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:10px 0;color:#6b7280;">Email</td>
    <td style="padding:10px 0;color:#111827;">{{email}}</td>
  </tr>
  <tr>
    <td style="padding:10px 0;color:#111827;">Store</td>
    <td style="padding:10px 0;color:#111827;">{{shopName}}</td>
  </tr>
</table>

<div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px 16px;margin-bottom:16px;border-radius:4px;">
  <strong style="color:#b91c1c;">Status: Not Approved</strong><br />
  <span style="color:#991b1b;font-size:13px;">{{reviewNotes}}</span>
</div>

If you believe this decision was made in error or your circumstances have changed, you are welcome to submit a new request or contact us directly for further clarification.<br /><br />

We appreciate your understanding and wish you the best.<br /><br />

Warm regards,<br />
<strong>{{storeOwnerName}}</strong><br />
{{shopName}}`,
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
    initialSubject: "New B2B registration request from {{companyName}}",
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
  { variable: "{{reviewNotes}}", description: "Approval or rejection note" },
];

function createDefaultTemplateValues(): TemplateStoreValues {
  return {
    "customer-application-received": {
      enabled: false,
      subject: TEMPLATE_ITEMS.find(
        (item) => item.id === "customer-application-received",
      )!.initialSubject,
      html: TEMPLATE_ITEMS.find(
        (item) => item.id === "customer-application-received",
      )!.initialHtml,
    },
    "customer-application-approved": {
      enabled: false,
      subject: TEMPLATE_ITEMS.find(
        (item) => item.id === "customer-application-approved",
      )!.initialSubject,
      html: TEMPLATE_ITEMS.find(
        (item) => item.id === "customer-application-approved",
      )!.initialHtml,
    },
    "customer-application-rejected": {
      enabled: false,
      subject: TEMPLATE_ITEMS.find(
        (item) => item.id === "customer-application-rejected",
      )!.initialSubject,
      html: TEMPLATE_ITEMS.find(
        (item) => item.id === "customer-application-rejected",
      )!.initialHtml,
    },
    "admin-application-received": {
      enabled: false,
      subject: TEMPLATE_ITEMS.find(
        (item) => item.id === "admin-application-received",
      )!.initialSubject,
      html: TEMPLATE_ITEMS.find(
        (item) => item.id === "admin-application-received",
      )!.initialHtml,
    },
  };
}

function getTemplateDbMapping(templateId: TemplateId) {
  switch (templateId) {
    case "customer-application-received":
      return {
        enabledField: "customerRegistration",
        subjectField: "customerRegistrationSubject",
        templateField: "customerRegistrationTemplate",
      } as const;
    case "customer-application-approved":
      return {
        enabledField: "customerRegistrationApproved",
        subjectField: "customerRegistrationApprovedSubject",
        templateField: "customerRegistrationApprovedTemplate",
      } as const;
    case "customer-application-rejected":
      return {
        enabledField: "customerRegistrationRejected",
        subjectField: "customerRegistrationRejectedSubject",
        templateField: "customerRegistrationRejectedTemplate",
      } as const;
    case "admin-application-received":
      return {
        enabledField: "adminRequest",
        subjectField: "adminRequestSubject",
        templateField: "adminRequestTemplate",
      } as const;
  }
}

const decodeHtml = (html: string) => {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
};

function buildPreviewHtml(subject: string, html: string, logoUrl?: string) {
  const replacePreviewVariables = (value: string) =>
    Object.entries(PREVIEW_VARIABLE_VALUES).reduce(
      (content, [variable, replacement]) =>
        content.replaceAll(variable, replacement),
      value,
    );

  const resolvedSubject = replacePreviewVariables(subject);
  const resolvedHtml = decodeHtml(replacePreviewVariables(html));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${resolvedSubject}</title>

<style>
  body {
    margin: 0;
    padding: 24px;
    background: #f3f4f6;
    font-family: Arial, sans-serif;
  }

  /* Email wrapper */
  .email-wrapper {
    width: 100%;
    table-layout: fixed;
    background: #f3f4f6;
    padding: 24px 0;
  }

  .email-container {
    max-width: 720px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid #e5e7eb;
  }

  .email-header {
    padding: 24px;
    border-bottom: 1px solid #e5e7eb;
  }

  .email-content {
    padding: 24px;
    font-size: 15px;
    line-height: 1.6;
    color: #303030;
    word-break: break-word;
  }

  .email-footer {
    padding: 16px 24px;
    font-size: 12px;
    color: #6b7280;
    border-top: 1px solid #e5e7eb;
  }

  /* 🔥 IMPORTANT FIXES */
  .email-content table {
    width: 100%;
    border-collapse: collapse;
  }

  .email-content img {
    max-width: 100%;
    height: auto;
    display: block;
  }

  .email-content a {
    color: #0a61c7;
    text-decoration: none;
  }

  .btn {
    display: inline-block;
    padding: 12px 20px;
    background: #0a61c7;
    color: #ffffff !important;
    text-decoration: none;
    border-radius: 6px;
    font-weight: 600;
  }
</style>
</head>

<body>
  <table class="email-wrapper" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">

        <table class="email-container" cellpadding="0" cellspacing="0">
          
          <!-- HEADER -->
          <tr>
            <td class="email-header">
              ${
                logoUrl
                  ? `<img src="${logoUrl}" style="max-height:60px; margin-bottom:12px;" />`
                  : ""
              }
              <h2 style="margin:0; font-size:20px;">${resolvedSubject}</h2>
            </td>
          </tr>

          <!-- CONTENT -->
          <tr>
            <td class="email-content">
              ${resolvedHtml}
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td class="email-footer">
              Preview using sample data
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: {
      id: true,
      shopName: true,
      logo: true,
      contactEmail: true,
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
          subject:
            record.customerRegistrationSubject ||
            defaultValues["customer-application-received"].subject,
          html:
            record.customerRegistrationTemplate ||
            defaultValues["customer-application-received"].html,
        },
        "customer-application-approved": {
          enabled: record.customerRegistrationApproved ?? false,
          subject:
            record.customerRegistrationApprovedSubject ||
            defaultValues["customer-application-approved"].subject,
          html:
            record.customerRegistrationApprovedTemplate ||
            defaultValues["customer-application-approved"].html,
        },
        "customer-application-rejected": {
          enabled: record.customerRegistrationRejected ?? false,
          subject:
            record.customerRegistrationRejectedSubject ||
            defaultValues["customer-application-rejected"].subject,
          html:
            record.customerRegistrationRejectedTemplate ||
            defaultValues["customer-application-rejected"].html,
        },
        "admin-application-received": {
          enabled: record.adminRequest ?? false,
          subject:
            record.adminRequestSubject ||
            defaultValues["admin-application-received"].subject,
          html:
            record.adminRequestTemplate ||
            defaultValues["admin-application-received"].html,
        },
      }
    : defaultValues;

  return Response.json({
    storeName: store.shopName || session.shop,
    storeLogo: store.logo || "",
    contactEmail: store.contactEmail || "",
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
  if (
    ![
      "saveTemplate",
      "toggleCustomerNotifications",
      "toggleAdminNotifications",
      "toggleTemplateEnabled",
      "setTemplateSchedule",
      "saveLogo",
      "saveCustomEmail",
    ].includes(intent)
  ) {
    return Response.json(
      { success: false, errors: ["Unknown intent"] } satisfies ActionData,
      { status: 400 },
    );
  }

  // ── saveCustomEmail ──────────────────────────────────────────────────────────
  if (intent === "saveCustomEmail") {
    const contactEmail = String(
      formData.get("contactEmail") ?? formData.get("submissionEmail") ?? "",
    ).trim();

    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return Response.json(
        {
          success: false,
          errors: ["Please enter a valid email address."],
        } satisfies ActionData,
        { status: 400 },
      );
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { contactEmail: contactEmail || null },
    });

    return Response.json({
      success: true,
      message: contactEmail
        ? "Primary contact email saved successfully."
        : "Primary contact email removed.",
      contactEmail,
    } satisfies ActionData);
  }

  // ── saveLogo ─────────────────────────────────────────────────────────────────
  if (intent === "saveLogo") {
    const storeLogo = String(formData.get("storeLogo") || "").trim();

    if (storeLogo && !/^https?:\/\/[^\s]+$/i.test(storeLogo)) {
      return Response.json(
        {
          success: false,
          errors: [
            "Store logo must be a valid URL starting with http:// or https://",
          ],
        } satisfies ActionData,
        { status: 400 },
      );
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { logo: storeLogo || null },
    });

    return Response.json({
      success: true,
      message: storeLogo
        ? "Logo saved for all email templates"
        : "Logo removed from all email templates",
      storeLogo,
    } satisfies ActionData);
  }

  // ── toggleCustomerNotifications ──────────────────────────────────────────────
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
      customerRegistrationRejected: enabled,
      customerRegistrationSubject:
        existing?.customerRegistrationSubject ||
        defaults["customer-application-received"].subject,
      customerRegistrationTemplate:
        existing?.customerRegistrationTemplate ||
        defaults["customer-application-received"].html,
      customerRegistrationApprovedSubject:
        existing?.customerRegistrationApprovedSubject ||
        defaults["customer-application-approved"].subject,
      customerRegistrationApprovedTemplate:
        existing?.customerRegistrationApprovedTemplate ||
        defaults["customer-application-approved"].html,
      customerRegistrationRejectedSubject:
        existing?.customerRegistrationRejectedSubject ||
        defaults["customer-application-rejected"].subject,
      customerRegistrationRejectedTemplate:
        existing?.customerRegistrationRejectedTemplate ||
        defaults["customer-application-rejected"].html,
      adminRequest: existing?.adminRequest ?? false,
      adminRequestSubject:
        existing?.adminRequestSubject ||
        defaults["admin-application-received"].subject,
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
        data: { shopId: store.id, ...toggleData },
      });
    }

    return Response.json({
      success: true,
      message: enabled
        ? "Customer notifications turned on"
        : "Customer notifications turned off",
      enabled,
    } satisfies ActionData);
  }

  // ── toggleAdminNotifications ─────────────────────────────────────────────────
  if (intent === "toggleAdminNotifications") {
    const enabled = String(formData.get("enabled") || "true") === "true";
    const defaults = createDefaultTemplateValues();
    const existing = await prisma.emailTemplates.findFirst({
      where: { shopId: store.id },
      orderBy: { updatedAt: "desc" },
    });

    const toggleData = {
      customerRegistration: existing?.customerRegistration ?? false,
      customerRegistrationApproved:
        existing?.customerRegistrationApproved ?? false,
      customerRegistrationRejected:
        existing?.customerRegistrationRejected ?? false,
      customerRegistrationSubject:
        existing?.customerRegistrationSubject ||
        defaults["customer-application-received"].subject,
      customerRegistrationTemplate:
        existing?.customerRegistrationTemplate ||
        defaults["customer-application-received"].html,
      customerRegistrationApprovedSubject:
        existing?.customerRegistrationApprovedSubject ||
        defaults["customer-application-approved"].subject,
      customerRegistrationApprovedTemplate:
        existing?.customerRegistrationApprovedTemplate ||
        defaults["customer-application-approved"].html,
      customerRegistrationRejectedSubject:
        existing?.customerRegistrationRejectedSubject ||
        defaults["customer-application-rejected"].subject,
      customerRegistrationRejectedTemplate:
        existing?.customerRegistrationRejectedTemplate ||
        defaults["customer-application-rejected"].html,
      adminRequest: enabled,
      adminRequestSubject:
        existing?.adminRequestSubject ||
        defaults["admin-application-received"].subject,
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
        data: { shopId: store.id, ...toggleData },
      });
    }

    return Response.json({
      success: true,
      message: enabled
        ? "Admin notifications turned on"
        : "Admin notifications turned off",
      enabled,
    } satisfies ActionData);
  }

  // ── toggleTemplateEnabled ────────────────────────────────────────────────────
  if (intent === "toggleTemplateEnabled") {
    const templateId = String(formData.get("templateId") || "") as TemplateId;
    const enabled = String(formData.get("enabled") || "true") === "true";
    const defaults = createDefaultTemplateValues();

    if (!TEMPLATE_ITEMS.some((item) => item.id === templateId)) {
      return Response.json(
        {
          success: false,
          errors: ["Invalid template id"],
        } satisfies ActionData,
        { status: 400 },
      );
    }

    const mapping = getTemplateDbMapping(templateId);
    const existing = await prisma.emailTemplates.findFirst({
      where: { shopId: store.id },
      orderBy: { updatedAt: "desc" },
    });

    const toggleData = {
      [mapping.enabledField]: enabled,
      [mapping.subjectField]: existing
        ? existing[mapping.subjectField as keyof typeof existing]
        : defaults[templateId].subject,
      [mapping.templateField]: existing
        ? existing[mapping.templateField as keyof typeof existing]
        : defaults[templateId].html,
    };

    // Preserve other template settings
    const allData = {
      customerRegistration: existing?.customerRegistration ?? false,
      customerRegistrationApproved:
        existing?.customerRegistrationApproved ?? false,
      customerRegistrationRejected:
        existing?.customerRegistrationRejected ?? false,
      customerRegistrationSubject:
        existing?.customerRegistrationSubject ||
        defaults["customer-application-received"].subject,
      customerRegistrationTemplate:
        existing?.customerRegistrationTemplate ||
        defaults["customer-application-received"].html,
      customerRegistrationApprovedSubject:
        existing?.customerRegistrationApprovedSubject ||
        defaults["customer-application-approved"].subject,
      customerRegistrationApprovedTemplate:
        existing?.customerRegistrationApprovedTemplate ||
        defaults["customer-application-approved"].html,
      customerRegistrationRejectedSubject:
        existing?.customerRegistrationRejectedSubject ||
        defaults["customer-application-rejected"].subject,
      customerRegistrationRejectedTemplate:
        existing?.customerRegistrationRejectedTemplate ||
        defaults["customer-application-rejected"].html,
      adminRequest: existing?.adminRequest ?? false,
      adminRequestSubject:
        existing?.adminRequestSubject ||
        defaults["admin-application-received"].subject,
      adminRequestTemplate:
        existing?.adminRequestTemplate ||
        defaults["admin-application-received"].html,
      ...toggleData,
    };

    if (existing) {
      await prisma.emailTemplates.update({
        where: { id: existing.id },
        data: allData,
      });
    } else {
      await prisma.emailTemplates.create({
        data: { shopId: store.id, ...allData },
      });
    }

    return Response.json({
      success: true,
      message: enabled ? `Template enabled` : `Template disabled`,
      templateId,
      enabled,
    } satisfies ActionData);
  }

  // ── setTemplateSchedule ──────────────────────────────────────────────────────
  if (intent === "setTemplateSchedule") {
    const templateId = String(formData.get("templateId") || "") as TemplateId;
    const scheduleEnabled =
      String(formData.get("scheduleEnabled") || "false") === "true";
    const scheduleStartTime = String(
      formData.get("scheduleStartTime") || "",
    ).trim();
    const scheduleEndTime = String(
      formData.get("scheduleEndTime") || "",
    ).trim();
    const defaults = createDefaultTemplateValues();

    if (!TEMPLATE_ITEMS.some((item) => item.id === templateId)) {
      return Response.json(
        {
          success: false,
          errors: ["Invalid template id"],
        } satisfies ActionData,
        { status: 400 },
      );
    }

    if (scheduleEnabled && (!scheduleStartTime || !scheduleEndTime)) {
      return Response.json(
        {
          success: false,
          errors: [
            "Start time and end time are required when scheduling is enabled",
          ],
        } satisfies ActionData,
        { status: 400 },
      );
    }

    const mapping = getTemplateDbMapping(templateId);
    const existing = await prisma.emailTemplates.findFirst({
      where: { shopId: store.id },
      orderBy: { updatedAt: "desc" },
    });

    const scheduleData = {
      [mapping.enabledField]: existing
        ? existing[mapping.enabledField as keyof typeof existing]
        : defaults[templateId].enabled,
      [mapping.subjectField]: existing
        ? existing[mapping.subjectField as keyof typeof existing]
        : defaults[templateId].subject,
      [mapping.templateField]: existing
        ? existing[mapping.templateField as keyof typeof existing]
        : defaults[templateId].html,
      [`${mapping.enabledField.replace("Enabled", "")}ScheduleEnabled`]:
        scheduleEnabled,
      [`${mapping.enabledField.replace("Enabled", "")}ScheduleStartTime`]:
        scheduleStartTime || null,
      [`${mapping.enabledField.replace("Enabled", "")}ScheduleEndTime`]:
        scheduleEndTime || null,
    };

    // Preserve other template settings
    const allData = {
      customerRegistration: existing?.customerRegistration ?? false,
      customerRegistrationApproved:
        existing?.customerRegistrationApproved ?? false,
      customerRegistrationRejected:
        existing?.customerRegistrationRejected ?? false,
      customerRegistrationSubject:
        existing?.customerRegistrationSubject ||
        defaults["customer-application-received"].subject,
      customerRegistrationTemplate:
        existing?.customerRegistrationTemplate ||
        defaults["customer-application-received"].html,
      customerRegistrationApprovedSubject:
        existing?.customerRegistrationApprovedSubject ||
        defaults["customer-application-approved"].subject,
      customerRegistrationApprovedTemplate:
        existing?.customerRegistrationApprovedTemplate ||
        defaults["customer-application-approved"].html,
      customerRegistrationRejectedSubject:
        existing?.customerRegistrationRejectedSubject ||
        defaults["customer-application-rejected"].subject,
      customerRegistrationRejectedTemplate:
        existing?.customerRegistrationRejectedTemplate ||
        defaults["customer-application-rejected"].html,
      adminRequest: existing?.adminRequest ?? false,
      adminRequestSubject:
        existing?.adminRequestSubject ||
        defaults["admin-application-received"].subject,
      adminRequestTemplate:
        existing?.adminRequestTemplate ||
        defaults["admin-application-received"].html,
      ...scheduleData,
    };

    if (existing) {
      await prisma.emailTemplates.update({
        where: { id: existing.id },
        data: allData,
      });
    } else {
      await prisma.emailTemplates.create({
        data: { shopId: store.id, ...allData },
      });
    }

    return Response.json({
      success: true,
      message: scheduleEnabled
        ? "Schedule set successfully"
        : "Schedule removed",
      templateId,
      scheduleEnabled,
      scheduleStartTime,
      scheduleEndTime,
    } satisfies ActionData);
  }

  // ── saveTemplate ─────────────────────────────────────────────────────────────
  const templateId = String(formData.get("templateId") || "") as TemplateId;
  const subject = String(formData.get("subject") || "").trim();
  const html = String(formData.get("html") || "").trim();
  const enabled = String(formData.get("enabled") || "true") === "true";

  if (!TEMPLATE_ITEMS.some((item) => item.id === templateId)) {
    return Response.json(
      { success: false, errors: ["Invalid template id"] } satisfies ActionData,
      { status: 400 },
    );
  }

  if (!subject) {
    return Response.json(
      {
        success: false,
        errors: ["Email subject is required"],
      } satisfies ActionData,
      { status: 400 },
    );
  }

  if (!html) {
    return Response.json(
      {
        success: false,
        errors: ["Template content is required"],
      } satisfies ActionData,
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
    [mapping.subjectField]: subject,
    [mapping.templateField]: html,
  };

  if (existing) {
    await prisma.emailTemplates.update({ where: { id: existing.id }, data });
  } else {
    await prisma.emailTemplates.create({ data: { shopId: store.id, ...data } });
  }

  return Response.json({
    success: true,
    message: "Template saved",
    templateId,
    subject,
    html,
    enabled,
  } satisfies ActionData);
};

function ToggleSwitch({
  enabled,
  name,
  value,
  fetcher,
  intent,
  templateId,
}: {
  enabled: boolean;
  name: string;
  value: string;
  fetcher: FetcherWithComponents<ActionData>;
  intent: string;
  templateId?: string; // ← add the ? here
}) {
  return (
    <fetcher.Form method="post" style={{ display: "inline-flex" }}>
      <input type="hidden" name="intent" value={intent} />
      {templateId && (
        <input type="hidden" name="templateId" value={templateId} />
      )}
      <input type="hidden" name={name} value={value} />
      <button
        type="submit"
        disabled={fetcher.state !== "idle"}
        aria-label={enabled ? "Turn off" : "Turn on"}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          width: 44,
          height: 24,
          borderRadius: 999,
          border: "none",
          padding: 0,
          cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
          background:
            fetcher.state !== "idle"
              ? "#c9cccf"
              : enabled
                ? "#1a8a5a"
                : "#c9cccf",
          transition: "background 0.2s ease",
          flexShrink: 0,
          opacity: fetcher.state !== "idle" ? 0.6 : 1,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: enabled ? "calc(100% - 21px)" : 3,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#ffffff",
            boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
            transition: "left 0.2s ease",
          }}
        />
      </button>
    </fetcher.Form>
  );
}

export default function NotificationForm() {
  const {
    storeName,
    storeLogo: loaderStoreLogo,
    contactEmail: loaderContactEmail,
    templates: loaderTemplates,
  } = useLoaderData<typeof loader>() as LoaderData;

  const [searchParams, setSearchParams] = useSearchParams();
  const saveFetcher = useFetcher<ActionData>();
  const toggleFetcher = useFetcher<ActionData>();
  const adminToggleFetcher = useFetcher<ActionData>();
  const logoFetcher = useFetcher<ActionData>();
  const emailDomainFetcher = useFetcher<ActionData>();
  const scheduleFetcher = useFetcher<ActionData>();
  const templateToggleFetchers = useRef<
    Record<TemplateId, ReturnType<typeof useFetcher<ActionData>>>
  >({
    "customer-application-received": useFetcher<ActionData>(),
    "customer-application-approved": useFetcher<ActionData>(),
    "customer-application-rejected": useFetcher<ActionData>(),
    "admin-application-received": useFetcher<ActionData>(),
  }).current;

  const [templateValues, setTemplateValues] =
    useState<TemplateStoreValues>(loaderTemplates);
  const [storeLogo, setStoreLogo] = useState(loaderStoreLogo);
  const [contactEmail, setContactEmail] = useState(loaderContactEmail);
  const [editorHasContent, setEditorHasContent] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailInput, setEmailInput] = useState(loaderContactEmail);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleTemplateId, setScheduleTemplateId] =
    useState<TemplateId | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleStartTime, setScheduleStartTime] = useState("");
  const [scheduleEndTime, setScheduleEndTime] = useState("");

  const editorRef = useRef<HTMLDivElement>(null);
  const selectedTemplateId = searchParams.get("template") as TemplateId | null;

  const selectedTemplate = useMemo(
    () =>
      TEMPLATE_ITEMS.find((template) => template.id === selectedTemplateId) ??
      null,
    [selectedTemplateId],
  );

  useEffect(() => {
    setTemplateValues(loaderTemplates);
  }, [loaderTemplates]);
  useEffect(() => {
    setStoreLogo(loaderStoreLogo);
  }, [loaderStoreLogo]);
  useEffect(() => {
    setContactEmail(loaderContactEmail);
    setEmailInput(loaderContactEmail);
  }, [loaderContactEmail]);

  useEffect(() => {
    if (!selectedTemplate || !editorRef.current) return;
    editorRef.current.innerHTML = templateValues[selectedTemplate.id].html;
    setEditorHasContent(editorRef.current.innerText.trim().length > 0);
  }, [selectedTemplate, templateValues]);
  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const;
  const pageHeroStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    padding: "0px 5px 16px 0px",  
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
  } as const;
  const pageHeroTextStyle = {
    fontSize: "14px",
    color: "#5c5f62",
    margin: "0 15px 0",
  } as const;
  const pageContentStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
  } as const;

  useEffect(() => {
    if (
      !saveFetcher.data?.success ||
      !saveFetcher.data.templateId ||
      !saveFetcher.data.html
    )
      return;
    setTemplateValues((prev) => ({
      ...prev,
      [saveFetcher.data!.templateId!]: {
        enabled: saveFetcher.data!.enabled ?? false,
        subject:
          saveFetcher.data!.subject ||
          prev[saveFetcher.data!.templateId!].subject,
        html: saveFetcher.data!.html!,
      },
    }));
  }, [saveFetcher.data]);

  useEffect(() => {
    if (
      !toggleFetcher.data?.success ||
      typeof toggleFetcher.data.enabled !== "boolean"
    )
      return;
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
    if (
      !adminToggleFetcher.data?.success ||
      typeof adminToggleFetcher.data.enabled !== "boolean"
    )
      return;
    setTemplateValues((prev) => ({
      ...prev,
      "admin-application-received": {
        ...prev["admin-application-received"],
        enabled: adminToggleFetcher.data!.enabled!,
      },
    }));
  }, [adminToggleFetcher.data]);

  // Handle individual template toggles
  useEffect(
    () => {
      TEMPLATE_ITEMS.forEach((item) => {
        const fetcher = templateToggleFetchers[item.id];
        if (!fetcher.data?.success || typeof fetcher.data.enabled !== "boolean")
          return;
        setTemplateValues((prev) => ({
          ...prev,
          [item.id]: { ...prev[item.id], enabled: fetcher.data!.enabled! },
        }));
      });
    },
    Object.values(templateToggleFetchers).map((f) => f.data),
  );

  useEffect(() => {
    if (
      !logoFetcher.data?.success ||
      typeof logoFetcher.data.storeLogo !== "string"
    )
      return;
    setStoreLogo(logoFetcher.data.storeLogo);
  }, [logoFetcher.data]);

  // Close modal and sync state on successful email save
  useEffect(() => {
    if (!emailDomainFetcher.data?.success) return;
    const saved = emailDomainFetcher.data.contactEmail ?? "";
    setContactEmail(saved);
    setEmailInput(saved);
    setShowEmailModal(false);
  }, [emailDomainFetcher.data]);

  // Handle schedule updates
  useEffect(() => {
    if (!scheduleFetcher.data?.success || !scheduleFetcher.data.templateId)
      return;
    setShowScheduleModal(false);
  }, [scheduleFetcher.data]);

  const format = (command: string) => {
    document.execCommand(command, false);
    editorRef.current?.focus();
  };

  const handleEditorInput = () => {
    if (!editorRef.current) return;
    setEditorHasContent(editorRef.current.innerText.trim().length > 0);
  };

  const insertVariable = (variable: string) => {
    if (!editorRef.current) return;
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
  };

  const saveCurrentTemplate = () => {
    if (!selectedTemplate || !editorRef.current) return;

    console.log("saving template...", {
      templateId: selectedTemplate.id,
      subject: templateValues[selectedTemplate.id].subject,
      html: editorRef.current.innerHTML,
    }); // ← temporary debug log

    saveFetcher.submit(
      {
        intent: "saveTemplate",
        templateId: selectedTemplate.id,
        subject: templateValues[selectedTemplate.id].subject,
        html: editorRef.current.innerHTML,
        enabled: String(templateValues[selectedTemplate.id].enabled),
      },
      { method: "post" },
    );
  };

  const customerTemplates = TEMPLATE_ITEMS.filter(
    (item) => item.audience === "customer",
  );
  const adminTemplates = TEMPLATE_ITEMS.filter(
    (item) => item.audience === "admin",
  );
  const customerNotificationsEnabled = customerTemplates.every(
    (item) => templateValues[item.id].enabled,
  );
  const adminNotificationsEnabled = adminTemplates.every(
    (item) => templateValues[item.id].enabled,
  );

  const previewDocument =
    selectedTemplate && editorRef.current
      ? buildPreviewHtml(
          templateValues[selectedTemplate.id].subject,
          editorRef.current.innerHTML ||
            templateValues[selectedTemplate.id].html,
          storeLogo,
        )
      : "";

  // ── Shared modal ─────────────────────────────────────────────────────────────
  const emailModal = showEmailModal ? (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 3000,
      }}
      onClick={() => setShowEmailModal(false)}
    >
      <div
        style={{
          width: "min(480px, 100%)",
          background: "#ffffff",
          borderRadius: 16,
          boxShadow: "0 28px 80px rgba(15, 23, 42, 0.28)",
          padding: "24px 24px 20px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 700,
              color: "#202223",
            }}
          >
            {contactEmail
              ? "Change primary contact email"
              : "Add primary contact email"}
          </h2>
          <button
            type="button"
            onClick={() => setShowEmailModal(false)}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              color: "#6d7175",
              fontSize: 24,
              lineHeight: 1,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Modal body */}
        <div style={{ marginBottom: 20 }}>
          <label
            htmlFor="modal-email-input"
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              color: "#303030",
              marginBottom: 8,
            }}
          >
            Primary contact email
          </label>
          <input
            id="modal-email-input"
            type="email"
            value={emailInput}
            onChange={(e) => setEmailInput(e.currentTarget.value)}
            placeholder="john@example.com"
            style={{
              width: "100%",
              border: "1px solid #c9cccf",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 14,
              color: "#303030",
              outline: "none",
              boxSizing: "border-box",
              background: "#ffffff",
            }}
          />
          {emailDomainFetcher.data?.errors?.length ? (
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "#d72c0d",
                lineHeight: 1.5,
              }}
            >
              {emailDomainFetcher.data.errors.join(" ")}
            </div>
          ) : null}
        </div>

        {/* Modal footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={() => setShowEmailModal(false)}
            style={{
              border: "1px solid #c9cccf",
              background: "#ffffff",
              color: "#303030",
              borderRadius: 10,
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={emailDomainFetcher.state !== "idle"}
            onClick={() => {
              emailDomainFetcher.submit(
                { intent: "saveCustomEmail", contactEmail: emailInput },
                { method: "post" },
              );
            }}
            style={{
              border: "1px solid #303030",
              background:
                emailDomainFetcher.state !== "idle" ? "#555" : "#2f2f2f",
              color: "#ffffff",
              borderRadius: 10,
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor:
                emailDomainFetcher.state !== "idle" ? "not-allowed" : "pointer",
              opacity: emailDomainFetcher.state !== "idle" ? 0.7 : 1,
            }}
            >
              {emailDomainFetcher.state !== "idle" ? "Saving…" : "Save email"}
            </button>
          </div>
        </div>
      </div>
  ) : null;

  // ── Schedule modal ────────────────────────────────────────────────────────────
  const scheduleModal =
    showScheduleModal && scheduleTemplateId ? (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(17, 24, 39, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          zIndex: 3000,
        }}
        onClick={() => setShowScheduleModal(false)}
      >
        <div
          style={{
            width: "min(480px, 100%)",
            background: "#ffffff",
            borderRadius: 16,
            boxShadow: "0 28px 80px rgba(15, 23, 42, 0.28)",
            padding: "24px 24px 20px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Modal header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 700,
                color: "#202223",
              }}
            >
              Set template schedule
            </h2>
            <button
              type="button"
              onClick={() => setShowScheduleModal(false)}
              aria-label="Close"
              style={{
                border: "none",
                background: "transparent",
                color: "#6d7175",
                fontSize: 24,
                lineHeight: 1,
                cursor: "pointer",
                padding: 0,
              }}
            >
              ×
            </button>
          </div>

          {/* Modal body */}
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 16,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.currentTarget.checked)}
                style={{ width: 18, height: 18, cursor: "pointer" }}
              />
              <span style={{ fontSize: 14, fontWeight: 600, color: "#303030" }}>
                Enable time-based scheduling
              </span>
            </label>

            {scheduleEnabled ? (
              <div style={{ display: "grid", gap: 16 }}>
                <div>
                  <label
                    htmlFor="schedule-start"
                    style={{
                      display: "block",
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#303030",
                      marginBottom: 8,
                    }}
                  >
                    Start time (when template turns ON)
                  </label>
                  <input
                    id="schedule-start"
                    type="time"
                    value={scheduleStartTime}
                    onChange={(e) =>
                      setScheduleStartTime(e.currentTarget.value)
                    }
                    style={{
                      width: "100%",
                      border: "1px solid #c9cccf",
                      borderRadius: 10,
                      padding: "10px 12px",
                      fontSize: 14,
                      color: "#303030",
                      outline: "none",
                      boxSizing: "border-box",
                      background: "#ffffff",
                    }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="schedule-end"
                    style={{
                      display: "block",
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#303030",
                      marginBottom: 8,
                    }}
                  >
                    End time (when template turns OFF)
                  </label>
                  <input
                    id="schedule-end"
                    type="time"
                    value={scheduleEndTime}
                    onChange={(e) => setScheduleEndTime(e.currentTarget.value)}
                    style={{
                      width: "100%",
                      border: "1px solid #c9cccf",
                      borderRadius: 10,
                      padding: "10px 12px",
                      fontSize: 14,
                      color: "#303030",
                      outline: "none",
                      boxSizing: "border-box",
                      background: "#ffffff",
                    }}
                  />
                </div>

                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    color: "#6d7175",
                    lineHeight: 1.5,
                  }}
                >
                  Template will be automatically enabled between start and end
                  times, then automatically disabled after end time.
                </p>
              </div>
            ) : (
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: "#6d7175",
                  lineHeight: 1.5,
                }}
              >
                Enable the checkbox to set a schedule for this template.
              </p>
            )}

            {scheduleFetcher.data?.errors?.length ? (
              <div
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: "#d72c0d",
                  lineHeight: 1.5,
                }}
              >
                {scheduleFetcher.data.errors.join(" ")}
              </div>
            ) : null}
          </div>

          {/* Modal footer */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={() => setShowScheduleModal(false)}
              style={{
                border: "1px solid #c9cccf",
                background: "#ffffff",
                color: "#303030",
                borderRadius: 10,
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={scheduleFetcher.state !== "idle"}
              onClick={() => {
                scheduleFetcher.submit(
                  {
                    intent: "setTemplateSchedule",
                    templateId: scheduleTemplateId,
                    scheduleEnabled: String(scheduleEnabled),
                    scheduleStartTime,
                    scheduleEndTime,
                  },
                  { method: "post" },
                );
              }}
              style={{
                border: "1px solid #303030",
                background:
                  scheduleFetcher.state !== "idle" ? "#555" : "#2f2f2f",
                color: "#ffffff",
                borderRadius: 10,
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 600,
                cursor:
                  scheduleFetcher.state !== "idle" ? "not-allowed" : "pointer",
                opacity: scheduleFetcher.state !== "idle" ? 0.7 : 1,
              }}
            >
              {scheduleFetcher.state !== "idle" ? "Saving…" : "Save schedule"}
            </button>
          </div>
        </div>
      </div>
    ) : null;

  // ── Sender email section (reused in both views) ───────────────────────────────
  const senderEmailSection = (
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
            <span style={{ fontSize: 14, color: "#303030", fontWeight: 500 }}>
              {contactEmail || "noreply@onboardb2b.com"}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                height: 24,
                padding: "0 10px",
                borderRadius: 999,
                background: contactEmail ? "#d9f5e5" : "#f1f2f4",
                color: contactEmail ? "#0f5132" : "#6d7175",
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {contactEmail ? "Primary contact" : "App default"}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            setEmailInput(contactEmail);
            setShowEmailModal(true);
          }}
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
          {contactEmail ? "Change email" : "Add primary contact email"}
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
        {contactEmail
          ? "Notification emails will use the Primary contact email from Store settings."
          : "Add a Primary contact email to use it for notification emails."}
      </p>

      {/* Remove primary contact email */}
      {contactEmail ? (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => {
              emailDomainFetcher.submit(
                { intent: "saveCustomEmail", contactEmail: "" },
                { method: "post" },
              );
            }}
            style={{
              border: "none",
              background: "transparent",
              color: "#d72c0d",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
            }}
          >
            Remove primary contact email
          </button>
        </div>
      ) : null}
    </section>
  );

  // ── Template editor view ──────────────────────────────────────────────────────
  if (selectedTemplate) {
    return (
      <>
        <div style={pageShellStyle}>
          <div style={pageHeroStyle}>
            <h1 style={pageHeroTitleStyle}>Notification Templates</h1>
            <p style={pageHeroTextStyle}>
              Configure branded email templates and preview customer communications.
            </p>
          </div>
          <div style={pageContentStyle}>
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
              ← Back to notifications
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
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  marginBottom: 20,
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
                  <div style={{ fontSize: 13, color: "#6d7175" }}>
                    Saving for {storeName}
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  {saveFetcher.data?.message ? (
                    <span
                      style={{
                        fontSize: 12,
                        color: "#008060",
                        fontWeight: 600,
                      }}
                    >
                      {saveFetcher.data.message}
                    </span>
                  ) : null}
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={() => setShowPreview(true)}
                  >
                    Preview
                  </s-button>
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
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) 320px",
                  gap: 16,
                  alignItems: "start",
                }}
              >
                <div
                  style={{
                    background: "#ffffff",
                    border: "1px solid #d8dadd",
                    borderRadius: 16,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "16px 16px 14px",
                      borderBottom: "1px solid #e3e5e7",
                      background: "#fbfbfb",
                    }}
                  >
                    <label
                      htmlFor="template-subject"
                      style={{
                        display: "block",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#303030",
                        marginBottom: 8,
                      }}
                    >
                      Subject
                    </label>
                    <input
                      id="template-subject"
                      type="text"
                      value={templateValues[selectedTemplate.id].subject}
                      onChange={(event) => {
                        const nextSubject = event.currentTarget.value;
                        setTemplateValues((prev) => ({
                          ...prev,
                          [selectedTemplate.id]: {
                            ...prev[selectedTemplate.id],
                            subject: nextSubject,
                          },
                        }));
                      }}
                      placeholder="Enter email subject"
                      style={{
                        width: "100%",
                        border: "1px solid #c9cccf",
                        borderRadius: 10,
                        padding: "10px 12px",
                        fontSize: 14,
                        color: "#303030",
                        outline: "none",
                        boxSizing: "border-box",
                        background: "#ffffff",
                      }}
                    />
                  </div>

                  <div style={{ padding: "16px" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        marginBottom: 8,
                      }}
                    >
                      <div
                        style={{
                          display: "block",
                          fontSize: 13,
                          fontWeight: 600,
                          color: "#303030",
                        }}
                      >
                        Content
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setTemplateValues((prev) => ({
                            ...prev,
                            [selectedTemplate.id]:
                              createDefaultTemplateValues()[
                                selectedTemplate.id
                              ],
                          }));
                          if (editorRef.current) {
                            const defaultTemplate =
                              createDefaultTemplateValues()[
                                selectedTemplate.id
                              ];
                            editorRef.current.innerHTML = defaultTemplate.html;
                            setEditorHasContent(
                              editorRef.current.innerText.trim().length > 0,
                            );
                          }
                        }}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "#0a61c7",
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        Reset to default
                      </button>
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
                          minHeight: 280,
                          background: "#fff",
                          lineHeight: 1.65,
                          color: "#303030",
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    background: "#ffffff",
                    border: "1px solid #d8dadd",
                    borderRadius: 16,
                    padding: 16,
                    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                    position: "sticky",
                    top: 16,
                  }}
                >
                  <h3
                    style={{
                      margin: "0 0 14px",
                      fontSize: 20,
                      lineHeight: 1.2,
                      fontWeight: 700,
                      color: "#303030",
                    }}
                  >
                    Liquid variables
                  </h3>
                  <p
                    style={{
                      margin: "0 0 14px",
                      fontSize: 14,
                      lineHeight: 1.5,
                      color: "#303030",
                    }}
                  >
                    {selectedTemplate.helperText}
                  </p>
                  <div
                    style={{
                      fontSize: 14,
                      color: "#303030",
                      marginBottom: 12,
                      fontWeight: 600,
                    }}
                  >
                    Available objects include:
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    <logoFetcher.Form
                      method="post"
                      style={{ display: "grid", gap: 10 }}
                    >
                      <input type="hidden" name="intent" value="saveLogo" />
                      <div>
                        <label
                          htmlFor="store-logo"
                          style={{
                            display: "block",
                            fontSize: 13,
                            fontWeight: 600,
                            color: "#303030",
                            marginBottom: 8,
                          }}
                        >
                          Store logo URL
                        </label>
                        <input
                          id="store-logo"
                          name="storeLogo"
                          type="url"
                          value={storeLogo}
                          onChange={(event) =>
                            setStoreLogo(event.currentTarget.value)
                          }
                          placeholder="https://your-cdn.com/logo.png"
                          style={{
                            width: "100%",
                            border: "1px solid #c9cccf",
                            borderRadius: 10,
                            padding: "10px 12px",
                            fontSize: 14,
                            color: "#303030",
                            outline: "none",
                            boxSizing: "border-box",
                            background: "#ffffff",
                          }}
                        />
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#6d7175",
                          lineHeight: 1.5,
                        }}
                      >
                        This shared logo is shown at the top of every email
                        template and preview.
                      </div>
                      {storeLogo ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minHeight: 92,
                            padding: 12,
                            border: "1px solid #e3e5e7",
                            borderRadius: 10,
                            background: "#fafbfb",
                          }}
                        >
                          <img
                            src={storeLogo}
                            alt="Store logo preview"
                            style={{
                              maxWidth: "100%",
                              maxHeight: 56,
                              objectFit: "contain",
                            }}
                          />
                        </div>
                      ) : null}
                      {logoFetcher.data?.errors?.length ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "#d72c0d",
                            lineHeight: 1.5,
                          }}
                        >
                          {logoFetcher.data.errors.join(" ")}
                        </div>
                      ) : null}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <s-button
                          type="submit"
                          variant="secondary"
                          loading={logoFetcher.state !== "idle"}
                        >
                          Save logo
                        </s-button>
                        {logoFetcher.data?.message ? (
                          <span
                            style={{
                              fontSize: 12,
                              color: "#008060",
                              fontWeight: 600,
                            }}
                          >
                            {logoFetcher.data.message}
                          </span>
                        ) : null}
                      </div>
                    </logoFetcher.Form>

                    {TEMPLATE_VARIABLES.map(({ variable, description }) => (
                      <button
                        key={variable}
                        type="button"
                        onClick={() => insertVariable(variable)}
                        style={{
                          padding: "10px 12px",
                          border: "1px solid #e3e5e7",
                          background: "#ffffff",
                          borderRadius: 10,
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#303030",
                            marginBottom: 4,
                          }}
                        >
                          {variable}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "#6d7175",
                            lineHeight: 1.4,
                          }}
                        >
                          {description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              </div>
            </div>
          </div>
        {showPreview ? (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(17, 24, 39, 0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              zIndex: 2000,
            }}
            onClick={() => setShowPreview(false)}
          >
            <div
              style={{
                width: "min(1040px, 100%)",
                height: "min(760px, calc(100vh - 48px))",
                background: "#ffffff",
                borderRadius: 20,
                overflow: "hidden",
                boxShadow: "0 28px 80px rgba(15, 23, 42, 0.28)",
                display: "flex",
                flexDirection: "column",
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "18px 20px",
                  borderBottom: "1px solid #e3e5e7",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#202223",
                      marginBottom: 4,
                    }}
                  >
                    Preview
                  </div>
                  <div style={{ fontSize: 13, color: "#6d7175" }}>
                    Sample data is used for the template variables.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPreview(false)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#6d7175",
                    fontSize: 26,
                    lineHeight: 1,
                    cursor: "pointer",
                    padding: 0,
                  }}
                  aria-label="Close preview"
                >
                  ×
                </button>
              </div>
              <iframe
                title="Email preview"
                srcDoc={previewDocument}
                style={{
                  width: "100%",
                  flex: 1,
                  border: "none",
                  background: "#ffffff",
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  padding: "16px 20px",
                  borderTop: "1px solid #e3e5e7",
                  background: "#ffffff",
                }}
              >
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowPreview(false)}
                >
                  Close
                </s-button>
              </div>
            </div>
          </div>
        ) : null}

        {emailModal}
      </>
    );
  }

  // ── Main notifications list view ─────────────────────────────────────────────
return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <h1 style={pageHeroTitleStyle}>Notifications</h1>
        <p style={pageHeroTextStyle}>
          Manage customer and admin email templates, delivery options, and branding.
        </p>
      </div>
      <div style={pageContentStyle}>
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

          {/* ── Customer notifications ── */}
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
              {/* Admin toggle card */}
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
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
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
                  <ToggleSwitch
                    enabled={adminNotificationsEnabled}
                    name="enabled"
                    value={adminNotificationsEnabled ? "false" : "true"}
                    fetcher={adminToggleFetcher}
                    intent="toggleAdminNotifications"
                  />
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

              {/* Customer toggle card */}
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
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
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
                  <ToggleSwitch
                    enabled={customerNotificationsEnabled}
                    name="enabled"
                    value={customerNotificationsEnabled ? "false" : "true"}
                    fetcher={toggleFetcher}
                    intent="toggleCustomerNotifications"
                  />
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

              {/* Sender email section */}
              {senderEmailSection}

              {/* Customer templates list */}
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
                  {customerTemplates.map((item, index) => {
                    const fetcher = templateToggleFetchers[item.id];
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 16,
                          width: "100%",
                          padding: "14px 14px 12px",
                          background: "#ffffff",
                          borderTop: index === 0 ? "none" : "1px solid #eceef1",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setSearchParams({ template: item.id })}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "flex-start",
                            gap: 16,
                            flex: 1,
                            background: "transparent",
                            border: "none",
                            textAlign: "left",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          <div style={{ flex: 1 }}>
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
                        </button>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            paddingRight: 20,
                          }}
                        >
                          <ToggleSwitch
                            enabled={templateValues[item.id].enabled}
                            name="enabled"
                            value={templateValues[item.id].enabled ? "false" : "true"}
                            fetcher={fetcher}
                            intent="toggleTemplateEnabled"
                            templateId={item.id}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>

          {/* ── Admin notifications ── */}
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
                Manage admin email notification content and activity for new
                company registration alerts.
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
                  {adminTemplates.map((item, index) => {
                    const fetcher = templateToggleFetchers[item.id];
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 16,
                          width: "100%",
                          padding: "14px 14px 12px",
                          background: "#ffffff",
                          borderTop: index === 0 ? "none" : "1px solid #eceef1",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setSearchParams({ template: item.id })}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "flex-start",
                            gap: 16,
                            flex: 1,
                            background: "transparent",
                            border: "none",
                            textAlign: "left",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          <div style={{ flex: 1 }}>
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
                       
                        </button>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            paddingRight: 20,
                          }}
                        >
                          <ToggleSwitch
                            enabled={templateValues[item.id].enabled}
                            name="enabled"
                            value={templateValues[item.id].enabled ? "false" : "true"}
                            fetcher={fetcher}
                            intent="toggleTemplateEnabled"
                            templateId={item.id}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
  );
}

export const headers: HeadersFunction = () => {
  return {};
};
