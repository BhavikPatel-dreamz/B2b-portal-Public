import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { requireSalesSession } from "../../utils/sales-session.server";
import { getStoreByDomain } from "../../services/store.server";

export const loader = async ({ request }: ActionFunctionArgs) => {
    try {
        // Allow either a Shopify App Proxy request OR an authenticated admin request.
        try {
            await authenticate.public.appProxy(request);
        } catch (err) {
            // Not an app-proxy request — try admin session (internal requests)
            try {
                await authenticate.admin(request);
            } catch (e) {
                // Not admin — try sales session (sales portal users)
                try {
                    await requireSalesSession(request);
                } catch (se) {
                    return Response.json({ error: 'Unauthorized' }, { status: 403 });
                }
            }
        }

        const url = new URL(request.url);
        const companyId = url.searchParams.get('companyId');
        const shopDomain = url.searchParams.get('shop');

        if (!companyId || !shopDomain) {
            return Response.json({ error: 'Company ID and shop required' }, { status: 400 });
        }

        const store = await getStoreByDomain(shopDomain);
        if (!store || !store.accessToken) {
            return Response.json({ error: 'Store not found or unauthorized' }, { status: 404 });
        }

        // Updated query to include shop currencyCode
        const query = `
            query getCompanyCustomers($companyId: ID!, $first: Int) {
                shop {
                    currencyCode
                }
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

        const response = await fetch(`https://${shopDomain}/admin/api/2023-07/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': store.accessToken,
            },
            body: JSON.stringify({
                query,
                variables: {
                    companyId: companyId.startsWith('gid://') ? companyId : `gid://shopify/Company/${companyId}`,
                    first: 100,
                },
            }),
        });

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL errors:', result.errors);
            return Response.json({ error: 'Failed to fetch company customers' }, { status: 500 });
        }

        const company = result.data?.company;
        const currencyCode = result.data?.shop?.currencyCode; 

        if (!company) {
            return Response.json({ error: 'Company not found' }, { status: 404 });
        }

        const customers = company.contacts.edges.map((edge: any) => ({
            id: edge.node.customer.id.replace('gid://shopify/Customer/', ''),
            firstName: edge.node.customer.firstName,
            lastName: edge.node.customer.lastName,
            email: edge.node.customer.email,
            phone: edge.node.customer.phone,
        }));

        return Response.json({
            customers,
            companyName: company.name,
            currencyCode, 
        });

    } catch (error) {
        console.error('Proxy error:', error);
        return Response.json({
            error: error instanceof Error ? error.message : 'Unknown error',
        }, { status: 500 });
    }
};
