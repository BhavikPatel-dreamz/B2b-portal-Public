/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { deleteUser, getUserByEmail, getUserById } from "../services/user.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("customers/delete webhook received");

  try {
    const { payload, shop, topic } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    // If an outdated subscription points to this path, ignore gracefully
    if (topic !== "CUSTOMERS_DELETE") {
      console.info(`Webhook topic ${topic} hit customers/delete route. Ignoring.`);
      return new Response();
    }

    // Basic validation
    if (!payload || !shop) {
      return new Response("Invalid webhook payload", { status: 400 });
    }

    // Load store by shop domain
    const store = await getStoreByDomain(shop);
    if (!store) {
      console.warn(`Store not found for domain ${shop} — skipping customer deletion sync`);
      return new Response();
    }

    // Extract customer data from webhook payload
    console.log("Processing customer deletion for payload:", payload);
    const customer = payload as any;
    const customerId = customer.id;
    const customerEmail = customer.email;
    const adminGraphqlApiId = customer.admin_graphql_api_id;
    if (!customerId) {
      console.info("Customer has no email or ID; skipping B2B user deletion");
      return new Response();
    }

    // Find the existing user by email and shop
    const existingUser = await getUserById(adminGraphqlApiId, store.id);

    if (!existingUser) {
      console.info(`No local user found for shopify ${adminGraphqlApiId} in store ${shop}; nothing to delete`);
      return new Response();
    }

    // Convert numeric Shopify customer ID to GraphQL GID for verification
    const customerGid = `gid://shopify/Customer/${customerId}`;

    // Verify the Shopify customer ID matches (extra safety check)
    if (existingUser.shopifyCustomerId && existingUser.shopifyCustomerId !== customerGid) {
      console.warn(`Shopify customer ID mismatch for user ${existingUser.id}. Expected: ${customerGid}, Got: ${existingUser.shopifyCustomerId}`);
      return new Response();
    }

    // Delete the user from your local database
    await deleteUser(existingUser.id, store.id);

    console.log(`✅ Deleted B2B user ${existingUser.id} (${customerEmail}) for Shopify customer ${customerId} from company ${existingUser.companyId || 'N/A'}`);

    return new Response();

  } catch (error) {
    console.error("❌ Error processing customers/delete webhook:", error);
    return new Response("Internal server error", { status: 500 });
  }
};
