import prisma from "../db.server";

export interface CreateStoreInput {
  shopDomain: string;
  shopName?: string;
  accessToken?: string;
  scope?: string;
}

export interface UpdateStoreInput {
  shopName?: string;
  accessToken?: string;
  scope?: string;
  isActive?: boolean;
  logo?: string | null;
  submissionEmail?: string | null;
}

/**
 * Create or update a store (upsert on install)
 */
export async function upsertStore(data: CreateStoreInput) {
  return await prisma.store.upsert({
    where: { shopDomain: data.shopDomain },
    create: {
      shopDomain: data.shopDomain,
      shopName: data.shopName,
      accessToken: data.accessToken,
      scope: data.scope,
    },
    update: {
      shopName: data.shopName,
      accessToken: data.accessToken,
      scope: data.scope,
      isActive: true,
      uninstalledAt: null,
    },
  });
}

/**
 * Get store by shop domain
 */
export async function getStoreByDomain(shopDomain: string) {
  return await prisma.store.findUnique({
    where: { shopDomain },
    include: {
      users: true,
    },
  });
}

/**
 * Get store by ID
 */
export async function getStoreById(id: string) {
  return await prisma.store.findUnique({
    where: { id },
    include: {
      users: true,
    },
  });
}

/**
 * Get all stores
 */
export async function getAllStores() {
  return await prisma.store.findMany({
    where: { isActive: true },
    orderBy: { installedAt: "desc" },
    include: {
      _count: {
        select: { users: true },
      },
    },
  });
}

/**
 * Update store
 */
export async function updateStore(id: string, data: UpdateStoreInput) {
  return await prisma.store.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });
}

/**
 * Mark store as uninstalled
 */
export async function uninstallStore(shopDomain: string) {
  return await prisma.store.update({
    where: { shopDomain },
    data: {
      isActive: false,
      uninstalledAt: new Date(),
    },
  });
}

/**
 * Delete store and all associated users
 */
export async function deleteStore(id: string) {
  return await prisma.store.delete({
    where: { id },
  });
}
