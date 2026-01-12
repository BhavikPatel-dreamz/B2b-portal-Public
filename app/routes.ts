import { type RouteConfig, route, index, prefix } from "@react-router/dev/routes";

export default [
  // Auth routes
  route("auth/*", "routes/auth.$.tsx"),
  route("auth/login", "routes/auth.login/route.tsx"),

  // Webhooks
  route("webhooks/app/scopes_update", "routes/webhooks.app.scopes_update.tsx"),
  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.tsx"),
  route("webhooks/customers/create", "routes/webhooks.customers_create.tsx"),
  route("webhooks/customers/delete", "routes/webhooks.customers_delete.tsx"),
  route("webhooks/orders/create", "routes/webhooks.orders_create.tsx"),
  route("webhooks/orders/paid", "routes/webhooks.orders_paid.tsx"),
  route("webhooks/orders/cancelled", "routes/webhooks.orders_cancelled.tsx"),
  route("webhooks/orders/edited", "routes/webhooks.orders_edited.tsx"),
  route("webhooks/orders/updated", "routes/webhooks.orders_updated.tsx"),
  route("webhooks/draft_orders/create", "routes/webhooks.draft_orders_create.tsx"),
  route("webhooks/draft_orders/update", "routes/webhooks.draft_orders_update.tsx"),
  route("webhooks/draft_orders/delete", "routes/webhooks.draft_orders_delete.tsx"),

  // API Proxy routes (using prefix for folder organization)
  ...prefix("api/proxy", [
    route("chat-test", "routes/api.proxy/chat-test.tsx"),
    route("company-customers", "routes/api.proxy/company-customers.tsx"),
    route("company-locations", "routes/api.proxy/company-locations.tsx"),
    route("customer-company", "routes/api.proxy/customer-company.tsx"),
    route("locationmanagement", "routes/api.proxy/locationmanagement.tsx"),
    route("notification", "routes/api.proxy/notification.tsx"),
    route("orders", "routes/api.proxy/orders.tsx"),
    route("product-search", "routes/api.proxy/product-search.tsx"),
    route("registration", "routes/api.proxy/registration.tsx"),
    route("usermanagement", "routes/api.proxy/usermanagement.tsx"),
    route("validate-customer", "routes/api.proxy/validate-customer.tsx"),
    route("wishlist", "routes/api.proxy/wishlist.tsx"),
  ]),

  // App routes
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("companies", "routes/app.companies.tsx"),
    route("registrations", "routes/app.registrations.tsx"),
    route("settings", "routes/app.settings.tsx"),
    route("companies/:companyId", "routes/app.company-dashboard.tsx"),
    route("companies/:companyId/orders", "routes/app.companies.$companyId.orders.tsx"),
    route("companies/:companyId/users", "routes/app.companies.$companyId.users.tsx"),
  ]),

  // Index route
  index("routes/_index/route.tsx"),
] satisfies RouteConfig;
