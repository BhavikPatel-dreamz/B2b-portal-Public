/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { createUser, getUserByEmail } from "../services/user.server";
import { getCompaniesByShop } from "../services/company.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("customers/create webhook received");

  try {
    const { payload, shop, topic } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    // If an outdated subscription points to this path, ignore gracefully
    if (topic !== "CUSTOMERS_CREATE") {
      console.info(`Webhook topic ${topic} hit customers/create route. Ignoring.`);
      return new Response();
    }

    // Basic validation
    if (!payload || !shop) {
      return new Response("Invalid webhook payload", { status: 400 });
    }

    // Load store by shop domain
    const store = await getStoreByDomain(shop);
    if (!store) {
      console.warn(`Store not found for domain ${shop} — skipping customer sync`);
      return new Response();
    }

    // Extract customer data from webhook payload
    const customer = payload as any;
    const customerId = customer.id;
    const customerEmail = customer.email;
    const firstName = customer.first_name;
    const lastName = customer.last_name;
    const customerTags = customer.tags || "";

    if (!customerEmail || !customerId) {
      console.info("Customer has no email or ID; skipping B2B user creation");
      return new Response();
    }

    // Convert numeric Shopify customer ID to GraphQL GID
    const customerGid = `gid://shopify/Customer/${customerId}`;

    // Check if user already exists
    const existingUser = await getUserByEmail(customerEmail, store.id);
    if (existingUser) {
      console.info(`User with email ${customerEmail} already exists; skipping creation`);
      return new Response();
    }

    // Company assignment logic:
    // 1. Try to find company by Shopify company ID from customer metafields or tags
    // 2. If no specific company, check if customer has B2B tags to determine if they should be added
    // 3. Assign to default company or create pending registration

    let assignedCompany = null;

    // Check if customer has B2B-related tags (you can customize this logic)
    const isB2BCustomer = customerTags.toLowerCase().includes('b2b') ||
                         customerTags.toLowerCase().includes('business') ||
                         customerTags.toLowerCase().includes('company');

    if (!isB2BCustomer) {
      console.info(`Customer ${customerEmail} does not have B2B tags; skipping B2B user creation`);
      return new Response();
    }

    // Try to get the first available company for this store
    const companies = await getCompaniesByShop(store.id, { take: 1 });

    if (companies.length === 0) {
      console.warn(`No companies found for store ${shop}; cannot assign user to company`);
      // You might want to create a registration submission instead
      return new Response();
    }

    assignedCompany = companies[0];

    // Create the user in your local database
    const newUser = await createUser({
      email: customerEmail,
      firstName: firstName || null,
      lastName: lastName || null,
      password: "", // Placeholder password for B2B users created via Shopify
      role: "STORE_USER",
      status: "PENDING", // Set to pending so they need approval
      shopId: store.id,
      companyId: assignedCompany.id,
      companyRole: "member",
      shopifyCustomerId: customerGid,
      userCreditLimit: 0,
    });

    console.log(`Created B2B user ${newUser.id} for Shopify customer ${customerId} and assigned to company ${assignedCompany.name}`);

    // TODO: You might want to:
    // 1. Send a welcome email to the new user
    // 2. Trigger a notification to administrators about the new user registration
    // 3. Set up initial user permissions or credit limits

    return new Response();

  } catch (error) {
    console.error("Error processing customers/create webhook:", error);
    return new Response("Internal server error", { status: 500 });
  }
};
