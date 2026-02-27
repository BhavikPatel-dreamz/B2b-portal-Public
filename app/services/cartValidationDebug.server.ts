import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  registerCartValidationFunction,
  registerCartValidationWithExactQuery,
  unregisterCartValidationFunction
} from "./cartValidationRegistration.server";

/**
 * Debug service for testing cart validation function registration
 */
export class CartValidationDebugService {

  /**
   * Test the original registration approach
   */
  static async testOriginalRegistration(admin: AdminApiContext, customTitle?: string) {
    console.log("🧪 Testing original registration approach...");
    return await registerCartValidationFunction(admin, customTitle);
  }

  /**
   * Test the exact query registration approach from user's example
   */
  static async testExactQueryRegistration(admin: AdminApiContext, customTitle?: string) {
    console.log("🧪 Testing exact query registration approach...");
    return await registerCartValidationWithExactQuery(admin, customTitle);
  }

  /**
   * List all Shopify Functions (helpful for debugging)
   */
  static async listAllShopifyFunctions(admin: AdminApiContext) {
    try {
      const query = `
        query MyQuery {
          shopifyFunctions(first: 250) {
            edges {
              node {
                id
                handle
                app {
                  apiKey
                  handle
                  id
                  title
                }
                title
              }
            }
          }
        }
      `;

      const response = await admin.graphql(query);
      const data = await response.json();

      if (data.errors) {
        throw new Error(`Failed to query functions: ${data.errors[0]?.message}`);
      }

      console.log("📋 All Shopify Functions:", JSON.stringify(data, null, 2));
      return { success: true, functions: data.data?.shopifyFunctions?.edges || [] };

    } catch (error) {
      console.error("❌ Error listing functions:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * List all current validations
   */
  static async listAllValidations(admin: AdminApiContext) {
    try {
      const query = `
        query {
          validations(first: 50) {
            nodes {
              id
              functionId
              enabled
              title
              blockOnFailure
            }
          }
        }
      `;

      const response = await admin.graphql(query);
      const data = await response.json();

      if (data.errors) {
        throw new Error(`Failed to query validations: ${data.errors[0]?.message}`);
      }

      console.log("📋 All Validations:", JSON.stringify(data, null, 2));
      return { success: true, validations: data.data?.validations?.nodes || [] };

    } catch (error) {
      console.error("❌ Error listing validations:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Complete validation setup workflow
   */
  static async setupValidationWorkflow(admin: AdminApiContext, options?: {
    title?: string;
    useExactQuery?: boolean;
  }) {
    const { title = "B2B Portal Cart Validation", useExactQuery = false } = options || {};

    console.log("🔄 Starting complete validation setup workflow...");

    // Step 1: List current functions
    console.log("📋 Step 1: Listing all functions...");
    const functionsResult = await this.listAllShopifyFunctions(admin);

    if (!functionsResult.success) {
      return { success: false, step: "list_functions", error: functionsResult.error };
    }

    // Step 2: List current validations
    console.log("📋 Step 2: Listing current validations...");
    const validationsResult = await this.listAllValidations(admin);

    if (!validationsResult.success) {
      return { success: false, step: "list_validations", error: validationsResult.error };
    }

    // Step 3: Register validation
    console.log("🚀 Step 3: Registering cart validation...");
    const registerResult = useExactQuery
      ? await this.testExactQueryRegistration(admin, title)
      : await this.testOriginalRegistration(admin, title);

    return {
      success: registerResult.success,
      step: "register_validation",
      result: registerResult,
      functions: functionsResult.functions,
      validations: validationsResult.validations,
    };
  }

  /**
   * Clean up all cart validations (useful for testing)
   */
  static async cleanupCartValidations(admin: AdminApiContext) {
    try {
      console.log("🧹 Starting cleanup of cart validations...");

      const validationsResult = await this.listAllValidations(admin);
      if (!validationsResult.success) {
        return validationsResult;
      }

      const cartValidations = validationsResult.validations.filter((v: any) =>
        v.title?.toLowerCase().includes('cart') ||
        v.title?.toLowerCase().includes('validation') ||
        v.title?.toLowerCase().includes('b2b')
      );

      console.log(`🗑️ Found ${cartValidations.length} cart validation(s) to clean up`);

      const results = [];
      for (const validation of cartValidations) {
        console.log(`🗑️ Deleting validation: ${validation.title} (${validation.id})`);
        const deleteResult = await unregisterCartValidationFunction(admin, validation.id);
        results.push({ validation, deleteResult });
      }

      return {
        success: true,
        message: `Cleaned up ${cartValidations.length} cart validation(s)`,
        results,
      };

    } catch (error) {
      console.error("❌ Error during cleanup:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

export default CartValidationDebugService;
