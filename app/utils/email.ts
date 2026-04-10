import prisma from "app/db.server";
import axios, { isAxiosError } from "axios";

interface EmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

type RegistrationEmailResult =
  | { success: true; messageId: string }
  | { success: true; skipped: true }
  | { success: false; error: string };

async function sendEmail({ to, subject, html, text }: EmailParams) {
  try {
    // Check if environment variables are configured
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_FROM_EMAIL) {
      console.warn(
        "⚠️ Email service not configured - missing BREVO_API_KEY or BREVO_FROM_EMAIL",
      );
      return { success: false, error: "Email service not configured" };
    }

    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          email: process.env.BREVO_FROM_EMAIL,
          name: "B2B Portal",
        },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html,
        textContent: text,
      },
      {
        headers: {
          accept: "application/json",
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json",
        },
      },
    );

    console.log("✅ Email sent successfully:", response.data);
    return { success: true, messageId: response.data.messageId };
  } catch (error) {
    if (isAxiosError(error)) {
      console.error("❌ Brevo API Error:", error.response?.data);
      return {
        success: false,
        error: error.response?.data?.message || "Failed to send email",
      };
    }
    console.error("❌ Email send error:", error);
    return { success: false, error: "Failed to send email" };
  }
}

function buildTemplateVariables({
  storeOwnerName,
  email,
  companyName,
  contactName,
  shopName,
  shopDomain,
  reviewNotes,
}: {
  storeOwnerName: string;
  email: string;
  companyName: string;
  contactName: string;
  shopName: string;
  shopDomain: string;
  reviewNotes?: string | null;
}) {
  return {
    companyName: companyName || "Company Name",
    storeOwnerName: storeOwnerName || "Store Owner",
    contactName: contactName || "Contact Name",
    email,
    shopName: shopName || "Shop Name",
    shopDomain: shopDomain || "store.com",
    reviewNotes: reviewNotes?.trim() || "",
  };
}

async function getRegistrationEmailContext(storeId: string) {
  const storeData = await prisma.store.findUnique({
    where: { id: storeId },
  });

  const emailTemplateConfig = await prisma.emailTemplates.findFirst({
    where: { shopId: storeId },
    orderBy: { updatedAt: "desc" },
  });

  return { storeData, emailTemplateConfig };
}

export async function sendRegistrationEmailForAdmin(
  storeId: string,
  contactEmail: string,
  storeOwnerName: string,
  email: string,
  companyName: string,
  contactName: string,
) : Promise<RegistrationEmailResult> {
  const { storeData, emailTemplateConfig } = await getRegistrationEmailContext(storeId);

  if (emailTemplateConfig && emailTemplateConfig.adminRequest === false) {
    return { success: true, skipped: true };
  }

  const templateVariables = buildTemplateVariables({
    storeOwnerName,
    email,
    companyName,
    contactName,
    shopName: storeData?.shopName || storeData?.shopDomain || "Shop Name",
    shopDomain: storeData?.shopDomain || "store.com",
  });

  const fallbackSubject = "New B2B registration request from {{companyName}}";
  const fallbackTemplate =
    "Hello {{storeOwnerName}},<br /><br />A new company has submitted a B2B registration request on {{shopName}}.";
  const rawSubject =
    emailTemplateConfig?.adminRequestSubject || fallbackSubject;
  const rawTemplate =
    emailTemplateConfig?.adminRequestTemplate ||
    storeData?.companyWelcomeEmailTemplate ||
    fallbackTemplate;

  if (!rawTemplate) {
    throw new Error("Registration email template not found");
  }

  const processedTemplate = replaceTemplateVariables(
    rawTemplate,
    templateVariables,
  );
  const processedSubject = replaceTemplateVariables(rawSubject, templateVariables);

  const html = convertToHtmlEmail(
    processedTemplate,
    storeData?.shopDomain || "store.com",
    processedSubject,
    {
      ctaLabel: "View B2B Page",
      ctaUrl: `https://admin.shopify.com/store/${
        (storeData?.shopDomain || "store.com").split(".")[0]
      }/apps/b2b-portal-public-1/app/registrations`,
      footerText: "This email was sent to notify you about a B2B registration request.",
    },
  );

  const text = stripHtmlTags(processedTemplate);

  return sendEmail({
    to: contactEmail,
    subject: processedSubject,
    html,
    text,
  });
}

