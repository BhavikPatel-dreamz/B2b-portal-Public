import { ActionFunctionArgs, LoaderFunctionArgs, json } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { syncCompanyCreditMetafields, autoSyncCreditMetafields } from "../services/metafieldSync.server";
import { getCompanyMetafield } from "../services/company.server";
import prisma from "../db.server";
import { useState } from "react";
import { Page, Card, Button, TextField, Text, BlockStack, InlineStack, Banner, DataTable } from "@shopify/polaris";

/**
 * Manual metafield sync and debugging route for cart checkout validation
 * This route can be used to:
 * 1. Manually sync company credit metafields
 * 2. Debug metafield issues
 * 3. Verify metafield data
 */

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  try {
    const companies = await prisma.companyAccount.findMany({
      select: {
        id: true,
        name: true,
        creditLimit: true,
        shopifyCompanyId: true,
      },
      take: 20, // Limit to 20 for performance
    });

    return json({
      companies: companies.map(c => ({
        id: c.id,
        name: c.name,
        creditLimit: c.creditLimit?.toString(),
        shopifyCompanyId: c.shopifyCompanyId,
      })),
    });
  } catch (error) {
    console.error("Failed to load companies:", error);
    return json({
      companies: [],
    });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "syncCompanyMetafields": {
      const companyId = formData.get("companyId") as string;

      if (!companyId) {
        return json({ success: false, error: "Company ID is required" });
      }

      try {
        const result = await syncCompanyCreditMetafields(admin, companyId);
        return json({
          success: true,
          message: "Company metafields synced successfully",
          result,
        });
      } catch (error) {
        console.error("Failed to sync company metafields:", error);
        return json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    case "autoSyncAllMetafields": {
      const companyId = formData.get("companyId") as string;

      if (!companyId) {
        return json({ success: false, error: "Company ID is required" });
      }

      try {
        const result = await autoSyncCreditMetafields(companyId);
        return json({
          success: true,
          message: "All credit metafields synced successfully",
          result,
        });
      } catch (error) {
        console.error("Failed to auto-sync metafields:", error);
        return json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    case "verifyCompanyMetafields": {
      const companyId = formData.get("companyId") as string;

      if (!companyId) {
        return json({ success: false, error: "Company ID is required" });
      }

      try {
        // Get company info
        const company = await prisma.companyAccount.findUnique({
          where: { id: companyId },
          select: {
            id: true,
            name: true,
            creditLimit: true,
            shopifyCompanyId: true,
          },
        });

        if (!company) {
          return json({ success: false, error: "Company not found" });
        }

        if (!company.shopifyCompanyId) {
          return json({
            success: false,
            error: "Company does not have a Shopify company ID",
            company: {
              id: company.id,
              name: company.name,
              creditLimit: company.creditLimit?.toString(),
              shopifyCompanyId: null,
            },
          });
        }

        // Try to fetch existing metafields from Shopify
        const creditLimitMetafield = await getCompanyMetafield(
          admin,
          company.shopifyCompanyId,
          "b2b_credit",
          "company_credit_limit"
        );

        const creditUsedMetafield = await getCompanyMetafield(
          admin,
          company.shopifyCompanyId,
          "b2b_credit",
          "company_credit_used"
        );

        return json({
          success: true,
          company: {
            id: company.id,
            name: company.name,
            creditLimit: company.creditLimit?.toString(),
            shopifyCompanyId: company.shopifyCompanyId,
          },
          metafields: {
            creditLimit: creditLimitMetafield,
            creditUsed: creditUsedMetafield,
          },
        });
      } catch (error) {
        console.error("Failed to verify company metafields:", error);
        return json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    case "getAllCompanies": {
      try {
        const companies = await prisma.companyAccount.findMany({
          select: {
            id: true,
            name: true,
            creditLimit: true,
            shopifyCompanyId: true,
          },
          take: 20, // Limit to 20 for performance
        });

        return json({
          success: true,
          companies: companies.map(c => ({
            id: c.id,
            name: c.name,
            creditLimit: c.creditLimit?.toString(),
            shopifyCompanyId: c.shopifyCompanyId,
          })),
        });
      } catch (error) {
        console.error("Failed to get companies:", error);
        return json({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    default:
      return json({ success: false, error: "Invalid intent" });
  }
}

export default function DebugMetafields() {
  const { companies } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

  const isLoading = fetcher.state === "submitting";

  const handleSync = (intent: string) => {
    if (!selectedCompanyId) {
      alert("Please select a company first");
      return;
    }

    const formData = new FormData();
    formData.append("intent", intent);
    formData.append("companyId", selectedCompanyId);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <Page title="Debug Metafields - Cart Checkout Validation">
      <BlockStack gap="500">
        {fetcher.data && (
          <Banner
            title={fetcher.data.success ? "Success" : "Error"}
            status={fetcher.data.success ? "success" : "critical"}
          >
            <Text as="p">
              {fetcher.data.message || fetcher.data.error || JSON.stringify(fetcher.data, null, 2)}
            </Text>
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              Company Selection
            </Text>

            <TextField
              label="Company"
              type="select"
              value={selectedCompanyId}
              onChange={(value) => setSelectedCompanyId(value)}
              options={[
                { label: "Select a company", value: "" },
                ...companies.map((company) => ({
                  label: `${company.name} (${company.creditLimit || '0'} credit limit)${!company.shopifyCompanyId ? ' - No Shopify ID' : ''}`,
                  value: company.id,
                })),
              ]}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              Metafield Operations
            </Text>

            <InlineStack gap="300">
              <Button
                primary
                loading={isLoading}
                onClick={() => handleSync("syncCompanyMetafields")}
                disabled={!selectedCompanyId}
              >
                Sync Company Metafields
              </Button>

              <Button
                loading={isLoading}
                onClick={() => handleSync("autoSyncAllMetafields")}
                disabled={!selectedCompanyId}
              >
                Auto Sync All Metafields
              </Button>

              <Button
                loading={isLoading}
                onClick={() => handleSync("verifyCompanyMetafields")}
                disabled={!selectedCompanyId}
              >
                Verify Metafields
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              Companies
            </Text>

            <DataTable
              columnContentTypes={["text", "text", "text", "text"]}
              headings={["Company Name", "Credit Limit", "Company ID", "Shopify Company ID"]}
              rows={companies.map((company) => [
                company.name,
                company.creditLimit || "0",
                company.id,
                company.shopifyCompanyId || "Not linked",
              ])}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              Cart Checkout Validation Setup
            </Text>

            <Text as="p">
              This debug tool helps you ensure that company credit metafields are properly synced
              to Shopify so that the cart checkout validation extension can access them.
            </Text>

            <Text as="p">
              <Text fontWeight="bold">Steps to fix cart validation:</Text>
            </Text>

            <ol style={{ paddingLeft: "20px" }}>
              <li>Select a company from the dropdown above</li>
              <li>Click "Verify Metafields" to check current status</li>
              <li>Click "Sync Company Metafields" to push credit data to Shopify</li>
              <li>Test cart checkout validation in your store</li>
            </ol>

            <Text as="p">
              <Text fontWeight="bold">Required metafields for validation:</Text>
            </Text>

            <ul style={{ paddingLeft: "20px" }}>
              <li>Namespace: "b2b_credit", Key: "company_credit_limit"</li>
              <li>Namespace: "b2b_credit", Key: "company_credit_used"</li>
            </ul>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
