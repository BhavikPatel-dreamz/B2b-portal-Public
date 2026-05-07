import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { Prisma } from "@prisma/client";
import { getStoreByDomain } from "../../services/store.server";
import { getCustomerCompanyInfo } from "../../utils/b2b-customer.server";
import { getProxyParams, validateB2BCustomerAccess } from "../../utils/proxy.server";
import { clearNotificationsCache, notificationCache as cache } from "../../services/notification.server";

interface ShopifyCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mainContact: {
    id: string;
  };
}

const CACHE_TTL = 1 * 60 * 1000; // 1 min — notifications are time-sensitive

// ============================================================
// 📦 LOADER — GET request
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);
    const { shop, loggedInCustomerId: customerId } = getProxyParams(request);

    if (!shop) {
      return new Response("Missing shop domain", { status: 400 });
    }

    // All filter params are FREE — plain URL params, no DB needed
    const { activityType, senderId, search, isRead, limit, page } =
      Object.fromEntries(url.searchParams);

    // ── FAST PATH — build key from URL only, check cache immediately ──
    const cacheKey = `notifications-${shop}-${customerId}-${activityType || ""}-${senderId || ""}-${search || ""}-${isRead || ""}-${limit || "10"}-${page || "1"}`;

    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`⚡ Cache HIT (skipped all DB calls) → ${cacheKey}`);
      console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
      return cached.data; // already a plain object, no Response.json needed
    }

    console.log("🐢 Cache MISS → fetching from DB");

    // ── SLOW PATH — run DB queries ───────────────────────────
    const store = await getStoreByDomain(shop);

    const user = await prisma.user.findFirst({
      where: { shopifyCustomerId: `gid://shopify/Customer/${customerId}` },
    });

    if (!user) {
      console.log("⚠️ User not found in local DB for customerId:", customerId);
      return {
        NotificationsData: [],
        unreadCount: 0,
        readCount: 0,
        totalCount: 0,
        pagination: { total: 0, page: 1, pageSize: 10, totalPages: 0 },
        filters: { activityType, receiverId: customerId, senderId, search, isRead },
      };
    }

    // Build where clause
    const where: Prisma.NotificationWhereInput = {
      shopId: store?.id,
      OR: [
        { receiverId: user.id },
        { adminReceiverId: { contains: `gid://shopify/Customer/${customerId}` } }
      ]
    };
    if (activityType) where.activityType = activityType;
    if (senderId)     where.senderId = senderId;
    if (isRead)       where.isRead = isRead === "true";
    if (search)       where.message = { contains: search, mode: "insensitive" };

    // Pagination
    const pageSize    = parseInt(limit || "10");
    const currentPage = parseInt(page  || "1");
    const skip        = (currentPage - 1) * pageSize;

    // All DB queries in parallel
    const [notifications, totalCount, unreadCount, readCount] =
      await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: pageSize,
          skip,
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { ...where, isRead: false } }),
        prisma.notification.count({ where: { ...where, isRead: true } }),
      ]);

    // Fetch sender/receiver names in one query
    const userIds = [
      ...new Set(
        notifications
          .flatMap((n) => [n.senderId, n.receiverId])
          .filter((id): id is string => !!id),
      ),
    ];

    const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
    const userMap = new Map(
      users.map((u) => [u.id, `${u.firstName || ""} ${u.lastName || ""}`.trim()]),
    );

    const NotificationsData = notifications.map((n) => ({
      ...n,
      senderName:   n.senderId   ? (userMap.get(n.senderId)   ?? null) : null,
      receiverName: n.receiverId ? (userMap.get(n.receiverId) ?? null) : null,
    }));

    const result = {
      NotificationsData,
      unreadCount,
      readCount,
      totalCount,
      pagination: {
        total: totalCount,
        page: currentPage,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      },
      filters: { activityType, receiverId: customerId, senderId, search, isRead },
    };

    // ✅ Store in cache
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`✅ Cache SET → ${cacheKey}`);

    return result;
  } catch (error) {
    console.error("❌ Notifications loader error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  } finally {
    console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
  }
};


export const action = async ({ request }: ActionFunctionArgs) => {

    const formData = await request.formData();
    const actionType = formData.get("action");
    const { customerId, shop } = await validateB2BCustomerAccess(request);

       const store = await getStoreByDomain(shop);

        if (!store || !store.accessToken) {
        throw new Response("Store not found or no access token available during admin check", { status: 404 });
       }
    // Step 3: Get customer company info
    const companyInfo = await getCustomerCompanyInfo(customerId, shop, store.accessToken);
      const adminReceiverIds = companyInfo?.companies.map((company: ShopifyCustomer) => company.mainContact.id) || [];

    try {
        switch (actionType) {
            case "CREATE_NOTIFICATION": {

                const message = formData.get("message") as string;
                const receiverId = formData.get("receiverId") as string | undefined;
                const senderId = formData.get("senderId") as string | undefined;
                const activeAction = formData.get("activeAction") as string | undefined;
                const title = formData.get("title") as string | undefined;
                
                 if (!receiverId  && !senderId) return { error: "At least one receiver or sender is required" };
                if (!message) return { error: "Message is required" };

                const notificationData: Prisma.NotificationCreateInput = {
                    message,
                    shopId: store?.id,
                    activityType: 'pending',
                    adminReceiverId: adminReceiverIds.join(','),
                    isRead: false,
                    activeAction,
                    title
                };

                if (receiverId) notificationData.receiverId = receiverId;
                if (senderId) notificationData.senderId = senderId;


                const notification = await prisma.notification.create({
                    data: notificationData,
                });
                
                clearNotificationsCache(shop, customerId);
                return { notification };
            }

            case "UPDATE_NOTIFICATION": {
                const notificationId = formData.get("notificationId") as string;
                // const activityType = formData.get("activityType") as string;
                const isRead = formData.get("isRead") as 'true' | 'false' ;

                if (!notificationId ) return { error: "Missing required fields" };

                // Verify ownership
                const notification = await prisma.notification.findUnique({
                    where: { id: notificationId },
                });

                if (!notification || notification.shopId !== store?.id) {
                    return { error: "Notification not found or access denied" };
                }

                const updated = await prisma.notification.update({
                    where: { id: notificationId },
                    data: {
                    isRead: isRead == 'true'
        },
                });

                clearNotificationsCache(shop, customerId);
                return { notification: updated };
            }

            case "DELETE_NOTIFICATION": {
                const notificationId = formData.get("notificationId") as string;
                if (!notificationId) return { error: "Notification ID is required" };

                // Verify ownership
                const notification = await prisma.notification.findUnique({
                    where: { id: notificationId },
                });

                if (!notification || notification.shopId !== store?.id) {
                    return { error: "Notification not found or access denied" };
                }

                await prisma.notification.delete({
                    where: { id: notificationId },
                });

                clearNotificationsCache(shop, customerId);
                return { success: true };
            }
            default:
                return { error: "Invalid action" };
        }
    } catch (error) {
        console.error("Notification API Error:", error);
        return { error: "An error occurred" };
    }
};

