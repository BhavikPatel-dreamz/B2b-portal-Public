import prisma from "../db.server";
import { Prisma } from "@prisma/client";

export interface CreateWishlistInput {
  name: string;
  customerId: string;
  shop: string;
  locationId?: string | null;
}

export interface UpdateWishlistInput {
  name?: string;
  locationId?: string | null;
}

export interface CreateWishlistItemInput {
  wishlistId: string;
  productId: string;
  variantId: string;
  productTitle?: string | null;
  variantTitle?: string | null;
  image?: string | null;
  price?: number;
  quantity?: number;
}

export interface UpdateWishlistItemInput {
  productTitle?: string | null;
  variantTitle?: string | null;
  image?: string | null;
  price?: number;
  quantity?: number;
}

/**
 * Create a new wishlist
 */
export async function createWishlist(data: CreateWishlistInput) {
  return await prisma.wishlist.create({
    data: {
      name: data.name,
      customerId: data.customerId,
      shop: data.shop,
      locationId: data.locationId,
    },
    include: {
      items: true,
    },
  });
}

/**
 * Get wishlist by ID
 */
export async function getWishlistById(id: string) {
  return await prisma.wishlist.findUnique({
    where: { id },
    include: {
      items: true,
    },
  });
}

/**
 * Get wishlists for a customer
 */
export async function getWishlistsByCustomer(
  customerId: string,
  shop: string,
  options?: {
    locationId?: string;
    includeItems?: boolean;
  },
) {
  return await prisma.wishlist.findMany({
    where: {
      customerId,
      shop,
      ...(options?.locationId && { locationId: options.locationId }),
    },
    include: {
      items: options?.includeItems || false,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });
}

/**
 * Update a wishlist
 */
export async function updateWishlist(id: string, data: UpdateWishlistInput) {
  return await prisma.wishlist.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
    include: {
      items: true,
    },
  });
}

/**
 * Delete a wishlist
 */
export async function deleteWishlist(id: string) {
  return await prisma.wishlist.delete({
    where: { id },
  });
}

/**
 * Create a wishlist item
 */
export async function createWishlistItem(data: CreateWishlistItemInput) {
  return await prisma.wishlistItem.create({
    data: {
      wishlistId: data.wishlistId,
      productId: data.productId,
      variantId: data.variantId,
      productTitle: data.productTitle,
      variantTitle: data.variantTitle,
      image: data.image,
      price: data.price || 0,
      quantity: data.quantity || 1,
    },
  });
}

/**
 * Get wishlist item by ID
 */
export async function getWishlistItemById(id: string) {
  return await prisma.wishlistItem.findUnique({
    where: { id },
    include: {
      wishlist: true,
    },
  });
}

/**
 * Get wishlist item by variant
 */
export async function getWishlistItemByVariant(
  wishlistId: string,
  variantId: string,
) {
  return await prisma.wishlistItem.findFirst({
    where: {
      wishlistId,
      variantId,
    },
  });
}

/**
 * Update a wishlist item
 */
export async function updateWishlistItem(
  id: string,
  data: UpdateWishlistItemInput,
) {
  return await prisma.wishlistItem.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });
}

/**
 * Update wishlist item quantity
 */
export async function updateWishlistItemQuantity(id: string, quantity: number) {
  return await updateWishlistItem(id, { quantity });
}

/**
 * Delete a wishlist item
 */
export async function deleteWishlistItem(id: string) {
  return await prisma.wishlistItem.delete({
    where: { id },
  });
}

/**
 * Add or update wishlist item
 * If item already exists, updates quantity, otherwise creates new item
 */
export async function addOrUpdateWishlistItem(
  wishlistId: string,
  data: Omit<CreateWishlistItemInput, "wishlistId">,
) {
  const existingItem = await getWishlistItemByVariant(
    wishlistId,
    data.variantId,
  );

  if (existingItem) {
    return await updateWishlistItem(existingItem.id, {
      quantity: existingItem.quantity + (data.quantity || 1),
      price: data.price,
      productTitle: data.productTitle,
      variantTitle: data.variantTitle,
      image: data.image,
    });
  }

  return await createWishlistItem({ ...data, wishlistId });
}

/**
 * Get all items for a wishlist
 */
export async function getWishlistItems(wishlistId: string) {
  return await prisma.wishlistItem.findMany({
    where: { wishlistId },
    orderBy: {
      createdAt: "desc",
    },
  });
}

/**
 * Count wishlist items
 */
export async function countWishlistItems(wishlistId: string) {
  return await prisma.wishlistItem.count({
    where: { wishlistId },
  });
}
