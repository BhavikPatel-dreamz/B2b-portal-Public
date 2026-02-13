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