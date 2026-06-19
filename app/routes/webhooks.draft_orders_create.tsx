import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { Decimal } from "@prisma/client/runtime/library";
import prisma from "../db.server";

import { deductCredit } from "../services/tieredCreditService";
import { getCompanyByUserId } from "../services/user.server";
import {  upsertOrder } from "../services/order.server";
import { getStoreByDomain } from "../services/store.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, payload } = await authenticate.webhook(request);
  console.log(JSON.stringify(payload))
  console.log(`📝 Draft Order Created webhook received for shop: ${shop}`);


  interface ShopifyDraftOrder {
    id: string;
    name: string;
    email: string;
    total_price: string;
    currency: string;
    status: string;
    "b2b?": boolean;
    line_items?: {
      id: string;
      name: string;
      quantity: number;
      price: string;
      currency: string;
    }[];
    customer?: {
      id: string;
    };
    note_attributes?: {
      name: string;
      value: string;
    }[];
  }
  
  try {
    const draftOrder = payload as ShopifyDraftOrder;

    // Extract order source from note_attributes (e.g., 'quick_order')
    const orderSource =
      draftOrder.note_attributes?.find((attr) => attr.name === "_source")
        ?.value || null;
    const salesAgentUserId =
      draftOrder.note_attributes?.find(
        (attr) => attr.name === "_sales_agent_user_id",
      )?.value || null;

    // Validate required fields from the payload
    if (!draftOrder.id || !draftOrder.total_price) {
      console.log("❌ Invalid draft order payload - missing required fields");
      return new Response("Invalid payload", { status: 400 });
    }

    console.log(`Draft Order Details:`, {
      id: draftOrder.id,
      name: draftOrder.name,
      email: draftOrder.email,
      total_price: draftOrder.total_price,
      currency: draftOrder.currency,
      status: draftOrder.status,
      b2b: draftOrder["b2b?"],
      line_items_count: draftOrder.line_items?.length,
      source: orderSource,
    });

    // Check if this is a B2B draft order
    if (!draftOrder["b2b?"] || draftOrder["b2b?"] !== true) {
      console.log("❌ Not a B2B draft order - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    // Check if this is a B2B draft order
    if (!draftOrder.customer?.id) {
      console.log("❌ No customer found in draft order - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    const customerId = draftOrder.customer.id.toString();
    console.log(`🔍 Looking for B2B user with Shopify customer ID: ${customerId}`);

    // Find the store first to get shopId

    const store = await getStoreByDomain(shop);
        if (!store) {
          console.log(`Store not found for domain ${shop} — skipping B2B order log`);
          return new Response();
        }


    // Find B2B user by Shopify customer ID using user service
    const b2bUser = await getCompanyByUserId(store.id, `gid://shopify/Customer/${customerId}`);

    if (!b2bUser?.company) {
      console.log("❌ No B2B company found for customer - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    const salesAgent = salesAgentUserId
      ? await prisma.user.findFirst({
          where: {
            id: salesAgentUserId,
            role: "SALES_USER",
            salesCompanies: { some: { companyId: b2bUser.company.id } },
          },
          select: { id: true },
        })
      : null;
    const createdByUserId = salesAgent?.id || b2bUser.id;

    console.log(`✅ Found B2B company: ${b2bUser.company.name} (ID: ${b2bUser.company.id})`);

    const totalAmount = parseFloat(draftOrder.total_price || "0");
    console.log(`💰 Draft order total: ${totalAmount} ${draftOrder.currency}`);

    // PREVENT DOUBLE DEDUCTION: Check if this order was already processed by the app proxy or sales portal
    const existingB2bOrder = await prisma.b2BOrder.findFirst({
      where: {
        OR: [
          { shopifyOrderId: draftOrder.id.toString() },
          { shopifyOrderId: `gid://shopify/DraftOrder/${draftOrder.id}` },
          { 
            companyId: b2bUser.company.id,
            orderTotal: new Decimal(totalAmount),
            orderStatus: { in: ["draft", "submitted", "processing"] },
            createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } // Within last 5 mins
          }
        ]
      }
    });

    if (existingB2bOrder) {
      console.log(`ℹ️ Order ${draftOrder.id} already exists in database (ID: ${existingB2bOrder.id}).`);
      
      // Normalize/attach the Shopify draft ID so final-order conversion can find it.
      if (
        !existingB2bOrder.shopifyOrderId ||
        existingB2bOrder.shopifyOrderId === `gid://shopify/DraftOrder/${draftOrder.id}`
      ) {
        await prisma.b2BOrder.update({
          where: { id: existingB2bOrder.id },
          data: { shopifyOrderId: draftOrder.id.toString() }
        });
      }

      // If credit hasn't been reserved/deducted yet (i.e. creditUsed is 0) and we have a total price, reserve it now
      if (existingB2bOrder.creditUsed.equals(0) && totalAmount > 0) {
        console.log(`🏦 Reserving ${totalAmount} credit for existing order ${existingB2bOrder.id}`);
        await deductCredit(
          b2bUser.company.id,
          existingB2bOrder.id,
          totalAmount,
          b2bUser.id,
          admin
        );
        await prisma.b2BOrder.update({
          where: { id: existingB2bOrder.id },
          data: { creditUsed: new Decimal(totalAmount) }
        });
      }
      return new Response("OK", { status: 200 });
    }

    // Reserve credit for the draft order (pending review)
    try {
      console.log(`🏦 Attempting to deduct ${totalAmount} credit for company ${b2bUser.company.id}`);


      console.log(`💳 Credit reserved successfully for draft order ${draftOrder.name || `#${draftOrder.id}`}`);


      console.log(`📝 Upserting draft order ${JSON.stringify(draftOrder)}`);

      // Create or update order using upsert function
      const draftOrderData = await upsertOrder({
        shopifyOrderId: draftOrder.id.toString(),
        companyId: b2bUser.company.id,
        createdByUserId,
        shopId: store.id,
        orderTotal: totalAmount,
        creditUsed: totalAmount, // Use total amount since we deducted credit
        userCreditUsed: 0, // Add required field - no user-specific credit used for draft orders
        paymentStatus: "pending",
        orderStatus: "draft", // Draft order status
        remainingBalance: totalAmount,
        source: orderSource,
      });

      console.log(`📊 Upserted draft order in B2B system:`, {
        id: draftOrderData.id,
        shopifyOrderId: draftOrderData.shopifyOrderId,
        orderTotal: draftOrderData.orderTotal,
        creditUsed: draftOrderData.creditUsed,
        userCreditUsed: draftOrderData.userCreditUsed,
      });

     const creditDeductionResult = await deductCredit(
        b2bUser.company.id,
        draftOrderData.id, // Use the actual order ID from database instead of shopify order ID
        totalAmount,
        b2bUser.id,
        admin // Pass admin context for metafield sync
      );
      console.log(`✅ Credit deduction result:`, creditDeductionResult);


      console.log(`📊 Draft order stored in B2B system:`, {
        id: draftOrderData.id,
        shopifyOrderId: draftOrderData.shopifyOrderId,
        orderTotal: draftOrderData.orderTotal,
        creditUsed: draftOrderData.creditUsed,
        userCreditUsed: draftOrderData.userCreditUsed,
      });

    } catch (creditError: unknown) {
      console.error(`❌ Credit reservation failed:`, {
        error: (creditError as Error).message,
        stack: (creditError as Error).stack,
        companyId: b2bUser.company.id,
        orderAmount: totalAmount
      });
      // Don't fail the webhook, just log the error
      return new Response(`Credit reservation failed: ${(creditError as Error).message}`, { status: 500 });
    }

  } catch (error: unknown) {
    console.error(`❌ Error processing draft order webhook:`, (error as Error).message);
    console.error((error as Error).stack);
    return new Response(`Error: ${(error as Error).message}`, { status: 500 });
  }

  return new Response("OK", { status: 200 });
};
