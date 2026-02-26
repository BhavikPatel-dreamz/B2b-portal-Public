import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
} from "@remix-run/react";
import {
  Page,
  Card,
  Button,
  BlockStack,
  Text,
  Banner,
  TextField,
  Select,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "~/shopify.server";

// Import your cart validation logic for testing
import { cartValidationsGenerateRun } from "../../extensions/cart-checkout-validation/src/cart_validations_generate_run.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  
  try {
    const testData = JSON.parse(formData.get("testData") as string);
    
    // Run the cart validation function locally
    const result = cartValidationsGenerateRun(testData);
    
    return json({
      success: true,
      result,
      testData,
    });
  } catch (error) {
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export default function TestCartValidation() {
  const actionData = useActionData<any>();
  const [testScenario, setTestScenario] = useState("valid_b2c");
  const [customData, setCustomData] = useState("");

  const testScenarios = {
    valid_b2c: {
      cart: {
        lines: [
          {
            quantity: 2,
            merchandise: {
              id: "gid://shopify/ProductVariant/123",
              title: "Test Product Variant"
            }
          }
        ],
        cost: {
          totalAmount: {
            amount: "100.00",
            currencyCode: "USD"
          }
        },
        buyerIdentity: {
          email: "customer@example.com",
          customer: {
            id: "gid://shopify/Customer/123",
            email: "customer@example.com"
          }
        }
      }
    },
    
    valid_b2b_with_credit: {
      cart: {
        lines: [
          {
            quantity: 1,
            merchandise: {
              id: "gid://shopify/ProductVariant/456",
              title: "B2B Product"
            }
          }
        ],
        cost: {
          totalAmount: {
            amount: "150.00",
            currencyCode: "USD"
          }
        },
        buyerIdentity: {
          email: "b2bcustomer@company.com",
          customer: {
            id: "gid://shopify/Customer/456",
            email: "b2bcustomer@company.com",
            metafield: {
              value: "comp_123"
            },
            b2bCompanyId: {
              value: "comp_123"
            }
          },
          purchasingCompany: {
            company: {
              id: "gid://shopify/Company/789",
              name: "Test Company Ltd",
              creditLimit: {
                value: "1000.00"
              },
              creditUsed: {
                value: "200.00"
              }
            }
          }
        }
      }
    },
    
    insufficient_credit: {
      cart: {
        lines: [
          {
            quantity: 5,
            merchandise: {
              id: "gid://shopify/ProductVariant/789",
              title: "Expensive Product"
            }
          }
        ],
        cost: {
          totalAmount: {
            amount: "1500.00",
            currencyCode: "USD"
          }
        },
        buyerIdentity: {
          email: "b2bcustomer@company.com",
          customer: {
            id: "gid://shopify/Customer/456",
            email: "b2bcustomer@company.com",
            metafield: {
              value: "comp_123"
            },
            b2bCompanyId: {
              value: "comp_123"
            }
          },
          purchasingCompany: {
            company: {
              id: "gid://shopify/Company/789",
              name: "Test Company Ltd",
              creditLimit: {
                value: "1000.00"
              },
              creditUsed: {
                value: "200.00"
              }
            }
          }
        }
      }
    },
    
    credit_limit_reached: {
      cart: {
        lines: [
          {
            quantity: 1,
            merchandise: {
              id: "gid://shopify/ProductVariant/999",
              title: "Any Product"
            }
          }
        ],
        cost: {
          totalAmount: {
            amount: "50.00",
            currencyCode: "USD"
          }
        },
        buyerIdentity: {
          email: "maxedout@company.com",
          customer: {
            id: "gid://shopify/Customer/789",
            email: "maxedout@company.com",
            metafield: {
              value: "comp_456"
            },
            b2bCompanyId: {
              value: "comp_456"
            }
          },
          purchasingCompany: {
            company: {
              id: "gid://shopify/Company/456",
              name: "Maxed Out Company",
              creditLimit: {
                value: "1000.00"
              },
              creditUsed: {
                value: "1000.00"
              }
            }
          }
        }
      }
    }
  };

  const scenarioOptions = [
    { label: "Valid B2C Customer", value: "valid_b2c" },
    { label: "Valid B2B with Sufficient Credit", value: "valid_b2b_with_credit" },
    { label: "B2B with Insufficient Credit", value: "insufficient_credit" },
    { label: "B2B Credit Limit Reached", value: "credit_limit_reached" },
    { label: "Custom Test Data", value: "custom" },
  ];

  const getTestData = () => {
    if (testScenario === "custom") {
      try {
        return JSON.parse(customData);
      } catch {
        return {};
      }
    }
    return testScenarios[testScenario as keyof typeof testScenarios];
  };

  return (
    <Page title="Test Cart Validation Function">
      <BlockStack gap="500">
        {actionData && (
          <Banner
            status={actionData.success ? "success" : "critical"}
            title={actionData.success ? "Test Completed" : "Test Failed"}
          >
            <p>{actionData.success ? "Validation function executed successfully" : actionData.error}</p>
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd">Test Cart Validation Logic</Text>
            
            <Select
              label="Test Scenario"
              options={scenarioOptions}
              value={testScenario}
              onChange={setTestScenario}
            />

            {testScenario === "custom" && (
              <TextField
                label="Custom Test Data (JSON)"
                value={customData}
                onChange={setCustomData}
                multiline={10}
                autoComplete="off"
                placeholder="Enter your custom cart validation input JSON here..."
              />
            )}

            <Card sectioned>
              <Text variant="headingSm">Test Data Preview:</Text>
              <div style={{ 
                fontFamily: "monospace", 
                backgroundColor: "#f4f4f4", 
                padding: "12px", 
                borderRadius: "4px",
                fontSize: "12px",
                overflow: "auto",
                maxHeight: "300px"
              }}>
                <pre>{JSON.stringify(getTestData(), null, 2)}</pre>
              </div>
            </Card>

            <Form method="post">
              <input
                type="hidden"
                name="testData"
                value={JSON.stringify(getTestData())}
              />
              <Button submit variant="primary">
                Run Validation Test
              </Button>
            </Form>
          </BlockStack>
        </Card>

        {actionData?.success && (
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Validation Result</Text>
              
              <div style={{ 
                fontFamily: "monospace", 
                backgroundColor: "#f9f9f9", 
                padding: "12px", 
                borderRadius: "4px" 
              }}>
                <Text variant="headingSm">Operations:</Text>
                <pre>{JSON.stringify(actionData.result.operations, null, 2)}</pre>
              </div>

              {actionData.result.operations?.[0]?.validationAdd?.errors?.length > 0 ? (
                <Banner status="critical" title="Validation Errors Found">
                  <ul>
                    {actionData.result.operations[0].validationAdd.errors.map((error: any, index: number) => (
                      <li key={index}>{error.message}</li>
                    ))}
                  </ul>
                </Banner>
              ) : (
                <Banner status="success" title="No Validation Errors">
                  <p>The cart passed all validation checks.</p>
                </Banner>
              )}
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">How to Use</Text>
            <ol style={{ paddingLeft: "20px" }}>
              <li>Select a test scenario or provide custom JSON data</li>
              <li>Click "Run Validation Test" to execute the cart validation function locally</li>
              <li>Review the results to ensure your validation logic works as expected</li>
              <li>If errors occur, check your metafield namespaces and function logic</li>
            </ol>
            
            <Text variant="headingSm">Expected Namespace Structure:</Text>
            <ul style={{ paddingLeft: "20px", fontFamily: "monospace", fontSize: "12px" }}>
              <li>Namespace: <code>b2b_credit</code></li>
              <li>Company credit limit key: <code>company_credit_limit</code></li>
              <li>Company credit used key: <code>company_credit_used</code></li>
              <li>Customer company ID key: <code>company_id</code></li>
            </ul>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}