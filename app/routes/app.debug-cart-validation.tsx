import { useState } from "react";
import { Card, Page, Layout, Button, TextField, Checkbox, Banner, Text, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import type { LoaderFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";

interface DebugResponse {
  success: boolean;
  message?: string;
  error?: string;
  functions?: any[];
  validations?: any[];
  result?: any;
}

export const loader: LoaderFunction = async ({ request }) => {
  await authenticate.admin(request);
  return json({});
};

export default function DebugCartValidation() {
  const fetcher = useFetcher<DebugResponse>();
  const [title, setTitle] = useState("B2B Portal Cart Validation");
  const [useExactQuery, setUseExactQuery] = useState(false);

  const handleAction = (action: string) => {
    const formData = new FormData();
    formData.append("action", action);
    formData.append("title", title);
    formData.append("useExactQuery", useExactQuery.toString());

    fetcher.submit(formData, {
      method: "POST",
      action: "/api/debug-cart-validation"
    });
  };

  const isLoading = fetcher.state === "submitting";
  const response = fetcher.data;

  return (
    <Page
      title="Cart Validation Debug"
      subtitle="Test and manage cart validation function registration"
    >
      <Layout>
        <Layout.Section oneHalf>
          <Card title="Configuration" sectioned>
            <div style={{ marginBottom: "1rem" }}>
              <TextField
                label="Validation Title"
                value={title}
                onChange={setTitle}
                placeholder="Enter custom title for validation"
                helpText="This will be the title shown in Shopify admin"
              />
            </div>
            <Checkbox
              label="Use Exact Query Method"
              checked={useExactQuery}
              onChange={setUseExactQuery}
              helpText="Use the exact GraphQL queries from your example"
            />
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card title="Quick Actions" sectioned>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <Button
                primary
                loading={isLoading}
                onClick={() => handleAction("full_workflow")}
              >
                🚀 Run Complete Setup Workflow
              </Button>

              <Button
                loading={isLoading}
                onClick={() => handleAction(useExactQuery ? "register_exact" : "register_original")}
              >
                {useExactQuery ? "📋 Register (Exact Query)" : "⚙️ Register (Original)"}
              </Button>
            </div>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card title="Individual Actions" sectioned>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <Button
                loading={isLoading}
                onClick={() => handleAction("list_functions")}
              >
                📋 List All Functions
              </Button>

              <Button
                loading={isLoading}
                onClick={() => handleAction("debug_all_functions")}
              >
                🔍 Debug Function Discovery
              </Button>

              <Button
                loading={isLoading}
                onClick={() => handleAction("list_validations")}
              >
                📋 List All Validations
              </Button>

              <Button
                loading={isLoading}
                onClick={() => handleAction("register_original")}
              >
                ⚙️ Test Original Method
              </Button>

              <Button
                loading={isLoading}
                onClick={() => handleAction("register_exact")}
              >
                📋 Test Exact Query Method
              </Button>

              <Button
                destructive
                loading={isLoading}
                onClick={() => handleAction("cleanup")}
              >
                🧹 Cleanup Cart Validations
              </Button>
            </div>
          </Card>
        </Layout.Section>

        {response && (
          <Layout.Section>
            <Card sectioned>
              <div style={{ marginBottom: "1rem" }}>
                <Banner
                  status={response.success ? "success" : "critical"}
                  title={response.success ? "Success" : "Error"}
                >
                  {response.message || response.error}
                </Banner>
              </div>

              {response.functions && response.functions.length > 0 && (
                <div style={{ marginBottom: "1rem" }}>
                  <Text variant="headingMd" as="h3">Shopify Functions:</Text>
                  <List>
                    {response.functions.map((fn: any, index: number) => (
                      <List.Item key={index}>
                        {fn.title} (apiType: {fn.apiType}) - {fn.app.title}
                      </List.Item>
                    ))}
                  </List>
                </div>
              )}

              {response.validations && response.validations.length > 0 && (
                <div style={{ marginBottom: "1rem" }}>
                  <Text variant="headingMd" as="h3">Current Validations:</Text>
                  <List>
                    {response.validations.map((validation: any, index: number) => (
                      <List.Item key={index}>
                        {validation.title} - {validation.enabled ? "Enabled" : "Disabled"}
                        {validation.blockOnFailure ? " (Blocking)" : " (Non-blocking)"}
                      </List.Item>
                    ))}
                  </List>
                </div>
              )}

              {response.result && (
                <div>
                  <Text variant="headingMd" as="h3">Result Details:</Text>
                  <pre style={{
                    background: "#f6f6f7",
                    padding: "1rem",
                    borderRadius: "4px",
                    overflow: "auto",
                    fontSize: "12px"
                  }}>
                    {JSON.stringify(response.result, null, 2)}
                  </pre>
                </div>
              )}
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
