
/**
 * API Proxy Parent Route
 *
 * All routes under /api/proxy are organized in the api.proxy/ folder.
 * Route configuration is managed in app/routes.ts using custom route config.
 *
 * To add a new API endpoint:
 * 1. Create a new file: app/routes/api.proxy/your-endpoint.tsx
 * 2. Add the route in routes.ts inside the api/proxy prefix array:
 *    route("your-endpoint", "routes/api.proxy/your-endpoint.tsx")
 * 3. Access it at: https://yourstore.com/apps/b2b-portal/api/proxy/your-endpoint
 *
 * Example structure:
 * /api/proxy/chat-test          -> routes/api.proxy/chat-test.tsx
 * /api/proxy/customer-company   -> routes/api.proxy/customer-company.tsx
 * /api/proxy/orders             -> routes/api.proxy/orders.tsx
 */

export default function ApiProxyLayout() {
  // This component is not used as a layout in the current configuration
  // Routes are prefixed directly without a parent layout
  return null;
}
