import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import { getCompanyLocations } from "../../utils/b2b-customer.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    try {
        // Authenticate the proxy request
        await authenticate.public.appProxy(request);

        const url = new URL(request.url);
        const companyId = url.searchParams.get('companyId');
        const shop = url.searchParams.get('shop');

        if (!companyId) {
            return Response.json({ error: 'Company ID required' }, { status: 400 });
        }

        if (!shop) {
            return Response.json({ error: 'Shop required' }, { status: 400 });
        }

        // Get the store to get the access token
        const store = await getStoreByDomain(shop);
        if (!store || !store.accessToken) {
            return Response.json({ error: 'Store not found or unauthorized' }, { status: 404 });
        }

        // Fetch company locations
        const result = await getCompanyLocations(
            companyId,
            shop,
            store.accessToken
        );

        if (result.error) {
            return Response.json({ error: result.error }, { status: 500 });
        }

        return Response.json({
            locations: result.locations || []
        });

    } catch (error) {
        console.error('Proxy error:', error);
        return Response.json({
            error: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
};
