import prisma from "app/db.server";
import { authenticate } from "app/shopify.server";
import { LoaderFunctionArgs } from "react-router";
import {
  deserializeConfig,
  type StoredConfig,
} from "../../utils/form-config.shared";


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};
 
/** Drop-in replacement for Response.json() that always includes CORS headers. */
function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}
 
// ─── LOADER ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // ✅ Handle OPTIONS preflight — must come before ANY other logic
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
 
  try {
    // await authenticate.public.appProxy(request);
    
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const customerId = url.searchParams.get("customerId");
    const customerGid = customerId
      ? `gid://shopify/Customer/${customerId}`
      : null;
 
    if (!shop) {
      return json({ error: "Missing shop" }, { status: 400 });
    }
 
    const store = await prisma.store.findUnique({
      where: { shopDomain: shop },
      select: { id: true, shopDomain: true },
    });
 
    // ❌ Store doesn't exist — return blank response (with CORS)
    if (!store) {
      return json({}, { status: 200 });
    }
 
    if (!customerId) {
      return json({ error: "Missing customerId" }, { status: 400 });
    }
 
    const [customer, userData] = await Promise.all([
      prisma.registrationSubmission.findFirst({
        where: {
          shopifyCustomerId: customerGid,
          shopId: store.id,
        },
        select: { status: true },
      }),
      prisma.user.findFirst({
        where: {
          shopifyCustomerId: customerGid,
          shopId: store.id,
        },
        select: {
          role: true,
          shopifyCustomerId: true,
        },
      }),
    ]);

    if (customer?.status === "PENDING") {
      return json({
        message: "Your account has already been submitted and is under review",
      });
    }

    if (userData?.shopifyCustomerId === customerGid && userData.role !== "STORE_ADMIN") {
      return json({
        message: "Your account is not a customer. Please contact the support team.",
        redirectTo: `https://${store.shopDomain}/pages/b2b-page-dashboard`
      });
    }
 
    if (customer?.status === "APPROVED") {
      return json({
        message: "Your account is approved, but B2B access is not yet configured in Shopify.",
        redirectTo: `https://${store.shopDomain}/pages/b2b-page-dashboard`,
      });
    }
 
    if (customer?.status === "REJECTED") {
      return json({
        message: "Your account has been rejected. Please contact the support team.",
      });
    }
 
 
    const formFieldConfig = await prisma.formFieldConfig.findUnique({
      where: { shopId: store.id },
      select: {
        fields: true,
        updatedAt: true,
      },
    });
 
    let config;
 
    if (formFieldConfig?.fields) {
      try {
        const stored = formFieldConfig.fields as unknown as StoredConfig;
 
        if (
          Array.isArray(stored) &&
          stored.length > 0 &&
          stored.every(
            (g) =>
              g.step?.id &&
              g.step?.label &&
              Array.isArray(g.fields) &&
              g.fields.every((f) => f.key && f.label && f.type !== undefined)
          )
        ) {
          config = deserializeConfig(stored);
        }
      } catch {
        config = [];
      }
    }
    console.log(config,"config------");
 
    return json({
      config,
      storeMissing: false,
      savedAt: formFieldConfig?.updatedAt?.toISOString() ?? null,
    });
 
  } catch (error) {
    console.error("❌ Error validating customer:11111", error);
 
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
