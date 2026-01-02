import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";

export const loader = async ({ request }: ActionFunctionArgs) => {

    try {
        // Authenticate the proxy request
        await authenticate.public.appProxy(request);

        const url = new URL(request.url);
        const companyId = url.searchParams.get('companyId');
        const shop = url.searchParams.get('shop');

        if (!companyId || !shop) {
            return Response.json({ error: 'Company ID and shop required' }, { status: 400 });
        }

        // Get the store to get the access token
        const store = await getStoreByDomain(shop);
        if (!store || !store.accessToken) {
            return Response.json({ error: 'Store not found or unauthorized' }, { status: 404 });
        }

        // GraphQL query to fetch company customers
        const query = `
            query getCompanyCustomers($companyId: ID!, $first: Int) {
                company(id: $companyId) {
                    id
                    name
                    contacts(first: $first) {
                        edges {
                            node {
                                id
                                customer {
                                    id
                                    firstName
                                    lastName
                                    email
                                    phone
                                }
                            }
                        }
                    }
                }
            }
        `;

        const response = await fetch(`https://${shop}/admin/api/2023-07/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': store.accessToken,
            },
            body: JSON.stringify({
                query,
                variables: {
                    companyId: companyId.startsWith('gid://') ? companyId : `gid://shopify/Company/${companyId}`,
                    first: 100, // Fetch up to 100 customers
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`GraphQL API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL errors:', result.errors);
            return Response.json({ error: 'Failed to fetch company customers' }, { status: 500 });
        }

        const company = result.data?.company;
        if (!company) {
            return Response.json({ error: 'Company not found' }, { status: 404 });
        }

        // Transform the customer data
        const customers = company.contacts.edges.map((edge: { node: { id: string; customer: { id: string; firstName: string; lastName: string; email: string; phone: string } } }) => ({
            id: edge.node.customer.id.replace('gid://shopify/Customer/', ''),
            firstName: edge.node.customer.firstName,
            lastName: edge.node.customer.lastName,
            email: edge.node.customer.email,
            phone: edge.node.customer.phone,
        }));

        return Response.json({
            customers,
            companyName: company.name,
        });

    } catch (error) {
        console.error('Proxy error:', error);
        return Response.json({
            error: error instanceof Error ? error.message : 'Unknown error',
        }, { status: 500 });
    }
};
