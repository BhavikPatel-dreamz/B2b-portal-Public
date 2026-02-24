import { ActionFunction, LoaderFunction, json } from "@remix-run/node";
import { useLoaderData, useActionData, Form } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import {
  registerCartValidationFunction,
  unregisterCartValidationFunction
} from "~/services/cartValidationRegistration.server";

export const loader: LoaderFunction = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    // Get current cart validations
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

    const response = await admin.graphql(validationsQuery);
    const data = await response.json();

    // Get available functions
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

    return json({
      cartValidations: data.data?.cartValidations?.nodes || [],
      shopifyFunctions: functionsData.data?.shopifyFunctions?.nodes || [],
    });
  } catch (error) {
    return json({ error: "Failed to load data" }, { status: 500 });
  }
};

export const action: ActionFunction = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const action = formData.get("action");

    if (action === "register") {
      const result = await registerCartValidationFunction(admin);
      return json({ action: "register", ...result });
    }

    if (action === "unregister") {
      const validationId = formData.get("validationId") as string;
      if (!validationId) {
        return json({
          action: "unregister",
          success: false,
          error: "Validation ID required"
        });
      }

      const result = await unregisterCartValidationFunction(admin, validationId);
      return json({ action: "unregister", ...result });
    }

    return json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
};

export default function ManageCartValidation() {
  const { cartValidations, shopifyFunctions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const cartValidationFunctions = shopifyFunctions.filter(
    (fn: any) => fn.apiType === "cart_validation"
  );

  return (
    <div style={{ padding: "20px", maxWidth: "800px" }}>
      <h1>Cart Validation Management</h1>

      {actionData?.error && (
        <div style={{
          padding: "10px",
          backgroundColor: "#fee",
          border: "1px solid #fcc",
          borderRadius: "4px",
          marginBottom: "20px"
        }}>
          <strong>Error:</strong> {actionData.error}
        </div>
      )}

      {actionData?.success && (
        <div style={{
          padding: "10px",
          backgroundColor: "#efe",
          border: "1px solid #cfc",
          borderRadius: "4px",
          marginBottom: "20px"
        }}>
          <strong>Success:</strong> {actionData.message}
          {actionData.validationId && <div>Validation ID: {actionData.validationId}</div>}
        </div>
      )}

      <div style={{ display: "grid", gap: "30px" }}>
        {/* Current Registrations */}
        <section>
          <h2>Current Cart Validations</h2>
          {cartValidations.length === 0 ? (
            <p style={{ color: "#666" }}>No cart validations currently registered.</p>
          ) : (
            <div style={{ display: "grid", gap: "10px" }}>
              {cartValidations.map((validation: any) => (
                <div
                  key={validation.id}
                  style={{
                    border: "1px solid #ddd",
                    padding: "15px",
                    borderRadius: "4px",
                    backgroundColor: "#f9f9f9"
                  }}
                >
                  <div><strong>ID:</strong> {validation.id}</div>
                  <div><strong>Function ID:</strong> {validation.functionId}</div>

                  <Form method="post" style={{ marginTop: "10px" }}>
                    <input type="hidden" name="action" value="unregister" />
                    <input type="hidden" name="validationId" value={validation.id} />
                    <button
                      type="submit"
                      style={{
                        padding: "5px 15px",
                        backgroundColor: "#dc3545",
                        color: "white",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer"
                      }}
                    >
                      Unregister
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Available Functions */}
        <section>
          <h2>Available Cart Validation Functions</h2>
          {cartValidationFunctions.length === 0 ? (
            <p style={{ color: "#666" }}>
              No cart validation functions found. Make sure your function is deployed with:
              <br />
              <code>shopify app deploy</code>
            </p>
          ) : (
            <div style={{ display: "grid", gap: "10px" }}>
              {cartValidationFunctions.map((fn: any) => (
                <div
                  key={fn.id}
                  style={{
                    border: "1px solid #ddd",
                    padding: "15px",
                    borderRadius: "4px"
                  }}
                >
                  <div><strong>Title:</strong> {fn.title}</div>
                  <div><strong>ID:</strong> {fn.id}</div>
                  <div><strong>Type:</strong> {fn.apiType}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Register Button */}
        <section>
          <h2>Register Cart Validation</h2>
          <Form method="post">
            <input type="hidden" name="action" value="register" />
            <button
              type="submit"
              style={{
                padding: "10px 20px",
                backgroundColor: "#007bff",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "16px"
              }}
            >
              Register Cart Validation Function
            </button>
          </Form>
          <p style={{ marginTop: "10px", color: "#666", fontSize: "14px" }}>
            This will automatically find and register your cart validation function.
            If you don't see your function above, deploy it first with <code>shopify app deploy</code>.
          </p>
        </section>

        {/* Instructions */}
        <section style={{ backgroundColor: "#f8f9fa", padding: "20px", borderRadius: "4px" }}>
          <h3>How It Works</h3>
          <ol>
            <li><strong>Deploy your function:</strong> <code>shopify app deploy</code></li>
            <li><strong>Auto-registration:</strong> The function is registered automatically when the app is installed (see afterAuth hook in shopify.server.ts)</li>
            <li><strong>Manual control:</strong> Use this page to register/unregister manually if needed</li>
            <li><strong>Validation active:</strong> Once registered, your cart validation will run on checkout</li>
          </ol>

          <h3>Troubleshooting</h3>
          <ul>
            <li>Function not showing? Make sure it's deployed and the handle matches in shopify.extension.toml</li>
            <li>Registration failing? Check the console logs for detailed error messages</li>
            <li>Validation not working? Test with draft orders or Storefront API carts</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
