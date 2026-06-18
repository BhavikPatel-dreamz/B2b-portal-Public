import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function verifyB2BPricing() {
  // 1. Fetch shop credentials and B2B company from local database
  const company = await prisma.companyAccount.findFirst({
    where: {
      shop: {
        shopDomain: "findash-shipping-15.myshopify.com",
      },
    },
    include: {
      shop: true,
    },
  });

  if (!company || !company.shop) {
    console.error("❌ No company or shop credentials found in database.");
    return;
  }

  const shopDomain = company.shop.shopDomain;
  const token = company.shop.accessToken;

  console.log(`\n================ B2B PRICING RESOLUTION TEST ================`);
  console.log(`Step 1: Selected Company: ${company.name}`);
  console.log(`        Shopify Company ID: ${company.shopifyCompanyId}`);
  console.log(`        Shop: ${shopDomain}`);

  // 2. Fetch B2B contacts & location assignments from Shopify
  const contactsQuery = `
    query GetCompanyContacts($companyId: ID!) {
      company(id: $companyId) {
        contacts(first: 10) {
          edges {
            node {
              id
              customer {
                id
                email
                firstName
                lastName
              }
              roleAssignments(first: 5) {
                edges {
                  node {
                    role {
                      name
                    }
                    companyLocation {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const contactsRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token || "",
      },
      body: JSON.stringify({ query: contactsQuery, variables: { companyId: company.shopifyCompanyId } }),
    });

    const contactsData = await contactsRes.json();
    if (contactsData.errors) {
      console.error("\n❌ GraphQL Error while fetching contacts:", JSON.stringify(contactsData.errors, null, 2));
      console.log("\n💡 TIP: Please open the B2B Portal App in your Shopify Admin to refresh the stale database access token.");
      return;
    }

    const contacts = contactsData.data?.company?.contacts?.edges || [];
    if (contacts.length === 0) {
      console.log("❌ No customer contacts assigned to this company on Shopify.");
      return;
    }

    // Grab the first customer contact
    const firstContact = contacts[0].node;
    console.log(`\nStep 2: Selected Customer: ${firstContact.customer.firstName} ${firstContact.customer.lastName} (${firstContact.customer.email})`);
    
    // Resolve their assigned company location
    const locationAssignment = firstContact.roleAssignments?.edges?.[0]?.node;
    if (!locationAssignment) {
      console.log("❌ This customer has no company location assignments.");
      return;
    }

    const locationId = locationAssignment.companyLocation.id;
    console.log(`\nStep 3: Resolved Company Location (Assigned Catalog Context):`);
    console.log(`        Location Name: ${locationAssignment.companyLocation.name}`);
    console.log(`        Location ID: ${locationId}`);

    // 3. Fetch product contextual prices for this location context
    const productsQuery = `
      query GetContextualPrices($locationId: ID!) {
        products(first: 3) {
          edges {
            node {
              title
              variants(first: 5) {
                nodes {
                  title
                  sku
                  contextualPricing(context: { companyLocationId: $locationId }) {
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const productsRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token || "",
      },
      body: JSON.stringify({ query: productsQuery, variables: { locationId } }),
    });

    const productsData = await productsRes.json();
    const products = productsData.data?.products?.edges || [];

    console.log(`\nStep 4: Resolved B2B Prices (Shopify Contextual pricing API):`);
    for (const edge of products) {
      const prod = edge.node;
      console.log(`\nProduct: ${prod.title}`);
      for (const variant of prod.variants.nodes) {
        const b2bPrice = variant.contextualPricing?.price;
        if (b2bPrice) {
          console.log(`  - Variant: ${variant.title} | SKU: ${variant.sku || 'N/A'} | B2B Price: ${b2bPrice.amount} ${b2bPrice.currencyCode}`);
        } else {
          console.log(`  - Variant: ${variant.title} | SKU: ${variant.sku || 'N/A'} | B2B Price: RESTRICTED (Hidden from catalog)`);
        }
      }
    }
    console.log(`\n============================================================`);

  } catch (error) {
    console.error("❌ Network or Execution Error:", error);
  }
}

verifyB2BPricing().catch(console.error).finally(() => prisma.$disconnect());
