import prisma from "app/db.server";
import axios, { isAxiosError } from "axios";

interface EmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

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

export async function sendRegistrationEmail(
  storeId: string,
  contactEmail: string,
  storeOwnerName: string,
  email: string,
  companyName: string,
  contactName: string,
) {
  const StoreData = await prisma.store.findUnique({
    where: {
      id: storeId,
    },
  });

  if (!StoreData?.companyWelcomeEmailTemplate) {
    throw new Error("Company welcome email template not found");
  }

  const templateVariables = {
    companyName: companyName || "Company Name",
    storeOwnerName: storeOwnerName || "Store Owner",
    contactName: contactName || "Contact Name",
    email: email,
    shopDomain: StoreData?.shopDomain || "store.com",
  };

  const processedTemplate = replaceTemplateVariables(
    StoreData.companyWelcomeEmailTemplate,
    templateVariables,
  );

  // FIXED: Pass shopDomain to convertToHtmlEmail
  const html = convertToHtmlEmail(
    processedTemplate,
    StoreData?.shopDomain || "store.com",
  );

  const text = stripHtmlTags(processedTemplate);

  return sendEmail({
    to: contactEmail,
    subject: `Company Inquiry: ${companyName}`,
    html,
    text,
  });
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

function convertToHtmlEmail(content: string, shopDomain: string): string {
  const shopDomaindata = shopDomain.split(".")[0];
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Company Inquiry</title>
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
      <h1>Company Inquiry</h1>
    </div>

    <div class="content">
      ${formatContentAsHtml(content)}
      
      <p style="text-align: center;">
        <a href="https://admin.shopify.com/store/${shopDomaindata}/apps/b2b-portal-public-1/app/registrations" class="btn">
          View B2B Page
        </a>
      </p>
    </div>

    <div class="footer">
      <p>This email was sent to notify you about a new company inquiry.</p>
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

export async function sendCompanyAssignmentEmail(
  shopName: string,
  shopDomain: string,
  storeOwnerName: string,
  email: string,
  companyName: string,
  contactName: string,
  note?: string | null,
) {
  const { html, text } = generateCompanyAssignmentTemplate(
    shopName || "Shop Name",
    shopDomain || "shop-domain.myshopify.com",
    storeOwnerName || "Store Owner",
    companyName || "Company Name",
    contactName || "",
    note || "important note: ",
  );

  return sendEmail({
    to: email,
    subject: "You've been assigned to a company on our platform",
    html,
    text,
  });
}

function generateCompanyAssignmentTemplate(
  shopName: string,
  shopDomain: string,
  storeOwnerName: string,
  companyName: string,
  contactName: string,
  note?: string,
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
  <title>Company Assigned</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f6f8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #0d6efd; padding: 20px; text-align: center; color: #fff; border-radius: 8px 8px 0 0; }
    .content { background-color: #ffffff; padding: 30px; border: 1px solid #dee2e6; }
    .footer { background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #6c757d; border-radius: 0 0 8px 8px; }
    .btn { display: inline-block; padding: 12px 24px; background-color:rgb(255, 255, 255); color: #fff; text-decoration: none; border-radius: 4px; margin: 20px 0; }
    .btn:hover { background-color: #0b5ed7; }
    .highlight { background-color: #e7f1ff; padding: 15px; border-radius: 4px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Company Assigned</h1>
    </div>

    <div class="content">
      <p>Hello <strong>${contactName}</strong>,</p>

      <p>
        We are pleased to inform you that a company has been successfully
        assigned to your account by the <strong>${storeOwnerName}</strong>.
      </p>

      <div class="highlight">
        <p><strong>Company Name:</strong> ${companyName}</p>
        <p><strong>Your Role:</strong> Company Admin</p>
      </div>

      <p>
        You can now log in to the platform and start managing your company,
        users, and locations.
      </p>

       <p style="text-align: center;">
         <a href="${dashboardUrl}" class="btn">
          View B2B Dashboard
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
  </div>
</body>
</html>
`;

  const text = `
Company Assigned Successfully

Hello ${contactName},

A company has been successfully assigned to your account by the Store Admin.

Company Name: ${companyName}
Role: Company Administrator

You can now log in to the platform and start managing your company, users,
and locations.


If you have any questions or need assistance, please contact our support team.

Best regards,
<strong>${storeOwnerName}</strong>
`;

  return { html, text };
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

export async function sendRegistrationRejectedEmail({
  shopName,
  shopDomain,
  storeOwnerName,
  email,
  companyName,
  contactName,
  note,
}: {
  shopName: string;
  shopDomain: string;
  storeOwnerName: string;
  email: string;
  companyName: string;
  contactName: string;
  note?: string | null;
}) {
  const safeDomain = shopDomain || "shop-domain.myshopify.com";
  const storefrontUrl = safeDomain.startsWith("http")
    ? safeDomain
    : `https://${safeDomain}`;

  const safeContactName = contactName || "there";
  const safeCompanyName = companyName || "your company";
  const safeNote = note?.trim() || "";

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Registration Request Rejected</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f6f8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #dc2626; padding: 20px; text-align: center; color: #fff; border-radius: 8px 8px 0 0; }
    .content { background-color: #ffffff; padding: 30px; border: 1px solid #dee2e6; }
    .note { background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 14px; margin: 20px 0; border-radius: 4px; }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      background-color: #111827;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 4px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Registration Request Rejected</h1>
    </div>
    <div class="content">
      <p>Hello <strong>${safeContactName}</strong>,</p>
      <p>
        We reviewed your registration for <strong>${safeCompanyName}</strong>, and
        we’re unable to approve it at this time.
      </p>
      ${
        safeNote
          ? `<div class="note"><strong>Note from ${storeOwnerName || "our team"}:</strong><br />${safeNote}</div>`
          : ""
      }
      <p>
        If you believe this needs a follow-up or want to submit updated details,
        please contact the store team or try again from the storefront.
      </p>
      <p style="text-align: center;">
        <a href="${storefrontUrl}" class="btn">Visit Store</a>
      </p>
      <p>
        Best regards,<br />
        <strong>${shopName || "B2B Portal"}</strong>
      </p>
    </div>
  </div>
</body>
</html>
`;

  const text = [
    "Registration Request Rejected",
    "",
    `Hello ${safeContactName},`,
    "",
    `We reviewed your registration for ${safeCompanyName}, and we’re unable to approve it at this time.`,
    safeNote ? "" : undefined,
    safeNote
      ? `Note from ${storeOwnerName || "our team"}: ${safeNote}`
      : undefined,
    "",
    `Visit store: ${storefrontUrl}`,
    "",
    `Best regards,`,
    shopName || "B2B Portal",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");

  return sendEmail({
    to: email,
    subject: "Update on your B2B registration",
    html,
    text,
  });
}
