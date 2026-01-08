import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState } from "preact/hooks";

export default async () => {
  const existingDefinition = await getMetafieldDefinition();
  if (!existingDefinition) {
    // Create a metafield definition for persistence if no pre-existing definition exists
    const metafieldDefinition = await createMetafieldDefinition();

    if (!metafieldDefinition) {
      throw new Error("Failed to create metafield definition");
    }
  }

  const configuration = JSON.parse(
    shopify.data.validation?.metafields?.[0]?.value ?? "{}"
  );

  const companies = await getCompanies();
  const customers = await getCustomers();

  render(
    <Extension configuration={configuration} companies={companies} customers={customers} />,
    document.body
  );
};

function Extension({ configuration, companies, customers }) {
  const [creditLimits, setCreditLimits] = useState(configuration);
  const [errors, setErrors] = useState([]);
  const [activeTab, setActiveTab] = useState("companies");

  const applyMetafieldUpdate = async (limits) => {
    const result = await shopify.applyMetafieldChange({
      type: "updateMetafield",
      namespace: "$app:credit-limits",
      key: "credit-limits-values",
      value: JSON.stringify(limits),
    });

    if (result.type === "error") {
      setErrors([result.message]);
    }
  };

  const updateCompanyCreditLimit = async (companyId, field, value) => {
    setErrors([]);

    const newLimits = {
      ...creditLimits,
      companies: {
        ...creditLimits.companies,
        [companyId]: {
          ...creditLimits.companies?.[companyId],
          [field]: parseFloat(value) || 0,
        },
      },
    };

    setCreditLimits(newLimits);
    await applyMetafieldUpdate(newLimits);
  };

  const updateUserCreditLimit = async (customerId, field, value) => {
    setErrors([]);

    const newLimits = {
      ...creditLimits,
      users: {
        ...creditLimits.users,
        [customerId]: {
          ...creditLimits.users?.[customerId],
          [field]: parseFloat(value) || 0,
        },
      },
    };

    setCreditLimits(newLimits);
    await applyMetafieldUpdate(newLimits);
  };

  const getCompanyCredit = (companyId) => {
    return creditLimits.companies?.[companyId] || { creditLimit: 0, creditUsed: 0 };
  };

  const getUserCredit = (customerId) => {
    return creditLimits.users?.[customerId] || { creditLimit: 0, creditUsed: 0 };
  };

  const getRemainingCredit = (limit, used) => {
    return Math.max(0, (limit || 0) - (used || 0));
  };

  const getCreditStatus = (remaining, limit) => {
    if (!limit) return "neutral";
    const percentage = (remaining / limit) * 100;
    if (percentage > 50) return "success";
    if (percentage > 20) return "warning";
    return "critical";
  };

  return (
    <s-function-settings onSubmit={(event) => event.waitUntil(applyMetafieldUpdate(creditLimits))}>
      <ErrorBanner errors={errors} />

      <s-stack gap="large">
        <s-stack gap="base">
          <s-text variant="heading-md">Credit Management System</s-text>
          <s-text tone="neutral">
            Manage company-level credit pools and individual user credit limits.
            Both company and user credit are validated before allowing orders.
          </s-text>
        </s-stack>

        <s-tabs>
          <s-tab-list>
            <s-tab
              pressed={activeTab === "companies"}
              onPress={() => setActiveTab("companies")}
            >
              Company Credit Pools
            </s-tab>
            <s-tab
              pressed={activeTab === "users"}
              onPress={() => setActiveTab("users")}
            >
              User Credit Limits
            </s-tab>
          </s-tab-list>

          <s-tab-panels>
            {activeTab === "companies" && (
              <s-tab-panel>
                <CompanyCreditsTable
                  companies={companies}
                  creditLimits={creditLimits}
                  getCompanyCredit={getCompanyCredit}
                  getRemainingCredit={getRemainingCredit}
                  getCreditStatus={getCreditStatus}
                  updateCompanyCreditLimit={updateCompanyCreditLimit}
                />
              </s-tab-panel>
            )}

            {activeTab === "users" && (
              <s-tab-panel>
                <UserCreditsTable
                  customers={customers}
                  creditLimits={creditLimits}
                  getUserCredit={getUserCredit}
                  getRemainingCredit={getRemainingCredit}
                  getCreditStatus={getCreditStatus}
                  updateUserCreditLimit={updateUserCreditLimit}
                />
              </s-tab-panel>
            )}
          </s-tab-panels>
        </s-tabs>
      </s-stack>
    </s-function-settings>
  );
}

