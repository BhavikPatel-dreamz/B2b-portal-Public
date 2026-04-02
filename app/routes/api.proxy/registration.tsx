import { ActionFunctionArgs, LoaderFunction } from "react-router";
import { getProxyParams } from "app/utils/proxy.server";
import { sendRegistrationEmail } from "app/utils/email";
import { getStoreByDomain } from "app/services/store.server";
import prisma from "app/db.server";


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",          
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",            // cache preflight for 24 h
};
 

function json(data: unknown, init: ResponseInit = {}) {
  const status = (init as { status?: number }).status ?? 200;
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function handlePreflight(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }
  return null;
}

export const loader: LoaderFunction = async ({ request }) => {
  // ✅ Handle CORS preflight
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
 
  const { shop, loggedInCustomerId: shopifyCustomerId } = getProxyParams(request);
 
  if (!shopifyCustomerId) {
    return json({ success: false, error: "Shopify customer ID is required." }, { status: 400 });
  }
 
  const store = await getStoreByDomain(shop);
  if (!store) {
    return json({ success: false, error: "Store not found." }, { status: 404 });
  }
 
  const data = await prisma.registrationSubmission.findFirst({
    where: {
      shopifyCustomerId: `gid://shopify/Customer/${shopifyCustomerId}`,
      shopId: store.id,
    },
  });
 
  return json({
    success: true,
    message: "Registration details fetched successfully.",
    data,
  });
};
 
// ─── ACTION (POST) ─────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("📝 Registration API called");
 
  // ✅ Handle CORS preflight
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
 
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
 
    if (!shop) {
      return json({ success: false, error: "Store identification failed." }, { status: 400 });
    }
 
    const store = await getStoreByDomain(shop);
    if (!store) {
      return json({ success: false, error: "Store not found." }, { status: 404 });
    }
 
    // ✅ Parse dynamic form data
    const formData = await request.formData();
    const allFields: Record<string, any> = {};
    for (const [key, value] of formData.entries()) {
      allFields[key] = value;
    }
    console.log("🔥 All Form Data:", allFields);
 
    // ✅ Extract main fields
    const companyName = allFields.companyName || "";
    const emailKey = Object.keys(allFields).find((key) =>
      key.toLowerCase().includes("email")
    );
    const email = emailKey ? allFields[emailKey] : "";
    const firstName = allFields.firstName || "";
    const lastName = allFields.lastName || "";
    const contactTitle = allFields.contactTitle || "";
 
    // ✅ Basic validation
    if (!companyName || !email) {
      return json(
        { success: false, error: "Company name and email are required." },
        { status: 400 }
      );
    }
 
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return json({ success: false, error: "Invalid email format." }, { status: 400 });
    }
 
    // ✅ Duplicate email check
    const existing = await prisma.registrationSubmission.findFirst({
      where: { shopId: store.id, email },
    });
    console.log("✅ Existing Registration:", existing);
 
    if (existing) {
      return json({ success: false, error: "Email already registered." }, { status: 409 });
    }
 
    // ✅ Split fields
    const shipping: Record<string, any> = {};
    const billing: Record<string, any> = {};
    const customFields: Record<string, any> = {};
 
    Object.entries(allFields).forEach(([key, value]) => {
      if (key.startsWith("ship")) {
        shipping[key.replace("ship", "")] = value;
      } else if (key.startsWith("bill")) {
        billing[key.replace("bill", "")] = value;
      } else if (
        !["companyName", "email", "firstName", "lastName", "contactTitle", "shopifyCustomerId"].includes(key)
      ) {
        customFields[key] = value;
      }
    });
    const regitrationData = await prisma.registrationSubmission.findFirst({
      where: { shopId: store.id, email },
    });

    if(regitrationData?.companyName === companyName){
      return json({ success: false, error: "Company already registered." }, { status: 409 });
    }

    // ✅ Save in DB
    const registration = await prisma.registrationSubmission.create({
      data: {
        companyName,
        email,
        firstName,
        lastName,
        contactTitle,
        shipping,
        billing,
        customFields,
        shopId: store.id,
        shopifyCustomerId: allFields.shopifyCustomerId || null,
      },
    });


        if (store.submissionEmail) {
        const emailResult = await sendRegistrationEmail(
        store.id,
        store.submissionEmail,
        store.storeOwnerName || '',
        email,
        companyName,
        `${registration?.firstName || ""} ${registration?.lastName || ""}`,
      );
    
     if (emailResult.success) {
         console.log("✅ Registration email sent successfully");
       } else {
        console.warn("⚠️ Failed to send registration email:", emailResult.error);
      }
    };
 
    return json({
      success: true,
      message: "Registration submitted successfully!",
      registrationdata: registration,
    });
 
  } catch (error) {
    console.error("❌ Error:", error.message);
    return json({ success: false, error: "Something went wrong." }, { status: 500 });
  }
};
 
 