export async function sendRegistrationEmailForCustomer(
  storeId: string,
  contactEmail: string,
  storeOwnerName: string,
  email: string,
  companyName: string,
  contactName: string,
): Promise<RegistrationEmailResult> {
  const { storeData, emailTemplateConfig } = await getRegistrationEmailContext(storeId);

  if (emailTemplateConfig && emailTemplateConfig.customerRegistration === false) {
    return { success: true, skipped: true };
  }

  const templateVariables = buildTemplateVariables({
    storeOwnerName,
    email,
    companyName,
    contactName,
    shopName: storeData?.shopName || storeData?.shopDomain || "Shop Name",
    shopDomain: storeData?.shopDomain || "store.com",
  });

  const fallbackSubject = "We received your B2B registration request";
  const fallbackTemplate =
    "Hello {{contactName}},<br /><br />We have received your B2B registration request for {{companyName}} on {{shopName}}.";
  const rawSubject =
    emailTemplateConfig?.customerRegistrationSubject || fallbackSubject;
  const rawTemplate =
    emailTemplateConfig?.customerRegistrationTemplate || fallbackTemplate;

  const processedTemplate = replaceTemplateVariables(rawTemplate, templateVariables);
  const processedSubject = replaceTemplateVariables(rawSubject, templateVariables);
  const shopDomain = storeData?.shopDomain || "store.com";
  const storefrontUrl = shopDomain.startsWith("http") ? shopDomain : `https://${shopDomain}`;

  const html = convertToHtmlEmail(processedTemplate, shopDomain, processedSubject, {
    ctaLabel: "Visit Store",
    ctaUrl: storefrontUrl,
    footerText: "This email confirms we received your B2B registration request.",
  });

  const text = stripHtmlTags(processedTemplate);

  return sendEmail({
    to: contactEmail,
    subject: processedSubject,
    html,
    text,
  });
}

export async function sendRegistrationEmail(
  storeId: string,
  contactEmail: string,
  storeOwnerName: string,
  email: string,
  companyName: string,
  contactName: string,
) {
  return sendRegistrationEmailForAdmin(
    storeId,
    contactEmail,
    storeOwnerName,
    email,
    companyName,
    contactName,
  );
}

function replaceTemplateVariables(
  template: string,
  variables: Record<string, string>,
): string {
  let processedTemplate = template;

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    processedTemplate = processedTemplate.replace(regex, value);
  });

  return processedTemplate;
}