function CompanyCreditsTable({
  companies,
  creditLimits,
  getCompanyCredit,
  getRemainingCredit,
  getCreditStatus,
  updateCompanyCreditLimit
}) {
  if (!companies || companies.length === 0) {
    return <s-text>No companies found.</s-text>;
  }

  return (
    <s-stack gap="base">
      <s-text variant="heading-sm">Company Credit Pools</s-text>
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">Company</s-table-header>
          <s-table-header>Credit Limit</s-table-header>
          <s-table-header>Credit Used</s-table-header>
          <s-table-header>Remaining</s-table-header>
          <s-table-header>Status</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {companies.map((company) => {
            const credit = getCompanyCredit(company.id);
            const remaining = getRemainingCredit(credit.creditLimit, credit.creditUsed);
            const status = getCreditStatus(remaining, credit.creditLimit);

            return (
              <s-table-row key={company.id}>
                <s-table-cell>
                  <s-stack gap="none">
                    <s-text variant="body-md">{company.name}</s-text>
                    <s-text tone="neutral">{company.email}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <CurrencyField
                    value={credit.creditLimit}
                    placeholder="Set credit limit"
                    label={`Credit limit for ${company.name}`}
                    onChange={(value) =>
                      updateCompanyCreditLimit(company.id, "creditLimit", value)
                    }
                  />
                </s-table-cell>
                <s-table-cell>
                  <CurrencyField
                    value={credit.creditUsed}
                    placeholder="Used credit"
                    label={`Used credit for ${company.name}`}
                    onChange={(value) =>
                      updateCompanyCreditLimit(company.id, "creditUsed", value)
                    }
                  />
                </s-table-cell>
                <s-table-cell>
                  <s-text>${remaining.toFixed(2)}</s-text>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={status}>
                    {status === "success" && "Good"}
                    {status === "warning" && "Low"}
                    {status === "critical" && "Critical"}
                    {status === "neutral" && "No limit"}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

function UserCreditsTable({
  customers,
  creditLimits,
  getUserCredit,
  getRemainingCredit,
  getCreditStatus,
  updateUserCreditLimit
}) {
  if (!customers || customers.length === 0) {
    return <s-text>No customers found.</s-text>;
  }

  return (
    <s-stack gap="base">
      <s-text variant="heading-sm">Individual User Credit Limits</s-text>
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">User</s-table-header>
          <s-table-header>Company</s-table-header>
          <s-table-header>Credit Limit</s-table-header>
          <s-table-header>Credit Used</s-table-header>
          <s-table-header>Remaining</s-table-header>
          <s-table-header>Status</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {customers.map((customer) => {
            const credit = getUserCredit(customer.id);
            const remaining = getRemainingCredit(credit.creditLimit, credit.creditUsed);
            const status = getCreditStatus(remaining, credit.creditLimit);

            return (
              <s-table-row key={customer.id}>
                <s-table-cell>
                  <s-stack gap="none">
                    <s-text variant="body-md">{customer.displayName}</s-text>
                    <s-text tone="neutral">{customer.email}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-text>{customer.companyName || "N/A"}</s-text>
                </s-table-cell>
                <s-table-cell>
                  <CurrencyField
                    value={credit.creditLimit}
                    placeholder="Set credit limit"
                    label={`Credit limit for ${customer.displayName}`}
                    onChange={(value) =>
                      updateUserCreditLimit(customer.id, "creditLimit", value)
                    }
                  />
                </s-table-cell>
                <s-table-cell>
                  <CurrencyField
                    value={credit.creditUsed}
                    placeholder="Used credit"
                    label={`Used credit for ${customer.displayName}`}
                    onChange={(value) =>
                      updateUserCreditLimit(customer.id, "creditUsed", value)
                    }
                  />
                </s-table-cell>
                <s-table-cell>
                  <s-text>${remaining.toFixed(2)}</s-text>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={status}>
                    {status === "success" && "Good"}
                    {status === "warning" && "Low"}
                    {status === "critical" && "Critical"}
                    {status === "neutral" && "No limit"}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

function ErrorBanner({ errors }) {
  if (errors.length === 0) return null;
  return (
    <s-stack gap="base">
      {errors.map((error, i) => (
        <s-banner key={i} heading="Error" tone="critical">
          {error}
        </s-banner>
      ))}
    </s-stack>
  );
}

function CurrencyField({ value, onChange, placeholder, label }) {
  return (
    <s-number-field
      labelAccessibilityVisibility="exclusive"
      placeholder={placeholder}
      value={value || ""}
      label={label}
      min={0}
      step={0.01}
      prefix="$"
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

async function getMetafieldDefinition() {
  const query = `#graphql
    query GetMetafieldDefinition {
      metafieldDefinitions(first: 1, ownerType: VALIDATION, namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
        nodes {
          id
        }
      }
    }
  `;

  const result = await shopify.query(query);

  return result?.data?.metafieldDefinitions?.nodes[0];
}

const METAFIELD_NAMESPACE = "$app:credit-limits";
const METAFIELD_KEY = "credit-limits-values";

async function createMetafieldDefinition() {
  const definition = {
    access: {
      admin: "MERCHANT_READ_WRITE",
    },
    key: METAFIELD_KEY,
    name: "Credit Validation Configuration",
    namespace: METAFIELD_NAMESPACE,
    ownerType: "VALIDATION",
    type: "json",
  };

  const query = `#graphql
    mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition {
            id
          }
        }
      }
  `;

  const variables = { definition };
  const result = await shopify.query(query, { variables });

  return result?.data?.metafieldDefinitionCreate?.createdDefinition;
}

async function getCompanies() {
  const query = `#graphql
  query FetchCompanies {
    companies(first: 50) {
      nodes {
        id
        name
        email
        customerCount
        defaultCursor
        createdAt
        updatedAt
      }
    }
  }`;

  const result = await shopify.query(query);

  return result?.data?.companies.nodes.map((company) => ({
    id: company.id,
    name: company.name,
    email: company.email,
    customerCount: company.customerCount,
  }));
}

async function getCustomers() {
  const query = `#graphql
  query FetchCustomers {
    customers(first: 100) {
      nodes {
        id
        displayName
        firstName
        lastName
        email
        tags
        addresses {
          company
        }
        metafields(first: 10, namespace: "b2b") {
          nodes {
            key
            value
            namespace
          }
        }
      }
    }
  }`;

  const result = await shopify.query(query);

  return result?.data?.customers.nodes.map((customer) => {
    // Try to get company name from various sources
    const companyName = customer.addresses?.[0]?.company ||
                       customer.metafields?.nodes?.find(m => m.key === "company")?.value ||
                       "Unassigned";

    return {
      id: customer.id,
      displayName: customer.displayName || `${customer.firstName} ${customer.lastName}`.trim(),
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      companyName: companyName,
      tags: customer.tags,
    };
  });
}
