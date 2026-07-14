import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { validateB2BCustomerAccess, getCachedCustomerCompanyInfo, getCachedProxyStore } from "../../utils/proxy.server";
import prisma from "../../db.server";
import { generateSmartWishlistRecommendations, findOrCreateSmartWishlist, syncSmartWishlistItems } from "../../services/smart-wishlist.server";

// ============================================================
// 📦 LOADER — GET: Fetch smart wishlist recommendations
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { customerId, shop, store } = await validateB2BCustomerAccess(request);

    if (!store.accessToken) {
      return Response.json({ error: "Store not found" }, { status: 404 });
    }

    const companyInfo = await getCachedCustomerCompanyInfo(
      customerId,
      shop,
      store.accessToken,
    );

    if (!companyInfo.hasCompany || !companyInfo.companies?.length) {
      return Response.json({ frequent: [], seasonal: [], currentMonth: new Date().getMonth() + 1, currentYear: new Date().getFullYear() });
    }

    const company = companyInfo.companies[0];
    const companyData = await prisma.companyAccount.findFirst({
      where: { shopifyCompanyId: company.companyId },
    });

    if (!companyData) {
      return Response.json({ frequent: [], seasonal: [], currentMonth: new Date().getMonth() + 1, currentYear: new Date().getFullYear() });
    }

    const recommendations = await generateSmartWishlistRecommendations(
      shop,
      companyData.id,
    );

    return Response.json(recommendations);
  } catch (error) {
    console.error("Smart wishlist loader error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
};

// ============================================================
// ✏️  ACTION — POST: Generate/save smart wishlists
// ============================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  const { customerId, shop, store } = await validateB2BCustomerAccess(request);
  const formData = await request.formData();
  const actionType = formData.get("action");

  if (!store.accessToken) {
    return Response.json({ error: "Store not found" }, { status: 404 });
  }

  const companyInfo = await getCachedCustomerCompanyInfo(
    customerId,
    shop,
    store.accessToken,
  );

  if (!companyInfo.hasCompany || !companyInfo.companies?.length) {
    return Response.json({ error: "Customer not associated with company" }, { status: 403 });
  }

  const company = companyInfo.companies[0];
  const companyData = await prisma.companyAccount.findFirst({
    where: { shopifyCompanyId: company.companyId },
  });

  if (!companyData) {
    return Response.json({ error: "Company account not found" }, { status: 404 });
  }

  try {
    switch (actionType) {
      case "GENERATE_SMART_WISHLIST": {
        const smartType = formData.get("smartType") as "frequent" | "seasonal";

        if (!smartType || !["frequent", "seasonal"].includes(smartType)) {
          return Response.json({ error: "Invalid smart type. Must be 'frequent' or 'seasonal'" }, { status: 400 });
        }

        const recommendations = await generateSmartWishlistRecommendations(
          shop,
          companyData.id,
        );

        const items = smartType === "frequent" ? recommendations.frequent : recommendations.seasonal;
        const name = smartType === "frequent" ? "Frequently Ordered" : `Seasonal Picks (${new Date().toLocaleString("default", { month: "long" })})`;

        const wishlist = await findOrCreateSmartWishlist(
          customerId,
          shop,
          smartType,
          name,
        );

        const updatedWishlist = await syncSmartWishlistItems(wishlist.id, items);

        return Response.json({ wishlist: updatedWishlist });
      }

      case "SAVE_TO_SMART_WISHLIST": {
        const smartType = formData.get("smartType") as "frequent" | "seasonal";
        const itemsJson = formData.get("items") as string;

        if (!smartType || !itemsJson) {
          return Response.json({ error: "Missing required fields" }, { status: 400 });
        }

        const items = JSON.parse(itemsJson);
        const name = smartType === "frequent" ? "Frequently Ordered" : `Seasonal Picks (${new Date().toLocaleString("default", { month: "long" })})`;

        const wishlist = await findOrCreateSmartWishlist(
          customerId,
          shop,
          smartType,
          name,
        );

        for (const item of items) {
          const existingItem = await prisma.wishlistItem.findFirst({
            where: { wishlistId: wishlist.id, variantId: item.variantId },
          });

          if (!existingItem) {
            await prisma.wishlistItem.create({
              data: {
                wishlistId: wishlist.id,
                productId: item.productId,
                variantId: item.variantId,
                productTitle: item.productTitle,
                variantTitle: item.variantTitle || null,
                image: item.image || null,
                price: item.price || 0,
                quantity: item.quantity || 1,
                soldOut: false,
              },
            });
          }
        }

        await prisma.wishlist.update({
          where: { id: wishlist.id },
          data: { lastSyncedAt: new Date() },
        });

        const updatedWishlist = await prisma.wishlist.findUnique({
          where: { id: wishlist.id },
          include: { items: true },
        });

        return Response.json({ wishlist: updatedWishlist });
      }

      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Smart wishlist action error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "An error occurred" },
      { status: 500 },
    );
  }
};
