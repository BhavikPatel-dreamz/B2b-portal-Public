import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";
import { apiVersion } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";


// ============================================================
// 🗂️  CACHE SETUP 
// ============================================================

declare global {
  // Layer 1 — validateB2BCustomerAccess result per shop+loggedInCustomerId
  // This call is expensive (auth + Shopify API) — cache it across all routes
  var __wishlistAuthCache:
    | Map<string, { data: { customerId: string; shop: string }; timestamp: number }>
    | undefined;

  // Layer 2 — full wishlists response per shop+customerId
  var __wishlistDataCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
}

const authCache: Map<
  string,
  { data: { customerId: string; shop: string }; timestamp: number }
> =
  globalThis.__wishlistAuthCache ??
  (globalThis.__wishlistAuthCache = new Map());

const dataCache: Map<string, { data: any; timestamp: number }> =
  globalThis.__wishlistDataCache ??
  (globalThis.__wishlistDataCache = new Map());

const AUTH_TTL = 10 * 60 * 1000; //  10 min — auth/identity rarely changes
const DATA_TTL =  2 * 60 * 1000; //   2 min — wishlists change on every add/remove

// ============================================================
// 🧹 CACHE HELPERS
// ============================================================

export const clearWishlistCache = (shop: string, customerId: string) => {
  const key = `wishlists-${shop}-${customerId}`;
  dataCache.delete(key);
  console.log("🧹 Wishlist cache cleared for:", key);
};

