import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { uninstallStore } from "../services/store.server";

 export  const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { shop, session, topic } = await authenticate.webhook(request);

    console.log(`Received ${topic} webhook for ${shop}`);
    
    const store = await db.store.findUnique({ where: { shopDomain: shop } });

    if (!store) {
      console.error(`Store not found for shop: ${shop}`);
      return new Response(
        JSON.stringify({ 
          success: false, 
          message: "Store not found" 
        }), 
        { 
          status: 404,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Delete related data in proper order to avoid foreign key conflicts
    try {
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }

      // Delete user sessions first
      const users = await db.user.findMany({ where: { shopId: store.id } });
      if (users.length > 0) {
        const userIds = users.map(u => u.id);
        await db.userSession.deleteMany({ where: { userId: { in: userIds } } });
      }

      // Delete order payments
      const orders = await db.b2BOrder.findMany({ where: { shopId: store.id } });
      if (orders.length > 0) {
        const orderIds = orders.map(o => o.id);
        await db.orderPayment.deleteMany({ where: { orderId: { in: orderIds } } });
      }

      // Delete credit transactions
      const companyAccounts = await db.companyAccount.findMany({ where: { shopId: store.id } });
      if (companyAccounts.length > 0) {
        const companyIds = companyAccounts.map(c => c.id);
        await db.creditTransaction.deleteMany({ where: { companyId: { in: companyIds } } });
      }

      // Delete main records
      await db.wishlist.deleteMany({ where: { shop } });
      await db.notification.deleteMany({ where: { shopId: store.id } });
      await db.b2BOrder.deleteMany({ where: { shopId: store.id } });
      await db.companyAccount.deleteMany({ where: { shopId: store.id } });
      await db.registrationSubmission.deleteMany({ where: { shopId: store.id } });
      await db.user.deleteMany({ where: { shopId: store.id } });

      // Mark store as uninstalled
      await uninstallStore(shop);

      console.log(`Successfully uninstalled store: ${shop}`);
      
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "Store successfully uninstalled and all related data deleted" 
        }), 
        { 
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );

    } catch (deleteError) {
      console.error("Error deleting store data:", deleteError);
      
      // Still try to mark store as uninstalled even if some deletions failed
      await uninstallStore(shop).catch((err) =>
        console.error("Failed to mark store uninstalled", err),
      );

      return new Response(
        JSON.stringify({ 
          success: false, 
          message: "Error occurred while deleting store data",
          error: deleteError instanceof Error ? deleteError.message : "Unknown error"
        }), 
        { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

  } catch (error) {
    console.error("Error processing uninstall webhook:", error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        message: "Error processing uninstall webhook",
        error: error instanceof Error ? error.message : "Unknown error"
      }), 
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};