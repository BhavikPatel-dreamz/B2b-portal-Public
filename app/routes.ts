import {
  type RouteConfig,
  route,
  index,
  prefix,
} from "@react-router/dev/routes";

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
  route(
    "webhooks/draft_orders/create",
    "routes/webhooks.draft_orders_create.tsx",
  ),
  route(
    "webhooks/draft_orders/update",
    "routes/webhooks.draft_orders_update.tsx",
  ),
  route(
    "webhooks/draft_orders/delete",
    "routes/webhooks.draft_orders_delete.tsx",
  ),
  route("webhooks/shop/update", "routes/webhooks.shop.update.tsx"),
  route(
    "webhooks/customers/data_request",
    "routes/webhooks.customers.data_request.tsx",
  ),
  route("webhooks/customers/redact", "routes/webhooks.customers.redact.tsx"),
  route("webhooks/shop/redact", "routes/webhooks.shop.redact.tsx"),

  // API Proxy routes (using prefix for folder organization)
  ...prefix("api/proxy", [
    route("chat-test", "routes/api.proxy/chat-test.tsx"),
    route("company-customers", "routes/api.proxy/company-customers.tsx"),
    route("company-locations", "routes/api.proxy/company-locations.tsx"),
    route("customer-company", "routes/api.proxy/customer-company.tsx"),
    route("locationmanagement", "routes/api.proxy/locationmanagement.tsx"),
    route("notification", "routes/api.proxy/notification.tsx"),
    route("order-invoice", "routes/api.proxy/order-invoice.tsx"),
    route("orders", "routes/api.proxy/orders.tsx"),
    route("product-search", "routes/api.proxy/product-search.tsx"),
    route("product-filter", "routes/api.proxy/product-filter.tsx"),
    route("get-filter", "routes/api.proxy/get-filter.tsx"),
    route("recommended-products", "routes/api.proxy/recommended-products.tsx"),
    route("registration", "routes/api.proxy/registration.tsx"),
    route("usermanagement", "routes/api.proxy/usermanagement.tsx"),
    route(
      "credit-transaction-list",
      "routes/api.proxy/credit-transaction-list.tsx",
    ),
    route("validate-customer", "routes/api.proxy/validate-customer.tsx"),
    route("wishlist", "routes/api.proxy/wishlist.tsx"),
    route("privacy-policy", "routes/api.proxy/privacy-policy.tsx"),
    route("customer-account", "routes/api.proxy/customer-account.tsx"),
    route("customer-detail", "routes/api.proxy/customer-detail.tsx"),
    route("shipping-zones", "routes/api.proxy/shipping-zones.tsx"),
    route("item-purchase-report", "routes/api.proxy/item-purchase-report.tsx"),
    route("spend-report", "routes/api.proxy/spend-report.tsx"),
  ]),

  // App routes
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("home", "routes/app.home.tsx"),
    route("companies", "routes/app.companies.tsx"),
    route("registrations", "routes/app.registrations.tsx"),
    route("settings", "routes/app.settings.tsx"),
    route("invoice-template", "routes/app.invoice-template.tsx"),
    route("registration-form", "routes/app.registration-form.tsx"),
    route("notifications", "routes/app.notification-form.tsx"),
    route("sales-users", "routes/app.sales-users.tsx"),
    route("sales-dashboard", "routes/app.sales-dashboard.tsx"),
    route("companies/:companyId", "routes/app.company-dashboard.tsx"),
    route("reports", "routes/app.reports.tsx"),
    route(
      "companies/:companyId/orders",
      "routes/app.companies.$companyId.orders.tsx",
    ),
    route(
      "companies/:companyId/users",
      "routes/app.companies.$companyId.users.tsx",
    ),
    route(
      "companies/:companyId/credits",
      "routes/app.companies.$companyId.credits.tsx",
    ),
    route("select-plan", "routes/app.select-plan.tsx"),
    route("cancel-subscription", "routes/app.cancel-subscription.tsx"),
    route("billing-example", "routes/app.billing-example.tsx"),
  ]),
  
  
  // Unified Sales Portal (single login for all companies/stores)
  route("sales/login", "routes/sales.login.tsx"),
  route("sales/dashboard", "routes/sales.dashboard.tsx"),
  route("sales/portal", "routes/sales.portal.tsx"),
  route("sales/portal/company/:companyId/create-order", "routes/sales.portal.company.$companyId.create-order.tsx"),
  route("sales/portal/company/:companyId/create-order/step2", "routes/sales.portal.company.$companyId.create-order.step2.tsx"),

  // Legacy support routes (kept for backward compatibility with invitation links)
  route("support/login", "routes/support.login.tsx"),
  route("support/dashboard", "routes/support.dashboard.tsx"),
  route("support/portal", "routes/support.portal.tsx"),
  // App Proxy routes (public, no auth required)
  route("smartb2b", "routes/smartb2b.tsx"),

  // Index route
  index("routes/_index/route.tsx"),
] satisfies RouteConfig;
