import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

interface CartValidationFunction {
  id: string;
  handle: string;
  title: string;
  app: {
    apiKey: string;
    handle: string;
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

    const functionsResponse = await admin.graphql(functionsQuery);
    const functionsData = await functionsResponse.json();

    if (functionsData.errors) {
      throw new Error(`Failed to query functions: ${functionsData.errors[0]?.message}`);
    }

    // Find our cart validation function by handle
    const cartValidationFunction = functionsData.data?.shopifyFunctions?.edges?.find(
      (edge: { node: CartValidationFunction }) =>
        edge.node.handle === "cart-checkout-validation"
    )?.node;

    if (!cartValidationFunction) {
      console.log("ℹ️ Cart validation function not found - may not be deployed yet");
      return { success: false, message: "Cart validation function not found" };
    }

    console.log(`📋 Found cart validation function: ${cartValidationFunction.title} (handle: ${cartValidationFunction.handle}, id: ${cartValidationFunction.id})`);
    console.log(`📱 App details: ${cartValidationFunction.app.title} (${cartValidationFunction.app.handle})`);

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
          functionHandle: "cart-checkout-validation",
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
      message: "Cart validation registered successfully using function handle",
      validationId: validation.id,
      functionHandle: cartValidationFunction.handle,
      functionId: cartValidationFunction.id,
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

    // Exact query from user's example
    const myQuery = `
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

    const functionsResponse = await admin.graphql(myQuery);
    const functionsData = await functionsResponse.json();

    if (functionsData.errors) {
      throw new Error(`Failed to query functions: ${functionsData.errors[0]?.message}`);
    }

    console.log("📋 Function query response:", JSON.stringify(functionsData, null, 2));

    // Find cart-checkout-validation function
    const targetFunction = functionsData.data?.shopifyFunctions?.edges?.find(
      (edge: { node: CartValidationFunction }) =>
        edge.node.handle === "cart-checkout-validation"
    )?.node;

    if (!targetFunction) {
      return { success: false, message: "cart-checkout-validation function not found" };
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

    // Exact input from user's example
    const mutationInput = {
      validation: {
        functionHandle: "cart-checkout-validation",
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
