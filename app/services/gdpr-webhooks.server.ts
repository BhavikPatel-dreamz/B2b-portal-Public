import prisma from "../db.server";
import { deleteStore, getStoreByDomain } from "./store.server";

type CustomerPayload = {
  customer?: {
    id?: string | number | null;
    email?: string | null;
  } | null;
  customer_id?: string | number | null;
  email?: string | null;
};

function compactOrFilters<T>(filters: Array<T | null>): T[] {
  return filters.filter((filter): filter is T => filter !== null);
}

function getCustomerIdentifiers(payload?: CustomerPayload | null) {
  const rawId = payload?.customer?.id ?? payload?.customer_id ?? null;
  const email = payload?.customer?.email ?? payload?.email ?? null;
  const numericId = rawId ? String(rawId) : null;
  const gid = numericId ? `gid://shopify/Customer/${numericId}` : null;

  return {
    email: email?.trim() || null,
    numericId,
    gid,
  };
}

async function getStoreOrThrow(shop: string) {
  const store = await getStoreByDomain(shop);

  if (!store) {
    throw new Error(`Store not found for ${shop}`);
  }

  return store;
}

async function deleteStoreWideCustomerData(shop: string, storeId: string) {
  const users = await prisma.user.findMany({
    where: { shopId: storeId },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);

  const companies = await prisma.companyAccount.findMany({
    where: { shopId: storeId },
    select: { id: true },
  });
  const companyIds = companies.map((company) => company.id);

  const orders = await prisma.b2BOrder.findMany({
    where: { shopId: storeId },
    select: { id: true },
  });
  const orderIds = orders.map((order) => order.id);

  if (userIds.length > 0) {
    await prisma.userSession.deleteMany({
      where: { userId: { in: userIds } },
    });
  }

  if (orderIds.length > 0) {
    await prisma.orderPayment.deleteMany({
      where: { orderId: { in: orderIds } },
    });
  }

  if (companyIds.length > 0) {
    await prisma.creditTransaction.deleteMany({
      where: { companyId: { in: companyIds } },
    });
  }

  await prisma.wishlist.deleteMany({ where: { shop } });
  await prisma.notification.deleteMany({ where: { shopId: storeId } });
  await prisma.b2BOrder.deleteMany({ where: { shopId: storeId } });
  await prisma.companyAccount.deleteMany({ where: { shopId: storeId } });
  await prisma.registrationSubmission.deleteMany({ where: { shopId: storeId } });
  await prisma.user.deleteMany({ where: { shopId: storeId } });
}

export async function processCustomersDataRequest(
  shop: string,
  payload?: CustomerPayload | null,
) {
  const store = await getStoreOrThrow(shop);
  const identifiers = getCustomerIdentifiers(payload);

  const userWhere =
    identifiers.email || identifiers.gid
      ? {
          shopId: store.id,
          OR: compactOrFilters([
            identifiers.email ? { email: identifiers.email } : null,
            identifiers.gid ? { shopifyCustomerId: identifiers.gid } : null,
          ]),
        }
      : { shopId: store.id };

  const registrationWhere =
    identifiers.email || identifiers.gid
      ? {
          shopId: store.id,
          OR: compactOrFilters([
            identifiers.email ? { email: identifiers.email } : null,
            identifiers.gid ? { shopifyCustomerId: identifiers.gid } : null,
          ]),
        }
      : { shopId: store.id };

  const wishlistWhere =
    identifiers.numericId
      ? { shop, customerId: identifiers.numericId }
      : { shop };

  const [userCount, registrationCount, wishlistCount] = await Promise.all([
    prisma.user.count({ where: userWhere }),
    prisma.registrationSubmission.count({ where: registrationWhere }),
    prisma.wishlist.count({ where: wishlistWhere }),
  ]);

  return {
    message:
      identifiers.email || identifiers.numericId
        ? "Customer data request processed successfully."
        : "Store-wide customer data request processed successfully.",
    summary: { userCount, registrationCount, wishlistCount },
  };
}

export async function processCustomersRedact(
  shop: string,
  payload?: CustomerPayload | null,
) {
  const store = await getStoreOrThrow(shop);
  const identifiers = getCustomerIdentifiers(payload);

  if (!identifiers.email && !identifiers.gid && !identifiers.numericId) {
    await deleteStoreWideCustomerData(shop, store.id);
    return {
      message: "All customer-related data has been deleted for this store.",
    };
  }

  const users = await prisma.user.findMany({
    where: {
      shopId: store.id,
      OR: compactOrFilters([
        identifiers.email ? { email: identifiers.email } : null,
        identifiers.gid ? { shopifyCustomerId: identifiers.gid } : null,
      ]),
    },
    select: { id: true },
  });

  const userIds = users.map((user) => user.id);

  if (userIds.length > 0) {
    await prisma.userSession.deleteMany({
      where: { userId: { in: userIds } },
    });
  }

  await prisma.registrationSubmission.deleteMany({
    where: {
      shopId: store.id,
      OR: compactOrFilters([
        identifiers.email ? { email: identifiers.email } : null,
        identifiers.gid ? { shopifyCustomerId: identifiers.gid } : null,
      ]),
    },
  });

  if (identifiers.numericId) {
    await prisma.wishlist.deleteMany({
      where: { shop, customerId: identifiers.numericId },
    });
  }

  await prisma.user.deleteMany({
    where: {
      shopId: store.id,
      OR: compactOrFilters([
        identifiers.email ? { email: identifiers.email } : null,
        identifiers.gid ? { shopifyCustomerId: identifiers.gid } : null,
      ]),
    },
  });

  return {
    message: "Customer redact processed successfully.",
  };
}

export async function processShopRedact(shop: string) {
  const store = await getStoreOrThrow(shop);

  await deleteStoreWideCustomerData(shop, store.id);
  await prisma.emailTemplates.deleteMany({ where: { shopId: store.id } });
  await deleteStore(shop);

  return {
    message: "Shop redact processed successfully. Store data has been deleted.",
  };
}
