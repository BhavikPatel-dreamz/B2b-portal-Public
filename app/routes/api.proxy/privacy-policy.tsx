import { LoaderFunctionArgs } from "react-router";

import { getProxyParams } from "app/utils/proxy.server";
import { getStoreByDomain } from "app/services/store.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Get proxy parameters
    const { shop, loggedInCustomerId } = getProxyParams(request);

    const store = await getStoreByDomain(shop);
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
    console.error("❌ Error validating customer:", error);
    return Response.json(
      {
        isLoggedIn: false,
        hasB2BAccess: false,
        customerId: null,
        redirectTo: "/apps/b2b-portal/registration",
        message: "Error validating customer access",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
};
