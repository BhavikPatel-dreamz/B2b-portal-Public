import axios from 'axios';

interface EmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function sendEmail({ to, subject, html, text }: EmailParams) {
  try {
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { 
          email: process.env.BREVO_FROM_EMAIL,
          name: 'B2B Portal'
        },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html,
        textContent: text,
      },
      {
        headers: {
          'accept': 'application/json',
          'api-key': process.env.BREVO_API_KEY,
          'content-type': 'application/json',
        },
      }
    );
    
    console.log('✅ Email sent successfully:', response.data);
    return { success: true, messageId: response.data.messageId };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('❌ Brevo API Error:', error.response?.data);
      throw new Error(error.response?.data?.message || 'Failed to send email');
    }
    throw error;
  }
}

export async function sendRegistrationEmail(
  contactEmail: string,
  email: string,
  companyName: string,
  contactName: string
) {
  const { html, text } = generateRegistrationTemplate(
    companyName, 
    contactName, 
    email
  );
  
  return sendEmail({
    to: contactEmail,
    subject: `Company Inquiry: ${companyName}`,
    html,
    text,
  });
}

function generateRegistrationTemplate(companyName: string, contactName: string, email: string) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Company Inquiry</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f6f8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #0d6efd; padding: 20px; text-align: center; color: #fff; border-radius: 8px 8px 0 0; }
    .content { background-color: #ffffff; padding: 30px; border: 1px solid #dee2e6; }
    .footer { background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #6c757d; border-radius: 0 0 8px 8px; }
    .btn { display: inline-block; padding: 12px 24px; background-color: #0d6efd; color: #fff; text-decoration: none; border-radius: 4px; margin: 20px 0; }
    .btn:hover { background-color: #0b5ed7; }
    .highlight { background-color: #e7f1ff; padding: 15px; border-radius: 4px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Company Inquiry</h1>
    </div>

    <div class="content">
      <p>Hello <strong>Store Owner</strong>,</p>

      <p>
        We are pleased to inform you that a new company inquiry has been successfully
        received on the platform by <strong>${companyName}</strong>.
      </p>

      <div class="highlight">
        <p><strong>Company Name:</strong> ${companyName}</p>
        <p><strong>Inquired By:</strong> ${contactName}</p>
        <p><strong>Contact Email:</strong> ${email}</p>
      </div>

      <p>
        You can now log in to your dashboard to review company details,
        manage access, and monitor analytics.
      </p>

      <p>
        If you have any questions or need assistance, please feel free to
        contact our support team.
      </p>

      <p>
        Best regards,<br />
        <strong>${email}</strong>
      </p>
    </div>
  </div>
</body>
</html>
`;

  const text = `
 Company Inquiry: ${companyName}

Hello Store Owner,

A new company inquiry has been received on the platform.

Company Name: ${companyName}
Inquired By: ${contactName}
Contact Email: ${email}

You can now log in to your dashboard to review company details and manage access.

If you have any questions or need assistance, please contact our support team.

Best regards,
${email}

---
This email was sent to notify you about a new company inquiry.
`;

  return { html, text };
}

export async function sendCompanyAssignmentEmail(
  email: string,
  companyName: string ,
  contactName: string
) {
  const { html, text } = generateCompanyAssignmentTemplate(companyName, contactName);
  
  return sendEmail({
    to: email,
    subject: "You've been assigned to a company on our platform",
    html,
    text,
  });
}

function generateCompanyAssignmentTemplate(companyName: string, contactName: string) {
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
    .btn { display: inline-block; padding: 12px 24px; background-color: #0d6efd; color: #fff; text-decoration: none; border-radius: 4px; margin: 20px 0; }
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
        assigned to your account by the <strong>Store Owner</strong>.
      </p>

      <div class="highlight">
        <p><strong>Company Name:</strong> ${companyName}</p>
        <p><strong>Your Role:</strong> Company Admin</p>
      </div>

      <p>
        You can now log in to the platform and start managing your company,
        users, and locations.
      </p>

      <p>
        If you have any questions or face any issues, please feel free to
        contact our support team.
      </p>

      <p>
        Best regards,<br />
        <strong>Store Owner</strong>
      </p>
    </div>
  </div>
</body>
</html>
`;

  const text = `
Company Assigned Successfully

Hello Company Admin,

A company has been successfully assigned to your account by the Store Admin.

Company Name: ${companyName}
Role: Company Administrator

You can now log in to the platform and start managing your company, users,
and locations.


If you have any questions or need assistance, please contact our support team.

Best regards,
Store Owner
`;

  return { html, text };
}