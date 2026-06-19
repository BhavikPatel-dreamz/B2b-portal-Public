import prisma from "app/db.server";
import nodemailer from "nodemailer";
import { resolveStoreSmtpConfig, type ResolvedSmtpConfig } from "./smtp.server";

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

async function sendEmail(
  { to, subject, html, text }: EmailParams,
  smtpConfig?: ResolvedSmtpConfig | null,
): Promise<RegistrationEmailResult> {
  try {
    const resolvedConfig = smtpConfig || resolveStoreSmtpConfig(null);

    if (!resolvedConfig) {
      console.warn("⚠️ Email service not configured - missing SMTP settings");
      return { success: false, error: "Email service not configured" };
    }

    const transporter = nodemailer.createTransport({
      host: resolvedConfig.host,
      port: resolvedConfig.port,
      secure: resolvedConfig.secure,
      auth: {
        user: resolvedConfig.user,
        pass: resolvedConfig.pass,
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        servername: resolvedConfig.host,
      },
      name: resolvedConfig.host, // Identify itself to the SMTP server
      debug: true,
      logger: true,
      connectionTimeout: 30000,
      greetingTimeout: 20000,
      socketTimeout: 45000,
    });
    

    const response = await transporter.sendMail({
      from: `"${resolvedConfig.fromName}" <${resolvedConfig.fromEmail}>`,
      to,
      subject,
      html,
      text,
    });

    console.log("✅ Email sent successfully:", response.messageId);
    return { success: true, messageId: response.messageId };
  } catch (error) {
    console.error("❌ Email send error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
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
// Add this helper at the top of the file or in your utils
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export async function sendRegistrationEmailForAdmin(
  storeId: string,
  contactEmail: string,
  storeOwnerName: string,
  email: string,
  companyName: string,
  contactName: string,
): Promise<RegistrationEmailResult> {
  const { storeData, emailTemplateConfig } =
    await getRegistrationEmailContext(storeId);
  const smtpConfig = resolveStoreSmtpConfig(storeData);

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
    emailTemplateConfig?.adminRequestTemplate || fallbackTemplate;

  if (!rawTemplate) {
    throw new Error("Registration email template not found");
  }

  const decodedTemplate = decodeHtmlEntities(rawTemplate);
  const processedTemplate = replaceTemplateVariables(
    decodedTemplate,
    templateVariables,
  );

  const processedSubject = replaceTemplateVariables(
    rawSubject,
    templateVariables,
  );

  const html = convertToHtmlEmail(
    processedTemplate,
    storeData?.shopDomain || "store.com",
    processedSubject,
    {
      logoUrl: storeData?.logo,
      ctaLabel: "View B2B Page",
      ctaUrl: `https://admin.shopify.com/store/${
        (storeData?.shopDomain || "store.com").split(".")[0]
      }/apps/b2b-portal-public-3/app/registrations`
    },
  );

  const text = stripHtmlTags(processedTemplate);

  return sendEmail(
    {
      to: contactEmail,
      subject: processedSubject,
      html,
      text,
    },
    smtpConfig,
  );
}

export async function sendRegistrationEmailForCustomer(
  storeId: string,
  contactEmail: string,
  storeOwnerName: string,
  email: string,
  companyName: string,
  contactName: string,
): Promise<RegistrationEmailResult> {
  const { storeData, emailTemplateConfig } =
    await getRegistrationEmailContext(storeId);
  const smtpConfig = resolveStoreSmtpConfig(storeData);

  if (
    emailTemplateConfig &&
    emailTemplateConfig.customerRegistration === false
  ) {
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

  // ✅ ADD THIS — decode escaped HTML entities saved by contentEditable
  const decodedTemplate = decodeHtmlEntities(rawTemplate);

  const processedTemplate = replaceTemplateVariables(
    decodedTemplate,
    templateVariables,
  );
  const processedSubject = replaceTemplateVariables(
    rawSubject,
    templateVariables,
  );
  const shopDomain = storeData?.shopDomain || "store.com";
  const storefrontUrl = shopDomain.startsWith("http")
    ? shopDomain
    : `https://${shopDomain}/apps/b2b-portal-public-3/smartb2b`;

  const html = convertToHtmlEmail(
    processedTemplate,
    shopDomain,
    processedSubject,
    {
      logoUrl: storeData?.logo,
      ctaLabel: "Visit Store",
      ctaUrl: storefrontUrl,
      footerText:
        "This email confirms we received your B2B registration request.",
    },
  );

  const text = stripHtmlTags(processedTemplate);

  return sendEmail(
    {
      to: contactEmail,
      subject: processedSubject,
      html,
      text,
    },
    smtpConfig,
  );
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
    logoUrl?: string | null;
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
    options?.footerText ||
    "This email was sent to notify you about a B2B registration request.";

  const logoMarkup = options?.logoUrl
    ? `<img src="${options.logoUrl}" alt="Store logo" style="display: block; max-height: 60px; margin-bottom: 12px;" />`
    : "";

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${emailTitle}</title>
</head>
<body style="margin: 0; padding: 24px; background-color: #f3f4f6; font-family: Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 24px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 720px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb;">
          
          <!-- HEADER -->
          <tr>
            <td style="padding: 24px; border-bottom: 1px solid #e5e7eb;">
              ${logoMarkup}
              <h2 style="margin: 0; font-size: 20px; color: #111827;">${emailTitle}</h2>
            </td>
          </tr>

          <!-- CONTENT -->
          <tr>
            <td style="padding: 24px; font-size: 15px; line-height: 1.6; color: #303030; word-break: break-word;">
              ${content}
              
              <div style="text-align: center; margin-top: 24px;">
                <a href="${ctaUrl}" style="display: inline-block; padding: 12px 20px; background-color: #0a61c7; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600;">
                  ${ctaLabel}
                </a>
              </div>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding: 16px 24px; font-size: 12px; color: #6b7280; border-top: 1px solid #e5e7eb; background-color: #f8f9fa;">
              <p style="margin: 0;">${footerText}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  return html;
}

function stripHtmlTags(content: string): string {
  return content
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function sendCustomerRegistrationApprovalEmail({
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
}): Promise<RegistrationEmailResult> {
  const { storeData, emailTemplateConfig } =
    await getRegistrationEmailContext(storeId);
  const smtpConfig = resolveStoreSmtpConfig(storeData);

  if (
    emailTemplateConfig &&
    emailTemplateConfig.customerRegistrationApproved === false
  ) {
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
    emailTemplateConfig?.customerRegistrationApprovedTemplate ||
    fallbackTemplate;
  const decodedTemplate = decodeHtmlEntities(rawTemplate);
  const processedTemplate = replaceTemplateVariables(
    decodedTemplate,
    templateVariables,
  );
  const processedSubject = replaceTemplateVariables(
    rawSubject,
    templateVariables,
  );
  const shopDomain = storeData?.shopDomain || "shop-domain.myshopify.com";
  const storefrontUrl = shopDomain.startsWith("http")
    ? shopDomain
    : `https://${shopDomain}/apps/b2b-portal-public-3/smartb2b`;
  const html = convertToHtmlEmail(
    processedTemplate,
    shopDomain,
    processedSubject,
    {
      logoUrl: storeData?.logo,
      ctaLabel: "Visit Store",
      ctaUrl: storefrontUrl,
      footerText:
        "This email confirms your B2B registration has been approved.",
    },
  );
  const text = stripHtmlTags(processedTemplate);

  return sendEmail(
    {
      to: email,
      subject: processedSubject,
      html,
      text,
    },
    smtpConfig,
  );
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
}): Promise<RegistrationEmailResult> {
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
</head>
<body style="margin: 0; padding: 24px; background-color: #f3f4f6; font-family: Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 24px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 720px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb;">
          
          <!-- HEADER -->
          <tr>
            <td style="padding: 24px; border-bottom: 1px solid #e5e7eb;">
              <h2 style="margin: 0; font-size: 20px; color: #111827;">Employee Assigned</h2>
            </td>
          </tr>

          <!-- CONTENT -->
          <tr>
            <td style="padding: 24px; font-size: 15px; line-height: 1.6; color: #303030; word-break: break-word;">
              <p>Hello <strong>${contactName || "User"}</strong>,</p>

              <p>
                We are pleased to inform you that you have been successfully assigned
                as an <strong>${role}</strong> for the company <strong>${companyName}</strong> by
                <strong>${adminName}</strong>.
              </p>

              <div style="background-color: #e7f1ff; padding: 15px; border-radius: 4px; margin: 20px 0;">
                <p style="margin: 5px 0;"><strong>Company Name:</strong> ${companyName}</p>
                <p style="margin: 5px 0;"><strong>Your Role:</strong> ${role}</p>
              </div>

              <p>
                You can now log in to the platform and access your dashboard.
              </p>

              <div style="text-align: center; margin-top: 24px;">
                <a href="${dashboardUrl}" style="display: inline-block; padding: 12px 20px; background-color: #0a61c7; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600;">
                  View Dashboard
                </a>
              </div>

              <p>
                If you have any questions or face any issues, please feel free to
                contact our support team.
              </p>

              <p>
                Best regards,<br />
                <strong>${shopName}</strong>
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding: 16px 24px; font-size: 12px; color: #6b7280; border-top: 1px solid #e5e7eb; background-color: #f8f9fa;">
              © ${new Date().getFullYear()} ${shopName}. All rights reserved.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
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

export async function sendCustomerRegistrationRejectedEmail({
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
}): Promise<RegistrationEmailResult> {
  const { storeData, emailTemplateConfig } =
    await getRegistrationEmailContext(storeId);

  if (
    emailTemplateConfig &&
    emailTemplateConfig.customerRegistrationRejected === false
  ) {
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
    emailTemplateConfig?.customerRegistrationRejectedTemplate ||
    fallbackTemplate;
  const decodedTemplate = decodeHtmlEntities(rawTemplate);
  const processedTemplate = replaceTemplateVariables(
    decodedTemplate,
    templateVariables,
  );
  const processedSubject = replaceTemplateVariables(
    rawSubject,
    templateVariables,
  );
  const shopDomain = storeData?.shopDomain || "shop-domain.myshopify.com";
  const storefrontUrl = shopDomain.startsWith("http")
    ? shopDomain
    : `https://${shopDomain}/apps/b2b-portal-public-3/smartb2b`;
  const html = convertToHtmlEmail(
    processedTemplate,
    shopDomain,
    processedSubject,
    {
      logoUrl: storeData?.logo,
      ctaLabel: "Visit Store",
      ctaUrl: storefrontUrl,
      footerText:
        "This email shares an update about your B2B registration request.",
    },
  );
  const text = stripHtmlTags(processedTemplate);

  return sendEmail({
    to: email,
    subject: processedSubject,
    html,
    text,
  });
}

/**
 * Send welcome email to the store owner after app installation
 */
export async function sendAppWelcomeEmail(
  storeId: string,
  providedEmail?: string,
): Promise<RegistrationEmailResult> {
  const storeData = await prisma.store.findUnique({
    where: { id: storeId },
  });

  const targetEmail = providedEmail || storeData?.contactEmail;

  if (!targetEmail) {
    console.warn(
      `⚠️ Cannot send welcome email for store ${storeId} - missing contact email`,
    );
    return { success: false, error: "Missing contact email" };
  }

  const smtpConfig = resolveStoreSmtpConfig(storeData);

  const steps = [
    {
      num: 1,
      title: "Configure your registration form",
      desc: "Customise the B2B registration fields and the information you want to collect from customers.",
    },
    {
      num: 2,
      title: "Enable the customer account extension",
      desc: "Activate Company Connect from your Shopify Theme Editor and add the registration link to your customer account area.",
    },
    {
      num: 3,
      title: "Review and approve applications",
      desc: "Manage incoming B2B registration requests and approve qualified companies.",
    },
    {
      num: 4,
      title: "Start selling B2B",
      desc: "Your customers can now access their B2B portal and manage their business accounts efficiently.",
    },
  ];

  const merchantName = storeData?.storeOwnerName || storeData?.shopName?.split(".")[0] || "there";

  const stepsHtml = steps
    .map(
      (step, idx) => `
    <div style="border-top: ${idx === 0 ? "1px solid #e5e7eb" : "none"}; border-bottom: 1px solid #e5e7eb; padding: 16px 0;">
      <p style="font-size: 14px; font-weight: 700; color: #111; margin: 0 0 4px;">${step.num}.&nbsp; ${step.title}</p>
      <p style="font-size: 13px; color: #555; line-height: 1.6; margin: 0;">${step.desc}</p>
    </div>
  `,
    )
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="background-color: #f5f5f5; margin: 0; padding: 40px 16px; font-family: 'Helvetica Neue', Arial, sans-serif;">
  <div style="background-color: #ffffff; border-radius: 8px; max-width: 520px; width: 100%; margin: 0 auto; box-shadow: 0 2px 12px rgba(0,0,0,0.08); overflow: hidden;">
    <div style="padding: 36px 40px 28px; text-align: left;">
      <p style="font-size: 18px; font-weight: 600; color: #111; margin: 0 0 4px;">Hi, ${merchantName}</p>
      <p style="font-size: 18px; font-weight: 700; color: #111; margin: 0 0 16px;">Thank you for installing SmartB2B</p>
      <p style="font-size: 14px; color: #444; line-height: 1.65; margin: 0 0 28px;">
        You now have a full-featured B2B wholesale portal on your Shopify store built to handle everything from customer onboarding and company management to credit control and quick orders.
      </p>

      <p style="font-size: 11px; font-weight: 700; letter-spacing: 1.2px; color: #2563EB; text-transform: uppercase; margin: 0 0 20px; text-align: left;">Getting Started</p>

      <div style="text-align: left;">${stepsHtml}</div>

      <!-- <div style="margin-top: 28px;">
        <a href="https://smartb2b.gitbook.io/smartb2b-documentation" style="display: block; width: 100%; padding: 14px 0; background-color: #2563EB; color: #fff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600; text-align: center;">
          View App Documentation
        </a>
      </div> -->
      </div>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0;" />

    <div style="padding: 36px 40px 32px; text-align: left;">
      <p style="font-size: 20px; font-weight: 700; color: #111; margin: 0 0 10px;">Need help?</p>
      <p style="font-size: 14px; color: #444; line-height: 1.65; margin: 0 0 24px;">
        Our team is here to help with installation, configuration, and onboarding. We typically respond within one business day and are happy to assist with setup, configuration, and best practices.
      </p>

     <table cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; width: 100%; margin-bottom: 28px;">
        <tr>
          <td style="width: 50%; padding-right: 8px; vertical-align: top;">
            <table cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; width: 100%; height: 100%; border: 1px solid #e5e7eb; border-radius: 8px;">
              <tr>
                <td style="padding: 20px 16px 12px 16px; vertical-align: top;">
                  <p style="font-size: 14px; font-weight: 700; color: #111; margin: 0 0 8px;">Email support</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 16px 20px 16px; vertical-align: bottom;">
                  <a href="mailto:support@dreamzapps.com" style="display: inline-block; padding: 9px 12px; background-color: #fff; color: #2563EB; border: 1.5px solid #2563EB; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; text-align: center; white-space: nowrap;">support@dreamzapps.com</a>
                </td>
              </tr>
            </table>
          </td>
          <td style="width: 50%; padding-left: 8px; vertical-align: top;">
            <table cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; width: 100%; height: 100%; border: 1px solid #e5e7eb; border-radius: 8px;">
              <tr>
                <td style="padding: 20px 16px 12px 16px; vertical-align: top;">
                  <p style="font-size: 14px; font-weight: 700; color: #111; margin: 0 0 8px;">Custom onboarding</p>
                  <!-- <p style="font-size: 13px; color: #555; line-height: 1.6; margin: 0;">
                    Need hands-on help configuring SmartB2B for your workflow? Our Shopify experts can do it for you.
                  </p> -->
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 16px 20px 16px; vertical-align: bottom;">
                  <a href="mailto:support@dreamzapps.com" style="display: inline-block; padding: 9px 12px; background-color: #fff; color: #2563EB; border: 1.5px solid #2563EB; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; text-align: center; white-space: nowrap;">Request Service</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  </div>
</body>
</html>
  `;

  const text = `
Hi,
Thank you for installing SmartB2B.
You now have a full-featured B2B wholesale portal on your Shopify store.

Getting Started:
1. Configure your registration form
2. Enable the customer account extension
3. Review and approve applications
4. Start selling B2B

Need help?
Our team is here to help. Email us at support@dreamzapps.com or visit www.dreamzapps.com/support/

Thank you for choosing SmartB2B.
  `;

  return sendEmail(
    {
      to: targetEmail,
      subject: "Welcome to SmartB2B - Let's get started",
      html,
      text,
    },
    smtpConfig,
  );
}

export async function sendSalesUserInvitationEmail({
  storeId,
  email,
  firstName,
  inviteLink,
}: {
  storeId: string;
  email: string;
  firstName: string;
  inviteLink: string;
}): Promise<RegistrationEmailResult> {
  const storeData = await prisma.store.findUnique({
    where: { id: storeId },
  });

  const smtpConfig = resolveStoreSmtpConfig(storeData);
  const shopName = storeData?.shopName || storeData?.shopDomain || "Store Name";

  const subject = "You've been invited as a Sales User";
  
  const content = `
    <p>Hello ${firstName},</p>
    <p>You have been invited to join <strong>${shopName}</strong> as a Sales User.</p>
    <p>Please click the button below to set your password and activate your account. This link will expire in 7 days.</p>
  `;

  const html = convertToHtmlEmail(
    content,
    storeData?.shopDomain || "store.com",
    subject,
    {
      logoUrl: storeData?.logo,
      ctaLabel: "Set Password & Login",
      ctaUrl: inviteLink,
      footerText: "This email was sent to invite you to the Sales Portal.",
    }
  );

  const text = `Hello ${firstName},

You have been invited to join ${shopName} as a Sales User.

Please copy and paste the following link into your browser to set your password and activate your account:
${inviteLink}

This link will expire in 7 days.

Best regards,
${shopName}`;

  return sendEmail(
    {
      to: email,
      subject,
      html,
      text,
    },
    smtpConfig,
  );
}

export async function sendQuoteEmail({
  storeId,
  to,
  customerName,
  quoteNumber,
  quoteTitle,
  companyName,
  totalAmount,
  currencyCode,
  expiresAt,
  quoteUrl,
}: {
  storeId: string;
  to: string;
  customerName: string;
  quoteNumber: string;
  quoteTitle: string;
  companyName: string;
  totalAmount: string;
  currencyCode: string;
  expiresAt: Date;
  quoteUrl: string;
}) {
  const storeData = await prisma.store.findUnique({
    where: { id: storeId },
  });
  const smtpConfig = resolveStoreSmtpConfig(storeData);
  const shopName = storeData?.shopName || storeData?.shopDomain || "SmartB2B";
  const formattedTotal = `${currencyCode} ${totalAmount}`;
  const formattedExpiry = expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
  const safeCustomerName = customerName || "there";
  const subject = `${shopName} quote ${quoteNumber}: ${quoteTitle}`;
  const body = `
    Hello ${safeCustomerName},<br /><br />
    ${companyName} has a new quote ready for review.<br /><br />
    <strong>Quote:</strong> ${quoteNumber}<br />
    <strong>Total:</strong> ${formattedTotal}<br />
    <strong>Expires:</strong> ${formattedExpiry}<br /><br />
    Please review the quote and choose approve or reject.
  `;

  const html = convertToHtmlEmail(body, storeData?.shopDomain || "store.com", subject, {
    logoUrl: storeData?.logo,
    ctaLabel: "Review Quote",
    ctaUrl: quoteUrl,
    footerText: "This secure quote link is intended for the selected customer.",
  });

  return sendEmail(
    {
      to,
      subject,
      html,
      text: stripHtmlTags(`${body}\n\nReview quote: ${quoteUrl}`),
    },
    smtpConfig,
  );
}
