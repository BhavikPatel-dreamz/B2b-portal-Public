import type { ActionFunctionArgs } from "react-router";
import { sendEmail } from "app/utils/email";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const formData = await request.formData();
    const firstName = (formData.get("firstName") as string)?.trim();
    const lastName = (formData.get("lastName") as string)?.trim();
    const email = (formData.get("email") as string)?.trim();
    const countryCode = (formData.get("countryCode") as string)?.trim() || "";
    const phoneInput = (formData.get("phone") as string)?.trim() || "";
    const phone = phoneInput ? `${countryCode} ${phoneInput}` : "N/A";
    const comment = (formData.get("comment") as string)?.trim();

    if (!firstName || !lastName || !email || !comment) {
      return Response.json(
        { success: false, message: "All fields are required." },
        { status: 400 },
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json(
        { success: false, message: "Please provide a valid email address." },
        { status: 400 },
      );
    }

    const subject = `Support Request from ${firstName} ${lastName}`;
    const html = `
      <table width="100%" cellpadding="8" style="font-family: Arial, sans-serif; color: #303030;">
        <tr>
          <td style="font-weight: 600; color: #6b7280; width: 120px;">Name:</td>
          <td>${firstName} ${lastName}</td>
        </tr>
        <tr>
          <td style="font-weight: 600; color: #6b7280;">Email:</td>
          <td><a href="mailto:${email}" style="color: #0a61c7;">${email}</a></td>
        </tr>
        <tr>
          <td style="font-weight: 600; color: #6b7280;">Phone:</td>
          <td>${phone}</td>
        </tr>
        <tr>
          <td style="font-weight: 600; color: #6b7280;">Comment:</td>
          <td style="white-space: pre-wrap;">${comment}</td>
        </tr>
      </table>
    `;
    const text = `Name: ${firstName} ${lastName}\nEmail: ${email}\nPhone: ${phone}\nComment: ${comment}`;

    const toEmail = process.env.SMTP_FROM_EMAIL || "support@dreamzapps.com";
    
    const result = await sendEmail({
      to: toEmail,
      subject,
      html,
      text,
    });

    if (result.success) {
      return Response.json({ success: true, message: "Message sent successfully." });
    } else {
      console.error("Support form email failed:", result.error);
      return Response.json(
        { success: false, message: "Failed to send message. Please try again later." },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Support form error:", error);
    return Response.json(
      { success: false, message: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
