import { unauthenticated } from "../../shopify.server.js";
import { getStoreByDomain } from "../../services/store.server.js";
import {
  syncShopifyCompanies,
  syncAllShopifyOrders,
} from "../../utils/company.server.js";

// ---------------------------------------------------------------------------
// Shopify -> app sync (the reverse direction of order-sync.server.js)
// ---------------------------------------------------------------------------
// Pulls every Shopify B2B company (with its contacts) and every one of those
// companies' orders into the local database, so the admin Companies page and
// the order-management lists fill automatically on the cron instead of only
// when someone clicks "Sync Companies" or a new orders/create webhook fires.
//
// Reuses the functions the manual "Sync Companies" button already calls:
//   syncShopifyCompanies  -> CompanyAccount + User + RegistrationSubmission
//   syncAllShopifyOrders  -> B2BOrder (+ B2BOrderItem) for each synced company
//
// There is no browser session on a cron call, so we authenticate to Shopify
// with the stored offline token via unauthenticated.admin(shop).
export async function syncShopifyToApp(shop) {
  const store = await getStoreByDomain(shop);
  if (!store) {
    return { shop, skipped: true, reason: "no store record for this shop" };
  }
  if (store.isActive === false || store.uninstalledAt) {
    return { shop, skipped: true, reason: "store is inactive/uninstalled" };
  }

  const { admin } = await unauthenticated.admin(shop);

  // Companies first — this is what creates/refreshes the CompanyAccount rows
  // that the order sync then iterates. Contacts (users) are synced inside it.
  const companies = await syncShopifyCompanies(
    admin,
    store,
    store.contactEmail || store.submissionEmail,
  );

  // Then every synced company's orders.
  const orders = await syncAllShopifyOrders(admin, store);

  // The Companies page caches its DB reads; drop the shop's entries so the
  // freshly-synced companies/credit show up without waiting for the TTL.
  try {
    const { clearAdminCompaniesCache } = await import(
      "../routes/app.companies.tsx"
    );
    clearAdminCompaniesCache(shop);
  } catch (err) {
    console.warn(
      `[shopify-sync] could not clear the companies cache for ${shop}: ${err?.message || err}`,
    );
  }

  return {
    shop,
    companies: {
      success: companies.success,
      syncedCount: companies.syncedCount,
      deletedCount: companies.deletedCount,
      errors: companies.errors,
    },
    orders: {
      success: orders.success,
      companiesProcessed: orders.companiesProcessed,
      companyCount: orders.companyCount,
      syncedCount: orders.syncedCount,
      skippedCount: orders.skippedCount,
      errors: orders.errors,
    },
  };
}
