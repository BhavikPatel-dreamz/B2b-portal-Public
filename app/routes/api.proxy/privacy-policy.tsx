import { LoaderFunctionArgs } from "react-router";

import { getCachedProxyStore, getProxyParams } from "app/utils/proxy.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Get proxy parameters
    const { shop } = getProxyParams(request);

    if (!shop) {
      return Response.json(
        { error: "Shop domain is required" },
        { status: 401 },
      );
    }

    const store = await getCachedProxyStore(shop);
    if (!store) {
      return Response.json(
        { error: "Store not found or unauthorized" },
        { status: 404 },
      );
    }

    return Response.json(
      {
        message: "Privacy policy fetched successfully",
        shopDomain: store.shopDomain,
        privacyPolicy: store.privacyPolicyContent || "",
        privacyPolicyLink: store.privacyPolicylink || "",
        contactEmail: store.contactEmail || "",
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("❌ Error fetching privacy policy:", error);
    return Response.json(
      {
       message: "Error fetching privacy policy",
       error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
};
