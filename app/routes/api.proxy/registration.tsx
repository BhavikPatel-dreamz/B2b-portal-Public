import { ActionFunctionArgs } from "react-router";
import { getProxyParams } from "app/utils/proxy.server";
import prisma from "app/db.server";
import { sendRegistrationEmail } from "app/utils/email";

/**
 * API endpoint for B2B registration form submission
 * This is used by the embed dashboard registration form
 *
 * Route: /apps/b2b-portal/api/proxy/registration
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("📝 Registration API called");

  try {
    // Get proxy parameters to identify the store
    const { shop } = getProxyParams(request);

    if (!shop) {
      return Response.json({
        success: false,
        error: 'Store identification failed. Please try again.'
      }, { status: 400 });
    }

    // Find the store in the database
    const store = await prisma.store.findUnique({
      where: { shopDomain: shop }
    });

    if (!store) {
      return Response.json({
        success: false,
        error: 'Store not found. Please ensure the app is installed.'
      }, { status: 404 });
    }

    // Parse form data
    const formData = await request.formData();
    const companyName = formData.get('companyName') as string;
    const contactName = formData.get('contactName') as string;
    const email = formData.get('email') as string;
    const phone = formData.get('phone') as string;
    const businessType = formData.get('businessType') as string;
    const website = formData.get('website') as string || null;
    const additionalInfo = formData.get('additionalInfo') as string || null;
    const customerId = formData.get('customerId') as string || null;

    console.log("📋 Registration data:", { companyName, contactName, email, phone, businessType });

    // Validate required fields
    if (!companyName || !contactName || !email || !phone || !businessType) {
      return Response.json({
        success: false,
        error: 'Please fill in all required fields.'
      }, { status: 400 });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return Response.json({
        success: false,
        error: 'Please enter a valid email address.'
      }, { status: 400 });
    }

    // Check if registration already exists
    const existingRegistration = await prisma.registrationSubmission.findFirst({
      where: {
        email,
        shopId: store.id
      }
    });

    if (existingRegistration) {
      return Response.json({
        success: false,
        error: 'A registration with this email already exists. Please contact support if you need assistance.'
      }, { status: 409 });
    }

    // Save the registration submission to the database
    const registration = await prisma.registrationSubmission.create({
      data: {
        companyName,
        contactName,
        email,
        phone,
        businessType,
        website,
        additionalInfo,
        shopId: store.id,
        status:'PENDING',
        shopifyCustomerId: `gid://shopify/Customer/${customerId}`,

      }
    });
         console.log("✅ Registration created:", registration.id);
    if (!store.submissionEmail) {
      return Response.json(
        {
          success: false,
          error: "Store contact email not configured, cannot send email.",
        },
        { status: 500 },
      );
    }

    const sendEmail = await sendRegistrationEmail(
      store.submissionEmail,
      email,
      companyName,
      contactName,
    );

     if (!sendEmail.success) {
      return Response.json({
        success: false,
        error: 'Failed to send registration email. Please try again.'
      }, { status: 500 });
    }

    console.log("✅ Registration created:", registration.id);

    return Response.json({
      success: true,
      message: 'Registration submitted successfully! We will review your application and get back to you within 2-3 business days.',
      registrationId: registration.id
    });

  } catch (error) {
    console.error('❌ Error saving registration:', error);
    return Response.json({
      success: false,
      error: 'An error occurred while submitting your registration. Please try again.'
    }, { status: 500 });
  }
};
