import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

interface CartValidationFunction {
  id: string;
  title: string;
  apiType: string;
  app: {
    apiKey: string;
    id: string;
    title: string;
  };
}

interface CartValidation {
  id: string;
  functionId: string;
}

/**
 * Register Cart Validation function during app installation
 * @param admin - AdminApiContext from Shopify
 * @param validationTitle - Optional custom title for the validation (defaults to "B2B Portal Cart Validation")
 */
export async function registerCartValidationFunction(
  admin: AdminApiContext,
  validationTitle: string = "B2B Portal Cart Validation"
) {
  try {
    console.log("🔄 Checking Cart Validation function registration...");

    // Step 1: Find our cart validation function
    const functionsQuery = `
      query {
        shopifyFunctions(first: 250) {
          nodes {
            id
            title
            apiType
            app {
              apiKey
              id
              title
            }
          }
        }
      }
    `;

    const functionsResponse = await admin.graphql(functionsQuery);
    const functionsData = await functionsResponse.json();

    if (functionsData.errors) {
      throw new Error(`Failed to query functions: ${functionsData.errors[0]?.message}`);
    }

    // Debug: Log all available functions
    const availableFunctions = functionsData.data?.shopifyFunctions?.nodes || [];
    console.log(`📋 Found ${availableFunctions.length} total Shopify Functions:`);

    availableFunctions.forEach((fn: CartValidationFunction) => {
      console.log(`  - ${fn.title} (id: ${fn.id}, apiType: ${fn.apiType}, app: ${fn.app?.title || 'N/A'})`);
    });

    // Find cart validation functions with flexible matching
    const cartValidationFunctions = availableFunctions.filter((fn: CartValidationFunction) => {
      const isCartValidation = fn.apiType === "cart_validation";
      const hasValidationTitle = fn.title && (
        fn.title.toLowerCase().includes("cart") && fn.title.toLowerCase().includes("validation") ||
        fn.title.toLowerCase().includes("checkout") ||
        fn.title === "cart-checkout-validation"
      );
      return isCartValidation || hasValidationTitle;
    });

    console.log(`🎯 Found ${cartValidationFunctions.length} potential cart validation functions:`);
    cartValidationFunctions.forEach((fn: CartValidationFunction) => {
      console.log(`  - ${fn.title} (id: ${fn.id}, apiType: ${fn.apiType})`);
    });

    // Try to find the best match
    const cartValidationFunction = cartValidationFunctions.find((fn: CartValidationFunction) =>
      fn.apiType === "cart_validation"
    ) || cartValidationFunctions.find((fn: CartValidationFunction) =>
      fn.title === "cart-checkout-validation"
    ) || cartValidationFunctions[0]; // Fallback to first found

    if (!cartValidationFunction) {
      console.log("❌ No cart validation function found");
      console.log("📊 Available function types:", [...new Set(availableFunctions.map(fn => fn.apiType))]);
      return {
        success: false,
        message: "Cart validation function not found",
        debug: {
          totalFunctions: availableFunctions.length,
          availableTypes: [...new Set(availableFunctions.map(fn => fn.apiType))],
          allFunctions: availableFunctions.map(fn => ({ title: fn.title, apiType: fn.apiType, id: fn.id }))
        }
      };
    }

    console.log(`📋 Found cart validation function: ${cartValidationFunction.title} (id: ${cartValidationFunction.id}, apiType: ${cartValidationFunction.apiType})`);
    console.log(`📱 App details: ${cartValidationFunction.app.title} (${cartValidationFunction.app.id})`);

    // Step 2: Check if already registered
    const validationsQuery = `
      query {
        validations(first: 10) {
          nodes {
            id
            functionId
          }
        }
      }
    `;

    const validationsResponse = await admin.graphql(validationsQuery);
    const validationsData = await validationsResponse.json();

    if (validationsData.errors) {
      throw new Error(`Failed to query validations: ${validationsData.errors[0]?.message}`);
    }

    const existingValidation = validationsData.data?.validations?.nodes?.find(
      (validation: CartValidation) => validation.functionId === cartValidationFunction.id
    );

    if (existingValidation) {
      console.log(`✅ Cart validation already registered: ${existingValidation.id}`);
      return {
        success: true,
        message: "Cart validation already registered",
        validationId: existingValidation.id
      };
    }

    // Step 3: Register the cart validation using functionHandle
    const registerMutation = `
      mutation validationCreate($validation: ValidationCreateInput!) {
        validationCreate(validation: $validation) {
          userErrors {
            field
            message
          }
          validation {
            id
          }
        }
      }
    `;

    const registerResponse = await admin.graphql(registerMutation, {
      variables: {
        validation: {
          functionId: cartValidationFunction.id,
          enable: true,
          blockOnFailure: true,
          title: validationTitle
        },
      },
    });

    const registerData = await registerResponse.json();

    if (registerData.errors || registerData.data?.validationCreate?.userErrors?.length > 0) {
      const error = registerData.errors?.[0]?.message ||
        registerData.data?.validationCreate?.userErrors?.[0]?.message;
      throw new Error(`Failed to register cart validation: ${error}`);
    }

    const validation = registerData.data?.validationCreate?.validation;
    console.log(`🎉 Cart validation registered successfully: ${validation.id}`);

    return {
      success: true,
      message: "Cart validation registered successfully using function ID",
      validationId: validation.id,
      functionId: cartValidationFunction.id,
      functionApiType: cartValidationFunction.apiType,
      appDetails: cartValidationFunction.app,
    };

  } catch (error) {
    console.error("❌ Error registering cart validation function:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Unregister Cart Validation function (useful for cleanup or re-registration)
 */
export async function unregisterCartValidationFunction(admin: AdminApiContext, validationId: string) {
  try {
    const deleteMutation = `
      mutation validationDelete($id: ID!) {
        validationDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
          }
        }
      }
    `;

    const deleteResponse = await admin.graphql(deleteMutation, {
      variables: { id: validationId },
    });

    const deleteData = await deleteResponse.json();

    if (deleteData.errors || deleteData.data?.validationDelete?.userErrors?.length > 0) {
      const error = deleteData.errors?.[0]?.message ||
        deleteData.data?.validationDelete?.userErrors?.[0]?.message;
      throw new Error(`Failed to unregister cart validation: ${error}`);
    }

    console.log(`🗑️ Cart validation unregistered: ${deleteData.data?.validationDelete?.deletedId}`);
    return { success: true, deletedId: deleteData.data?.validationDelete?.deletedId };

  } catch (error) {
    console.error("❌ Error unregistering cart validation function:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Alternative implementation that matches the exact GraphQL queries from the user's example
 * This function demonstrates the exact approach described in the user's request
 */
export async function registerCartValidationWithExactQuery(
  admin: AdminApiContext,
  validationTitle: string = "CentralCleaningSupplies"
) {
  try {
    console.log("🔄 Running exact query implementation for cart validation...");

    // Updated query using available fields (removed handle fields)
    const myQuery = `
      query MyQuery {
        shopifyFunctions(first: 250) {
          nodes {
            id
            title
            apiType
            app {
              apiKey
              id
              title
            }
          }
        }
      }
    `;

    const functionsResponse = await admin.graphql(myQuery);
    const functionsData = await functionsResponse.json();

    if (functionsData.errors) {
      throw new Error(`Failed to query functions: ${functionsData.errors[0]?.message}`);
    }

    console.log("📋 Function query response:", JSON.stringify(functionsData, null, 2));

    // Debug: Log all available functions
    const availableFunctions = functionsData.data?.shopifyFunctions?.nodes || [];
    console.log(`📋 Found ${availableFunctions.length} total functions for exact query approach:`);

    availableFunctions.forEach((fn: CartValidationFunction) => {
      console.log(`  - ${fn.title} (id: ${fn.id}, apiType: ${fn.apiType}, app: ${fn.app?.title || 'N/A'})`);
    });

    // Find cart-checkout-validation function by apiType and title patterns with flexible matching
    const targetFunction = availableFunctions.find((fn: CartValidationFunction) =>
      fn.apiType === "cart_validation"
    ) || availableFunctions.find((fn: CartValidationFunction) =>
      fn.title === "cart-checkout-validation" || fn.title.includes("cart-checkout-validation")
    ) || availableFunctions.find((fn: CartValidationFunction) =>
      fn.title && (fn.title.toLowerCase().includes("cart") || fn.title.toLowerCase().includes("validation"))
    );

    if (!targetFunction) {
      console.log("❌ No matching function found for exact query approach");
      console.log("📊 Available function types:", [...new Set(availableFunctions.map(fn => fn.apiType))]);
      return {
        success: false,
        message: "cart-checkout-validation function not found",
        debug: {
          totalFunctions: availableFunctions.length,
          availableTypes: [...new Set(availableFunctions.map(fn => fn.apiType))],
          allFunctions: availableFunctions.map(fn => ({ title: fn.title, apiType: fn.apiType, id: fn.id }))
        }
      };
    }

    console.log(`✅ Found function:`, targetFunction);

    // Exact mutation from user's example
    const validationCreateMutation = `
      mutation validationCreate($validation: ValidationCreateInput!) {
        validationCreate(validation: $validation) {
          userErrors {
            field
            message
          }
          validation {
            id
          }
        }
      }
    `;

    // Updated input using functionId instead of functionHandle
    const mutationInput = {
      validation: {
        functionId: targetFunction.id,
        enable: true,
        blockOnFailure: true,
        title: validationTitle
      }
    };

    console.log("🚀 Creating validation with input:", JSON.stringify(mutationInput, null, 2));

    const createResponse = await admin.graphql(validationCreateMutation, {
      variables: mutationInput
    });

    const createData = await createResponse.json();

    if (createData.errors || createData.data?.validationCreate?.userErrors?.length > 0) {
      const error = createData.errors?.[0]?.message ||
        createData.data?.validationCreate?.userErrors?.[0]?.message;
      throw new Error(`Failed to create validation: ${error}`);
    }

    const validation = createData.data?.validationCreate?.validation;
    console.log(`🎉 Validation created successfully:`, validation);

    return {
      success: true,
      message: "Cart validation created using exact query approach",
      validationId: validation.id,
      functionData: targetFunction,
    };

  } catch (error) {
    console.error("❌ Error in exact query implementation:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Debug utility to list all available Shopify Functions
 * Useful for troubleshooting when cart validation function isn't found
 */
export async function debugListAllShopifyFunctions(admin: AdminApiContext) {
  try {
    console.log("🔍 Debug: Listing ALL Shopify Functions...");

    const functionsQuery = `
      query {
        shopifyFunctions(first: 250) {
          nodes {
            id
            title
            apiType
            app {
              apiKey
              id
              title
            }
          }
        }
      }
    `;

    const functionsResponse = await admin.graphql(functionsQuery);
    const functionsData = await functionsResponse.json();

    if (functionsData.errors) {
      throw new Error(`Failed to query functions: ${functionsData.errors[0]?.message}`);
    }

    const availableFunctions = functionsData.data?.shopifyFunctions?.nodes || [];

    console.log("=" .repeat(80));
    console.log(`📋 COMPLETE FUNCTION LIST (${availableFunctions.length} total):`);
    console.log("=" .repeat(80));

    // Group by apiType for better visibility
    const groupedFunctions = availableFunctions.reduce((groups: any, fn: CartValidationFunction) => {
      const type = fn.apiType || 'unknown';
      if (!groups[type]) groups[type] = [];
      groups[type].push(fn);
      return groups;
    }, {});

    Object.entries(groupedFunctions).forEach(([apiType, functions]: [string, any]) => {
      console.log(`\n🏷️ ${apiType.toUpperCase()} (${functions.length} functions):`);
      functions.forEach((fn: CartValidationFunction) => {
        console.log(`  • ${fn.title}`);
        console.log(`    ID: ${fn.id}`);
        console.log(`    App: ${fn.app?.title || 'N/A'} (${fn.app?.id || 'N/A'})`);
        console.log("");
      });
    });

    console.log("=" .repeat(80));

    return {
      success: true,
      totalFunctions: availableFunctions.length,
      functionsByType: groupedFunctions,
      allFunctions: availableFunctions,
    };

  } catch (error) {
    console.error("❌ Error listing Shopify Functions:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