// ============================================================
// 📦 LOADER — GET request
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);

    // shop + loggedInCustomerId are FREE — plain URL params, no auth needed
    const shopFromUrl       = url.searchParams.get("shop") || "";
    const rawCustomerId     = url.searchParams.get("logged_in_customer_id") || "";
    const authCacheKey      = `wishlist-auth-${shopFromUrl}-${rawCustomerId}`;

    // ── FAST PATH ───────────────────────────────────────────
    if (shopFromUrl && rawCustomerId) {
      const cachedAuth = authCache.get(authCacheKey);

      if (cachedAuth && Date.now() - cachedAuth.timestamp < AUTH_TTL) {
        const { customerId, shop } = cachedAuth.data;
        const dataCacheKey = `wishlists-${shop}-${customerId}`;
        const cachedData   = dataCache.get(dataCacheKey);

        if (cachedData && Date.now() - cachedData.timestamp < DATA_TTL) {
          // 🎉 Zero auth, zero DB calls
          console.log(`⚡ Cache HIT (skipped auth + DB) → ${dataCacheKey}`);
          console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
          return cachedData.data;
        }
      }
    }

    // ── SLOW PATH — cache miss, run full auth + DB ──────────
    console.log("🐢 Cache MISS → running auth + DB");

    const { customerId, shop } = await validateB2BCustomerAccess(request);

    // ✅ Cache the auth result — skipped on next request
    authCache.set(authCacheKey, {
      data: { customerId, shop },
      timestamp: Date.now(),
    });

    const dataCacheKey = `wishlists-${shop}-${customerId}`;

    const wishlists = await prisma.wishlist.findMany({
      where: { customerId, shop },
      include: { items: true },
      orderBy: { updatedAt: "desc" },
    });

    const result = { wishlists };

    // ✅ Cache the data
    dataCache.set(dataCacheKey, { data: result, timestamp: Date.now() });
    console.log(`✅ Cache SET → ${dataCacheKey}`);
    console.log(`🚀 API Time: ${Date.now() - startTime}ms`);

    return result;
  } catch (error) {
    console.error("❌ Wishlist loader error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
};

// ============================================================
// ✏️  ACTION — POST/form requests
// Auth always runs on mutations — we never skip it for security.
// Cache is busted after every successful mutation.
// ============================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  const { customerId, shop } = await validateB2BCustomerAccess(request);
  const formData   = await request.formData();
  const actionType = formData.get("action");

  // Helper — bust cache then return response
  const respondAndClear = (data: object) => {
    clearWishlistCache(shop, customerId);
    return data;
  };

  try {
    switch (actionType) {
      // ── CREATE WISHLIST ─────────────────────────────────────
      case "CREATE_WISHLIST": {
        const name       = formData.get("name") as string;
        const locationId = formData.get("locationId") as string | null;

        if (!name) return { error: "Name is required" };

        const wishlist = await prisma.wishlist.create({
          data: { name, customerId, shop, locationId },
        });

        return respondAndClear({ wishlist });
      }

      // ── UPDATE WISHLIST ─────────────────────────────────────
      case "UPDATE_WISHLIST": {
        const wishlistId = formData.get("wishlistId") as string;
        const name       = formData.get("name") as string;

        if (!wishlistId || !name) return { error: "Missing required fields" };

        const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        const updated = await prisma.wishlist.update({
          where: { id: wishlistId },
          data: { name },
        });

        return respondAndClear({ wishlist: updated });
      }

      // ── DELETE WISHLIST ─────────────────────────────────────
      case "DELETE_WISHLIST": {
        const wishlistId = formData.get("wishlistId") as string;
        if (!wishlistId) return { error: "Wishlist ID is required" };

        const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        await prisma.wishlist.delete({ where: { id: wishlistId } });

        return respondAndClear({ success: true });
      }

      // ── ADD ITEMS BATCH ─────────────────────────────────────
      case "ADD_ITEMS_BATCH": {
        const wishlistId = formData.get("wishlistId") as string;
        const itemsJson  = formData.get("items") as string;

        if (!wishlistId || !itemsJson) return { error: "Missing required fields" };

        const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        const store = await getStoreByDomain(shop);
        if (!store || !store.accessToken) throw new Error("Store not found");

        const items = JSON.parse(itemsJson);
        const results = [];

        for (const item of items) {
          console.log(item.productId);

          const response = await fetch(
            `https://${shop}/admin/api/${apiVersion}/graphql.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": store.accessToken,
              },
              body: JSON.stringify({
                query: `
                  query getProduct($id: ID!) {
                    product(id: $id) {
                      id
                      title
                      featuredImage { url }
                      variants(first: 10) {
                        edges {
                          node { id title price }
                        }
                      }
                    }
                  }
                `,
                variables: { id: item.productId },
              }),
            },
          );

          const productData = await response.json();
          const product = productData?.data?.product;
          const variant = product?.variants?.edges?.find(
            (v: { node: { id: string } }) => v.node.id === item.variantId,
          )?.node;

          const existingItem = await prisma.wishlistItem.findFirst({
            where: { wishlistId, variantId: item.variantId },
          });

          if (existingItem) {
            const updated = await prisma.wishlistItem.update({
              where: { id: existingItem.id },
              data: { quantity: existingItem.quantity + item.quantity, price: item.price },
            });
            results.push(updated);
          } else {
            const newItem = await prisma.wishlistItem.create({
              data: {
                wishlistId,
                productId:    product?.id || item.productId,
                variantId:    variant?.id || item.variantId,
                productTitle: product?.title || item.title,
                variantTitle: variant?.title || item.variantTitle,
                image:        product?.featuredImage?.url || item.image,
                price:        variant?.price ? parseFloat(variant.price) : item.price,
                quantity:     item.quantity,
              },
            });
            results.push(newItem);
          }
        }

        return respondAndClear({ items: results, success: true });
      }

      // ── ADD ITEM ────────────────────────────────────────────
      case "ADD_ITEM": {
        const wishlistId   = formData.get("wishlistId") as string;
        const productId    = formData.get("productId") as string;
        const variantId    = formData.get("variantId") as string;
        const quantity     = parseInt(formData.get("quantity") as string) || 1;
        const productTitle = formData.get("productTitle") as string;
        const variantTitle = formData.get("variantTitle") as string;
        const image        = formData.get("image") as string;
        const price        = parseFloat(formData.get("price") as string) || 0;

        if (!wishlistId || !productId || !variantId) {
          return { error: "Missing required fields" };
        }

        const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        const existingItem = await prisma.wishlistItem.findFirst({
          where: { wishlistId, variantId },
        });

        if (existingItem) {
          const updatedItem = await prisma.wishlistItem.update({
            where: { id: existingItem.id },
            data: { quantity: existingItem.quantity + quantity, price },
          });
          return respondAndClear({ item: updatedItem });
        }

        const newItem = await prisma.wishlistItem.create({
          data: { wishlistId, productId, variantId, quantity, productTitle, variantTitle, image, price },
        });

        return respondAndClear({ item: newItem });
      }

      // ── UPDATE ITEM ─────────────────────────────────────────
      case "UPDATE_ITEM": {
        const itemId   = formData.get("itemId") as string;
        const quantity = parseInt(formData.get("quantity") as string);

        if (!itemId || isNaN(quantity)) return { error: "Invalid data" };

        const item = await prisma.wishlistItem.findUnique({
          where: { id: itemId },
          include: { wishlist: true },
        });

        if (!item || item.wishlist.customerId !== customerId) {
          return { error: "Item not found or access denied" };
        }

        if (quantity <= 0) {
          await prisma.wishlistItem.delete({ where: { id: itemId } });
          return respondAndClear({ success: true, deleted: true });
        }

        const updatedItem = await prisma.wishlistItem.update({
          where: { id: itemId },
          data: { quantity },
        });

        return respondAndClear({ item: updatedItem });
      }

      // ── DELETE ITEM ─────────────────────────────────────────
      case "DELETE_ITEM": {
        const itemId = formData.get("itemId") as string;
        if (!itemId) return { error: "Item ID is required" };

        const item = await prisma.wishlistItem.findUnique({
          where: { id: itemId },
          include: { wishlist: true },
        });

        if (!item || item.wishlist.customerId !== customerId) {
          return { error: "Item not found or access denied" };
        }

        await prisma.wishlistItem.delete({ where: { id: itemId } });

        return respondAndClear({ success: true });
      }

      default:
        return { error: "Invalid action" };
    }
  } catch (error) {
    console.error("Wishlist API Error:", error);
    return { error: "An error occurred" };
  }
};
