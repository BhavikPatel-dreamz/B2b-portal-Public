import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

interface CartValidationFunction {
  id: string;
  title: string;
  apiType: string;
}

interface CartValidation {
  id: string;
  functionId: string;
}

/**
 * Register Cart Validation function during app installation
 */
export async function registerCartValidationFunction(admin: AdminApiContext) {
  try {
    console.log("🔄 Checking Cart Validation function registration...");

    // Step 1: Find our cart validation function
    const functionsQuery = `
      query {
        shopifyFunctions(first: 25) {
          nodes {
            id
            title
            apiType
          }
        }
      }
    `;

    const functionsResponse = await admin.graphql(functionsQuery);
    const functionsData = await functionsResponse.json();

    if (functionsData.errors) {
      throw new Error(`Failed to query functions: ${functionsData.errors[0]?.message}`);
    }

    // Find our cart validation function
    const cartValidationFunction = functionsData.data?.shopifyFunctions?.nodes?.find(
      (fn: CartValidationFunction) => 
        fn.apiType === "cart_validation" && 
        (fn.title === "cart-checkout-validation" || fn.title.includes("cart-checkout-validation"))
    );

    if (!cartValidationFunction) {
      console.log("ℹ️ Cart validation function not found - may not be deployed yet");
      return { success: false, message: "Cart validation function not found" };
    }

    console.log(`📋 Found cart validation function: ${cartValidationFunction.title} (${cartValidationFunction.id})`);

    // Step 2: Check if already registered
    const validationsQuery = `
      query {
        cartValidations(first: 10) {
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

    const existingValidation = validationsData.data?.cartValidations?.nodes?.find(
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

    // Step 3: Register the cart validation
    const registerMutation = `
      mutation cartValidationCreate($input: CartValidationInput!) {
        cartValidationCreate(input: $input) {
          cartValidation {
            id
            functionId
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const registerResponse = await admin.graphql(registerMutation, {
      variables: {
        input: {
          functionId: cartValidationFunction.id,
        },
      },
    });

    const registerData = await registerResponse.json();

    if (registerData.errors || registerData.data?.cartValidationCreate?.userErrors?.length > 0) {
      const error = registerData.errors?.[0]?.message || 
        registerData.data?.cartValidationCreate?.userErrors?.[0]?.message;
      throw new Error(`Failed to register cart validation: ${error}`);
    }

    const validation = registerData.data?.cartValidationCreate?.cartValidation;
    console.log(`🎉 Cart validation registered successfully: ${validation.id}`);

    return {
      success: true,
      message: "Cart validation registered successfully",
      validationId: validation.id,
      functionId: validation.functionId,
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
      mutation cartValidationDelete($id: ID!) {
        cartValidationDelete(id: $id) {
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

    if (deleteData.errors || deleteData.data?.cartValidationDelete?.userErrors?.length > 0) {
      const error = deleteData.errors?.[0]?.message || 
        deleteData.data?.cartValidationDelete?.userErrors?.[0]?.message;
      throw new Error(`Failed to unregister cart validation: ${error}`);
    }

    console.log(`🗑️ Cart validation unregistered: ${deleteData.data?.cartValidationDelete?.deletedId}`);
    return { success: true, deletedId: deleteData.data?.cartValidationDelete?.deletedId };

  } catch (error) {
    console.error("❌ Error unregistering cart validation function:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}