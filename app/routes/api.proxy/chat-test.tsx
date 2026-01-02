import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";

/**
 * Chat Test Proxy API
 * This endpoint tests fetching chat/conversation data via proxy
 * Accessible at: /api/proxy/chat-test
 */

// Handle GET requests
export const loader = async ({ request }: LoaderFunctionArgs) => {
    try {
        console.log('Chat test loader - URL:', request.url);

        // Authenticate the proxy request
        await authenticate.public.appProxy(request);

        const url = new URL(request.url);
        const customerId = url.searchParams.get('logged_in_customer_id');
        const shop = url.searchParams.get('shop');

        console.log('Chat test loader - Customer ID:', customerId, 'Shop:', shop);

        if (!customerId) {
            return Response.json({ error: 'Customer ID required' }, { status: 400 });
        }

        if (!shop) {
            return Response.json({ error: 'Shop required' }, { status: 400 });
        }

        // Mock chat data for GET requests
        const chatData = {
            conversations: [
                {
                    id: "conv_001",
                    subject: "Order Inquiry",
                    status: "open",
                    lastMessage: "When will my order arrive?",
                    lastMessageAt: new Date().toISOString(),
                    unreadCount: 2,
                    customer: {
                        id: customerId,
                        name: "John Doe",
                        email: "john@example.com"
                    }
                }
            ],
            totalConversations: 1,
            unreadTotal: 2,
            shop: shop,
            method: 'GET'
        };

        return Response.json({
            success: true,
            data: chatData,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Chat proxy GET error:', error);
        return Response.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
};

// Handle POST requests
export const action = async ({ request }: ActionFunctionArgs) => {
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        console.log('Chat test action - URL:', request.url);

        // Authenticate the proxy request
        await authenticate.public.appProxy(request);

        // Parse the body
        const { customerId, shop } = await request.json();

        console.log('Chat test action - Customer ID:', customerId, 'Shop:', shop);        if (!customerId) {
            return Response.json({ error: 'Customer ID required' }, { status: 400 });
        }

        if (!shop) {
            return Response.json({ error: 'Shop required' }, { status: 400 });
        }

        // Get the store to get the access token
        const store = await getStoreByDomain(shop);
        if (!store || !store.accessToken) {
            return Response.json({ error: 'Store not found or unauthorized' }, { status: 404 });
        }

        // Mock chat data for testing
        // In a real implementation, you would fetch this from Shopify's API or your database
        const chatData = {
            conversations: [
                {
                    id: "conv_001",
                    subject: "Order Inquiry",
                    status: "open",
                    lastMessage: "When will my order arrive?",
                    lastMessageAt: new Date().toISOString(),
                    unreadCount: 2,
                    customer: {
                        id: customerId,
                        name: "John Doe",
                        email: "john@example.com"
                    }
                },
                {
                    id: "conv_002",
                    subject: "Product Question",
                    status: "closed",
                    lastMessage: "Thank you for the information!",
                    lastMessageAt: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
                    unreadCount: 0,
                    customer: {
                        id: customerId,
                        name: "John Doe",
                        email: "john@example.com"
                    }
                }
            ],
            totalConversations: 2,
            unreadTotal: 2,
            shop: shop
        };

        // You could also fetch real data from Shopify Admin API
        // Example: Fetch customer metafields or notes
        /*
        const response = await fetch(
            `https://${shop}/admin/api/2025-01/customers/${customerId}.json`,
            {
                method: 'GET',
                headers: {
                    'X-Shopify-Access-Token': store.accessToken,
                    'Content-Type': 'application/json',
                },
            }
        );

        if (!response.ok) {
            throw new Error(`Shopify API error: ${response.statusText}`);
        }

        const customerData = await response.json();
        */

        return Response.json({
            success: true,
            data: chatData,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Chat proxy error:', error);
        return Response.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
};
