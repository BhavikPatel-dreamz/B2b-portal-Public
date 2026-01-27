import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getStoreByDomain } from "../../services/store.server";
import { getCustomerCompanyInfo } from "../../utils/b2b-customer.server";
import { getProxyParams } from "app/utils/proxy.server";

/**
 * Loader function to handle GET requests for current user company information
 * Used by the useCurrentUser hook
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    try {
        // Authenticate the proxy request
        const { shop, loggedInCustomerId: customerId } = getProxyParams(request);

        if (!customerId || !shop) {
            return Response.json(
                { error: "Customer ID and shop are required" },
                { status: 400 }
            );
        }

        // Get the store to get the access token
        const store = await getStoreByDomain(shop);
        if (!store || !store.accessToken) {
            return Response.json(
                { error: "Store not found or unauthorized" },
                { status: 404 }
            );
        }

        // Fetch customer company information
        const companyInfo = await getCustomerCompanyInfo(
            customerId,
            shop,
            store.accessToken
        );

        if (!companyInfo.hasCompany) {
            return Response.json(
                {
                    hasCompany: false,
                    error: companyInfo.error || "No company found for this customer",
                },
                { status: 403 }
            );
        }

        // Return the company information
        return Response.json({
            success: true,
            hasCompany: true,
            customerId: companyInfo.customerId,
            customerName: companyInfo.customerName,
            customerEmail: companyInfo.customerEmail,
            CreditLimit: companyInfo.CreditLimit,
            pendingCredit: companyInfo.pendingCredit,
            usedCredit: companyInfo.usedCredit,
            creditUsagePercentage: companyInfo.creditUsagePercentage,
            companies: companyInfo.companies,
        });
    } catch (error) {
        console.error("Error fetching customer company info:", error);
        return Response.json(
            {
                error: error instanceof Error ? error.message : "Unknown error",
                hasCompany: false,
            },
            { status: 500 }
        );
    }
};

export const action = async ({ request }: ActionFunctionArgs) => {
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        // Authenticate the proxy request
      const { shop, loggedInCustomerId: customerId } = getProxyParams(request);

        if (!customerId || !shop) {
            return Response.json({ error: 'Customer ID and shop are required' }, { status: 400 });
        }

        if (!shop) {
            return Response.json({ error: 'Shop required' }, { status: 400 });
        }

        // Get the store to get the access token
        const store = await getStoreByDomain(shop);
        if (!store || !store.accessToken) {
            return Response.json({ error: 'Store not found or unauthorized' }, { status: 404 });
        }

        // Fetch company info using the store's access token
        const companyInfo = await getCustomerCompanyInfo(
            customerId,
            shop,
            store.accessToken
        );

        if (!companyInfo.hasCompany || !companyInfo.companies || companyInfo.companies.length === 0) {
            return Response.json({
                ordersCount: 0,
                totalSpend: '$0.00',
                locationsCount: 0,
                message: 'No company found'
            });
        }

        // Aggregate data from all companies (or just use the first one)
        // For simplicity, we'll use the first company
        const company = companyInfo.companies[0];

        // Format currency
        const currency = company.totalSpent?.currencyCode || 'USD';
        const amount = company.totalSpent?.amount || 0;
        const formattedSpend = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency,
        }).format(amount);

        return Response.json({
            ordersCount: 0, // We need to fetch orders count separately if not in company info
            totalSpend: formattedSpend,
            locationsCount: company.locationsCount,
            companyName: company.companyName
        });
    } catch (error) {
        console.error('Proxy error:', error);
        return Response.json({
            error: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
};
