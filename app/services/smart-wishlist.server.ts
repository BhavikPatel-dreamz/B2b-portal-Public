import prisma from "../db.server";

export interface SmartWishlistItem {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  image: string | null;
  price: number;
  quantity: number;
  sku: string | null;
  orderCount: number;
  totalQuantity: number;
  lastOrderedAt: string;
}

export interface SmartWishlistResult {
  frequent: SmartWishlistItem[];
  seasonal: SmartWishlistItem[];
  currentMonth: number;
  currentYear: number;
}

/**
 * Get the most frequently ordered items for a customer's company
 */
async function getFrequentOrderItems(
  shop: string,
  companyId: string,
  limit: number = 20,
): Promise<SmartWishlistItem[]> {
  const results = await prisma.b2BOrderItem.groupBy({
    by: ["variantId"],
    where: {
      order: {
        shopId: shop,
        companyId,
        orderStatus: { notIn: ["cancelled", "archived"] },
      },
      variantId: { not: null },
    },
    _count: { id: true },
    _sum: { quantity: true },
    _max: { createdAt: true },
    orderBy: { _count: { id: "desc" } },
    take: limit,
  });

  if (results.length === 0) return [];

  const variantIds = results.map((r) => r.variantId).filter(Boolean) as string[];

  const orderItems = await prisma.b2BOrderItem.findMany({
    where: {
      variantId: { in: variantIds },
      order: {
        shopId: shop,
        companyId,
        orderStatus: { notIn: ["cancelled", "archived"] },
      },
    },
    select: {
      variantId: true,
      productId: true,
      productTitle: true,
      variantTitle: true,
      image: true,
      unitPrice: true,
      sku: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const itemMap = new Map<string, (typeof orderItems)[0]>();
  for (const item of orderItems) {
    if (item.variantId && !itemMap.has(item.variantId)) {
      itemMap.set(item.variantId, item);
    }
  }

  return results
    .filter((r) => r.variantId && itemMap.has(r.variantId))
    .map((r) => {
      const item = itemMap.get(r.variantId!)!;
      return {
        productId: item.productId || "",
        variantId: r.variantId!,
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        image: item.image,
        price: Number(item.unitPrice),
        quantity: 1,
        sku: item.sku,
        orderCount: r._count.id,
        totalQuantity: r._sum.quantity || 0,
        lastOrderedAt: r._max.createdAt?.toISOString() || "",
      };
    });
}

/**
 * Get items that were purchased in the same calendar month in previous years
 * (seasonal/recurring items)
 */
async function getSeasonalOrderItems(
  shop: string,
  companyId: string,
  currentMonth: number,
  limit: number = 20,
): Promise<SmartWishlistItem[]> {
  const startDate = new Date(new Date().getFullYear() - 3, currentMonth - 1, 1);
  const endDate = new Date(new Date().getFullYear(), currentMonth, 0, 23, 59, 59);

  const results = await prisma.b2BOrderItem.groupBy({
    by: ["variantId"],
    where: {
      order: {
        shopId: shop,
        companyId,
        orderStatus: { notIn: ["cancelled", "archived"] },
        createdAt: { gte: startDate, lte: endDate },
      },
      variantId: { not: null },
    },
    _count: { id: true },
    _sum: { quantity: true },
    _max: { createdAt: true },
    orderBy: { _count: { id: "desc" } },
    take: limit,
  });

  if (results.length === 0) return [];

  const variantIds = results.map((r) => r.variantId).filter(Boolean) as string[];

  const orderItems = await prisma.b2BOrderItem.findMany({
    where: {
      variantId: { in: variantIds },
      order: {
        shopId: shop,
        companyId,
        orderStatus: { notIn: ["cancelled", "archived"] },
      },
    },
    select: {
      variantId: true,
      productId: true,
      productTitle: true,
      variantTitle: true,
      image: true,
      unitPrice: true,
      sku: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const itemMap = new Map<string, (typeof orderItems)[0]>();
  for (const item of orderItems) {
    if (item.variantId && !itemMap.has(item.variantId)) {
      itemMap.set(item.variantId, item);
    }
  }

  return results
    .filter((r) => r.variantId && itemMap.has(r.variantId))
    .map((r) => {
      const item = itemMap.get(r.variantId!)!;
      return {
        productId: item.productId || "",
        variantId: r.variantId!,
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        image: item.image,
        price: Number(item.unitPrice),
        quantity: 1,
        sku: item.sku,
        orderCount: r._count.id,
        totalQuantity: r._sum.quantity || 0,
        lastOrderedAt: r._max.createdAt?.toISOString() || "",
      };
    });
}

/**
 * Generate smart wishlist recommendations for a customer
 */
export async function generateSmartWishlistRecommendations(
  shop: string,
  companyId: string,
): Promise<SmartWishlistResult> {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const [frequent, seasonal] = await Promise.all([
    getFrequentOrderItems(shop, companyId, 15),
    getSeasonalOrderItems(shop, companyId, currentMonth, 15),
  ]);

  return {
    frequent,
    seasonal,
    currentMonth,
    currentYear,
  };
}

/**
 * Find or create a smart wishlist of a given type for a customer
 */
export async function findOrCreateSmartWishlist(
  customerId: string,
  shop: string,
  smartType: "frequent" | "seasonal",
  name: string,
) {
  let wishlist = await prisma.wishlist.findFirst({
    where: { customerId, shop, isSmart: true, smartType },
    include: { items: true },
  });

  if (!wishlist) {
    wishlist = await prisma.wishlist.create({
      data: {
        name,
        customerId,
        shop,
        isSmart: true,
        smartType,
        lastSyncedAt: new Date(),
      },
      include: { items: true },
    });
  }

  return wishlist;
}

/**
 * Sync smart wishlist items: remove old items and add new recommendations
 */
export async function syncSmartWishlistItems(
  wishlistId: string,
  recommendations: SmartWishlistItem[],
) {
  await prisma.wishlistItem.deleteMany({ where: { wishlistId } });

  if (recommendations.length === 0) {
    return prisma.wishlist.findUnique({
      where: { id: wishlistId },
      include: { items: true },
    });
  }

  await prisma.wishlistItem.createMany({
    data: recommendations.map((item) => ({
      wishlistId,
      productId: item.productId,
      variantId: item.variantId,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      image: item.image,
      price: item.price,
      quantity: item.quantity,
      soldOut: false,
    })),
  });

  await prisma.wishlist.update({
    where: { id: wishlistId },
    data: { lastSyncedAt: new Date() },
  });

  return prisma.wishlist.findUnique({
    where: { id: wishlistId },
    include: { items: true },
  });
}
