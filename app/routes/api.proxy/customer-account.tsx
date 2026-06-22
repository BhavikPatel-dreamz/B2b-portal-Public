import prisma from "app/db.server";
import { LoaderFunctionArgs } from "react-router";
import { authenticateCustomerAccountSession } from "app/utils/customer-account-session.server";
import {
  deserializeConfig,
  DEFAULT_CONFIG,
  type StoredConfig,
} from "../../utils/form-config.shared";
import {
  getFreePlanRegistrationsLimitMessage,
  getFreePlanUsage,
} from "app/utils/free-plan-limits.server";
import {
  checkCustomerIsB2BInShopifyByREST,
  getCustomerCompanyInfo,
} from "app/utils/b2b-customer.server";


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
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
    const { shop, customerGid, customerId } =
      await authenticateCustomerAccountSession(request, {
        requireCustomer: false,
      });
 
    if (!shop) {
      return json({ error: "Missing shop" }, { status: 400 });
    }
 
    const store = await prisma.store.findUnique({
      where: { shopDomain: shop },
      select: { id: true, shopDomain: true, plan: true, accessToken: true },
    });
 
    // ❌ Store doesn't exist — return blank response (with CORS)
    if (!store) {
      return json({}, { status: 200 });
    }
 
    const [customerRecord, userData, companyData] = customerGid
      ? await Promise.all([
          prisma.registrationSubmission.findFirst({
            where: {
              shopifyCustomerId: customerGid,
              shopId: store.id,
            },
            select: { status: true, reviewNotes: true },
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
          prisma.companyAccount.findFirst({
            where: {
              shopId: store.id,

            },
            select: {
              id: true,
              name: true,
              isDisable: true,
            }
          })
        ])
      : [null, null, null];

    if (customerRecord?.status === "PENDING") {
      return json({
        message: "Your account has already been submitted and is under review",
        reviewNotes: customerRecord.reviewNotes ?? null,
      });
    }

    if (
      userData &&
      userData.shopifyCustomerId === customerGid &&
      userData.role !== "STORE_ADMIN"
    ) {
      return json({
        message: "Your account is not a customer. Please contact the support team.",
        redirectTo: `https://${store.shopDomain}/apps/b2b-portal-public-3/smartb2b`,
      });
    }

    if (customerGid && customerId && store.accessToken) {
      try {
        const customerCompanyInfo = await getCustomerCompanyInfo(
          customerId,
          shop,
          store.accessToken,
        );

        if (customerCompanyInfo.hasCompany) {
          return json({
            message: "Your B2B account is already active.",
            redirectTo: `https://${store.shopDomain}/apps/b2b-portal-public-3/smartb2b`,
          });
        }

        const b2bCheck = await checkCustomerIsB2BInShopifyByREST(
          shop,
          customerId,
          store.accessToken,
        );

        if (b2bCheck.success && b2bCheck.hasAccess) {
          return json({
            message: "Your B2B account is already active.",
            redirectTo: `https://${store.shopDomain}/apps/b2b-portal-public-3/smartb2b`,
          });
        }
      } catch (error) {
        console.error("❌ Error checking Shopify B2B access:", error);
      }
    }
 
    if (customerRecord?.status === "APPROVED") {
      return json({
        message: "Your account is approved, but B2B access is not yet configured in Shopify.",
        redirectTo: `https://${store.shopDomain}/apps/b2b-portal-public-3/smartb2b`,
      });
    }
 
    if (customerRecord?.status === "REJECTED") {
      return json({
        message: "Your account has been rejected. Please contact the support team.",
        reviewNotes: customerRecord.reviewNotes ?? null,
      });
    }
    if(companyData?.isDisable == true){
      return json(
        {
          message: "Your company account has been deactivated. Please contact the support team.",
        },
      )}

    if (customerGid && store.plan === "free" && !customerRecord && !userData) {
      const usage = await getFreePlanUsage(store.id);

      if (usage.registrationLimitReached) {
        return json({
          message: getFreePlanRegistrationsLimitMessage(),
          reviewNotes:
            "The merchant has reached the free plan registration limit.",
        });
      }
    }
 
 
    const formFieldConfig = await prisma.formFieldConfig.findUnique({
      where: { shopId: store.id },
      select: {
        fields: true,
        updatedAt: true,
      },
    });
 
    let config = DEFAULT_CONFIG;
 
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
        config = DEFAULT_CONFIG;
      }
    }
  
 
    return json({
      config,
      storeMissing: false,
      savedAt: formFieldConfig?.updatedAt?.toISOString() ?? null,
      appUrl: process.env.SHOPIFY_APP_URL || "",
    });
 
  } catch (error) {
    if (error instanceof Response) {
      return json(
        { error: error.statusText || "Unauthorized" },
        { status: error.status || 401 }
      );
    }

    console.error("❌ Error validating customer", error);
 
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
