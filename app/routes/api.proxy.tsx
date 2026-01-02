import { Outlet } from "react-router";

/**
 * API Proxy Parent Route
 *
 * All routes under /api/proxy will go through this parent route.
 * This allows you to add common logic, authentication, or middleware
 * for all API proxy endpoints.
 *
 * To add a new API endpoint:
 * 1. Create a new file: app/routes/api.proxy/your-endpoint.tsx
 * 2. Add the route in routes.ts inside the /api/proxy route array:
 *    route("your-endpoint", "routes/api.proxy/your-endpoint.tsx")
 * 3. Access it at: https://yourstore.com/apps/b2b-portal/api/proxy/your-endpoint
 *
 * Example structure:
 * /api/proxy/chat-test          -> routes/api.proxy/chat-test.tsx
 * /api/proxy/customer-company   -> routes/api.proxy/customer-company.tsx
 * /api/proxy/orders             -> routes/api.proxy/orders.tsx
 */

export default function ApiProxyLayout() {
  // This component just passes through to child routes
  // You can add common logic here if needed
  return <Outlet />;
}

// You can add a loader here if you need common authentication
// or data fetching for all API proxy routes
/*
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Common authentication or setup
  await authenticate.public.appProxy(request);

  return null;
};
*/
