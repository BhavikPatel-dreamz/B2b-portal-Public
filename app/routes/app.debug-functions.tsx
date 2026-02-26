import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Card,
  Button,
  BlockStack,
  Text,
  Badge,
  DataTable,
  Banner,
  CalloutCard,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { registerCartValidationFunction, unregisterCartValidationFunction } from "~/services/cartValidationRegistration.server";

interface ShopifyFunction {
  id: string;
  title: string;
  apiType: string;
  app?: {
    id: string;
    title: string;
    handle: string;
    apiKey: string;
  };
}

interface Validation {
  id: string;
  functionId: string;
  enabled?: boolean;
  blockOnFailure?: boolean;
}

interface LoaderData {
  functions: ShopifyFunction[];
  validations: Validation[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  try {
    // Query all Shopify Functions
    const functionsQuery = `
      query {
        shopifyFunctions(first: 250) {
          edges {
            node {
              id
              title
              apiType
              app {
                id
                title
                handle
                apiKey
              }
            }
          }
        }
      }
    `;

    // Query all validations
    const validationsQuery = `
      query {
        validations(first: 50) {
          nodes {
            id
            functionId
          }
        }
      }
    `;

    const [functionsResponse, validationsResponse] = await Promise.all([
      admin.graphql(functionsQuery),
      admin.graphql(validationsQuery),
    ]);

    const functionsData = await functionsResponse.json();
    const validationsData = await validationsResponse.json();

    const functions = functionsData.data?.shopifyFunctions?.edges?.map((edge: any) => edge.node) || [];
    const validations = validationsData.data?.validations?.nodes || [];

    return json<LoaderData>({
      functions,
      validations,
    });
  } catch (error) {
    console.error("Error fetching functions and validations:", error);
    return json<LoaderData>({
      functions: [],
      validations: [],
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");

  try {
    switch (action) {
      case "register":
        const result = await registerCartValidationFunction(admin);
        return json({
          success: result.success,
          message: result.message || result.error,
          data: result,
        });

      case "unregister":
        const validationId = formData.get("validationId") as string;
        if (!validationId) {
          return json({
            success: false,
            message: "Validation ID is required",
          });
        }
        const unregisterResult = await unregisterCartValidationFunction(admin, validationId);
        return json({
          success: unregisterResult.success,
          message: unregisterResult.success ? "Validation unregistered successfully" : unregisterResult.error,
        });

      default:
        return json({
          success: false,
          message: "Invalid action",
        });
    }
  } catch (error) {
    console.error("Action error:", error);
    return json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export default function DebugFunctions() {
  const { functions, validations } = useLoaderData<LoaderData>();
  const actionData = useActionData<any>();
  const submit = useSubmit();

  // Filter cart validation functions
  const cartValidationFunctions = functions.filter(
    (fn) => fn.apiType === "cart_validation"
  );

  // Create data for functions table
  const functionRows = functions.map((fn) => {
    const isRegistered = validations.some((v) => v.functionId === fn.id);
    return [
      fn.title,
      fn.apiType,
      fn.id,
      fn.app?.title || "Unknown",
      isRegistered ? <Badge status="success">Registered</Badge> : <Badge>Not Registered</Badge>,
    ];
  });

  // Create data for validations table
  const validationRows = validations.map((validation) => {
    const func = functions.find((f) => f.id === validation.functionId);
    return [
      func?.title || "Unknown Function",
      validation.id,
      validation.functionId,
      <Form method="post" key={validation.id} style={{ display: "inline" }}>
        <input type="hidden" name="action" value="unregister" />
        <input type="hidden" name="validationId" value={validation.id} />
        <Button
          variant="primary"
          tone="critical"
          size="micro"
          onClick={() => submit(new FormData(document.forms[0] as HTMLFormElement))}
        >
          Unregister
        </Button>
      </Form>,
    ];
  });

  return (
    <Page title="Debug Shopify Functions">
      <BlockStack gap="500">
        {actionData && (
          <Banner
            status={actionData.success ? "success" : "critical"}
            title={actionData.success ? "Success" : "Error"}
          >
            <p>{actionData.message}</p>
          </Banner>
        )}

        <CalloutCard
          title="Cart Validation Registration"
          illustration="https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-image.svg"
          primaryAction={{
            content: "Register Cart Validation",
            onAction: () => {
              const form = new FormData();
              form.append("action", "register");
              submit(form, { method: "post" });
            },
          }}
        >
          <p>
            Click to automatically register your cart validation function. 
            This should be done after app installation.
          </p>
        </CalloutCard>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">All Shopify Functions</Text>
            <Text variant="bodyMd" tone="subdued">
              Found {functions.length} total functions, {cartValidationFunctions.length} cart validation functions
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text"]}
              headings={["Function Title", "API Type", "Function ID", "App", "Status"]}
              rows={functionRows}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Active Validations</Text>
            <Text variant="bodyMd" tone="subdued">
              Found {validations.length} registered validations
            </Text>
            {validations.length > 0 ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["Function Title", "Validation ID", "Function ID", "Actions"]}
                rows={validationRows}
              />
            ) : (
              <Banner status="info" title="No validations registered">
                <p>No cart validations are currently registered. Use the registration button above.</p>
              </Banner>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">GraphQL Queries for Testing</Text>
            <div style={{ fontFamily: "monospace", backgroundColor: "#f4f4f4", padding: "12px", borderRadius: "4px" }}>
              <Text variant="bodyMd">
                <strong>List Functions:</strong>
                <br />
                {`query MyQuery {
  shopifyFunctions(first: 250) {
    edges {
      node {
        id
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
}`}
              </Text>
            </div>
            <div style={{ fontFamily: "monospace", backgroundColor: "#f4f4f4", padding: "12px", borderRadius: "4px" }}>
              <Text variant="bodyMd">
                <strong>Create Validation:</strong>
                <br />
                {`mutation validationCreate($validation: ValidationCreateInput!) {
  validationCreate(validation: $validation) {
    userErrors {
      field
      message
    }
    validation {
      id
    }
  }
}`}
              </Text>
            </div>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}