function convertToHtmlEmail(
  content: string,
  shopDomain: string,
  emailTitle = "Company Inquiry",
  options?: {
    ctaLabel?: string;
    ctaUrl?: string;
    footerText?: string;
  },
): string {
  const safeDomain = shopDomain || "store.com";
  const shopDomaindata = safeDomain.split(".")[0];
  const ctaLabel = options?.ctaLabel || "View B2B Page";
  const ctaUrl =
    options?.ctaUrl ||
    `https://admin.shopify.com/store/${shopDomaindata}/apps/b2b-portal-public-1/app/registrations`;
  const footerText =
    options?.footerText || "This email was sent to notify you about a B2B registration request.";
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${emailTitle}</title>
  <style>
    body { 
      font-family: Arial, sans-serif; 
      background-color: #f4f6f8; 
      color: #333; 
      margin: 0;
      padding: 0;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      padding: 20px; 
    }
    .header { 
      background-color: #0d6efd; 
      padding: 20px; 
      text-align: center; 
      color: #fff; 
      border-radius: 8px 8px 0 0; 
    }
    .content { 
      background-color: #ffffff; 
      padding: 30px; 
      border: 1px solid #dee2e6; 
      line-height: 1.6;
    }
    .footer { 
      background-color: #f8f9fa; 
      padding: 15px; 
      text-align: center; 
      font-size: 12px; 
      color: #6c757d; 
      border-radius: 0 0 8px 8px; 
    }
    .btn { 
      display: inline-block; 
      padding: 12px 24px; 
      background-color: #0d6efd; 
      color: #fff !important; 
      text-decoration: none; 
      border-radius: 4px; 
      margin: 20px 0; 
    }
    .btn:hover { 
      background-color: #0b5ed7; 
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${emailTitle}</h1>
    </div>

    <div class="content">
      ${formatContentAsHtml(content)}
      
      <p style="text-align: center;">
        <a href="${ctaUrl}" class="btn">
          ${ctaLabel}
        </a>
      </p>
    </div>

    <div class="footer">
      <p>${footerText}</p>
    </div>
  </div>
</body>
</html>
`;

  return html;
}

function formatContentAsHtml(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      line = line.trim();
      if (!line) return "<br />";

      if (line.startsWith("•")) {
        return `<p style="margin: 5px 0; padding-left: 20px;">${line}</p>`;
      }

      return `<p style="margin: 10px 0;">${line}</p>`;
    })
    .join("");
}

function stripHtmlTags(content: string): string {
  return content
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function sendCustomerRegistrationApprovalEmail(
  {
    storeId,
    email,
    storeOwnerName,
    companyName,
    contactName,
    note,
  }: {
    storeId: string;
    email: string;
    storeOwnerName: string;
    companyName: string;
    contactName: string;
    note?: string | null;
  },
) {
  const { storeData, emailTemplateConfig } = await getRegistrationEmailContext(storeId);

  if (emailTemplateConfig && emailTemplateConfig.customerRegistrationApproved === false) {
    return { success: true, skipped: true } as RegistrationEmailResult;
  }

  const templateVariables = buildTemplateVariables({
    storeOwnerName,
    email,
    companyName,
    contactName,
    shopName: storeData?.shopName || storeData?.shopDomain || "Shop Name",
    shopDomain: storeData?.shopDomain || "shop-domain.myshopify.com",
    reviewNotes: note,
  });

  const fallbackSubject = "Your B2B registration has been approved";
  const fallbackTemplate =
    "Hello {{contactName}},<br /><br />Your company account for {{companyName}} has been approved. You can now begin placing orders on {{shopName}}.";
  const rawSubject =
    emailTemplateConfig?.customerRegistrationApprovedSubject || fallbackSubject;
  const rawTemplate =
    emailTemplateConfig?.customerRegistrationApprovedTemplate || fallbackTemplate;

  const processedSubject = replaceTemplateVariables(rawSubject, templateVariables);
  const processedTemplate = replaceTemplateVariables(rawTemplate, templateVariables);
  const shopDomain = storeData?.shopDomain || "shop-domain.myshopify.com";
  const storefrontUrl = shopDomain.startsWith("http") ? shopDomain : `https://${shopDomain}`;
  const html = convertToHtmlEmail(processedTemplate, shopDomain, processedSubject, {
    ctaLabel: "Visit Store",
    ctaUrl: storefrontUrl,
    footerText: "This email confirms your B2B registration has been approved.",
  });
  const text = stripHtmlTags(processedTemplate);

  return sendEmail({
    to: email,
    subject: processedSubject,
    html,
    text,
  });
}


export async function sendEmployeeAssignmentEmail({
  shopName,
  shopDomain,
  adminName,
  role,
  email,
  companyName,
  contactName,
}: {
  shopName: string;
  shopDomain: string;
  adminName: string;
  role: string;
  email: string;
  companyName: string;
  contactName: string;
}) {
  const { html, text } = generateEmployeeAssignmentTemplate(
    shopName || "Shop Name",
    shopDomain || "shop-domain.myshopify.com",
    adminName || "Admin",
    role || "Employee", // ✅ added role
    companyName || "Company Name",
    contactName || "Employee",
  );
  return sendEmail({
    to: email,
    subject: "You've been assigned to a company on our platform",
    html,
    text,
  });
}

function generateEmployeeAssignmentTemplate(
  shopName: string,
  shopDomain: string,
  adminName: string,
  role: string,
  companyName: string,
  contactName: string,
) {
  const safeDomain = shopDomain || "shop-domain.myshopify.com";

  // ✅ safer domain handling
  const shopDomaindata = safeDomain.startsWith("http")
    ? safeDomain
    : `https://${safeDomain}`;

  const dashboardUrl = `${shopDomaindata}/pages/b2b-page/dashboard`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Employee Assigned</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f6f8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #0d6efd; padding: 20px; text-align: center; color: #fff; border-radius: 8px 8px 0 0; }
    .content { background-color: #ffffff; padding: 30px; border: 1px solid #dee2e6; }
    .footer { background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #6c757d; border-radius: 0 0 8px 8px; }
    
    /* ✅ FIXED BUTTON */
    .btn { 
      display: inline-block; 
      padding: 12px 24px; 
      background-color: #0d6efd; 
      color: #ffffff !important; 
      text-decoration: none; 
      border-radius: 4px; 
      margin: 20px 0; 
    }

    .btn:hover { background-color: #0b5ed7; }

    .highlight { background-color: #e7f1ff; padding: 15px; border-radius: 4px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Employee Assigned</h1>
    </div>

    <div class="content">
      <p>Hello <strong>${contactName || "User"}</strong>,</p>

      <p>
        We are pleased to inform you that you have been successfully assigned
        as an <strong>${role}</strong> for the company <strong>${companyName}</strong> by
        <strong>${adminName}</strong>.
      </p>

      <div class="highlight">
        <p><strong>Company Name:</strong> ${companyName}</p>
        <p><strong>Your Role:</strong> ${role}</p>
      </div>

      <p>
        You can now log in to the platform and access your dashboard.
      </p>

      <p style="text-align: center;">
        <a href="${dashboardUrl}" class="btn">
          View Dashboard
        </a>
      </p>

      <p>
        If you have any questions or face any issues, please feel free to
        contact our support team.
      </p>

      <p>
        Best regards,<br />
        <strong>${shopName}</strong>
      </p>
    </div>

    <div class="footer">
      © ${new Date().getFullYear()} ${shopName}. All rights reserved.
    </div>
  </div>
</body>
</html>
`;

  const text = `
Employee Assigned Successfully

Hello ${contactName || "User"},

You have been successfully assigned as a ${role} for ${companyName} by ${adminName}.

Company Name: ${companyName}
Role: ${role}

Dashboard: ${dashboardUrl}

If you have any questions or need assistance, please contact our support team.

Best regards,
${shopName}
`;

  return { html, text };
}

export async function sendCustomerRegistrationRejectdEmail({
  storeId,
  storeOwnerName,
  email,
  companyName,
  contactName,
  note,
}: {
  storeId: string;
  storeOwnerName: string;
  email: string;
  companyName: string;
  contactName: string;
  note?: string | null;
}) {
  const { storeData, emailTemplateConfig } = await getRegistrationEmailContext(storeId);

  if (emailTemplateConfig && emailTemplateConfig.customerRegistrationRejectd === false) {
    return { success: true, skipped: true } as RegistrationEmailResult;
  }

  const templateVariables = buildTemplateVariables({
    storeOwnerName,
    email,
    companyName,
    contactName,
    shopName: storeData?.shopName || storeData?.shopDomain || "B2B Portal",
    shopDomain: storeData?.shopDomain || "shop-domain.myshopify.com",
    reviewNotes: note,
  });
  const fallbackSubject = "Update on your B2B registration";
  const fallbackTemplate =
    "Hello {{contactName}},<br /><br />Your B2B application for {{companyName}} has been rejected. Please contact {{storeOwnerName}} for more information.<br /><br />{{reviewNotes}}";
  const rawSubject =
    emailTemplateConfig?.customerRegistrationRejectedSubject || fallbackSubject;
  const rawTemplate =
    emailTemplateConfig?.customerRegistrationRejectedTemplate || fallbackTemplate;

  const processedSubject = replaceTemplateVariables(rawSubject, templateVariables);
  const processedTemplate = replaceTemplateVariables(rawTemplate, templateVariables);
  const shopDomain = storeData?.shopDomain || "shop-domain.myshopify.com";
  const storefrontUrl = shopDomain.startsWith("http") ? shopDomain : `https://${shopDomain}`;
  const html = convertToHtmlEmail(processedTemplate, shopDomain, processedSubject, {
    ctaLabel: "Visit Store",
    ctaUrl: storefrontUrl,
    footerText: "This email shares an update about your B2B registration request.",
  });
  const text = stripHtmlTags(processedTemplate);

  return sendEmail({
    to: email,
    subject: processedSubject,
    html,
    text,
  });
}
