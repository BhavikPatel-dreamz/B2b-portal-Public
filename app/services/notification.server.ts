import prisma from "../db.server";
import { Prisma } from "@prisma/client";

export interface CreateNotificationInput {
  receiverId?: string | null;
  adminReceiverId?: string | null;
  senderId?: string | null;
  message: string;
  activityType?: string | null;
  activeAction?: string | null;
  shopId: string;
  title?: string | null;
  shopifyOrderId?: string | null;
}

export interface UpdateNotificationInput {
  isRead?: boolean;
  message?: string;
  activityType?: string | null;
  activeAction?: string | null;
  title?: string | null;
}

// ============================================================
// 🗂️  CACHE SETUP 
// ============================================================

declare global {
  var __notificationsCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
}

export const notificationCache: Map<string, { data: any; timestamp: number }> =
  globalThis.__notificationsCache ??
  (globalThis.__notificationsCache = new Map());

/**
 * Clear notification cache for a specific shop and customer
 */
export const clearNotificationsCache = (shop: string, customerId?: string) => {
  const prefix = customerId ? `notifications-${shop}-${customerId}` : `notifications-${shop}`;
  for (const key of notificationCache.keys()) {
    if (key.startsWith(prefix)) {
      notificationCache.delete(key);
    }
  }
  console.log("🧹 Notifications cache cleared for:", prefix);
};

/**
 * Create a new notification
 */
export async function createNotification(data: CreateNotificationInput) {
  const notification = await prisma.notification.create({
    data: {
      receiverId: data.receiverId,
      adminReceiverId: data.adminReceiverId,
      senderId: data.senderId,
      message: data.message,
      activityType: data.activityType,
      activeAction: data.activeAction,
      shopId: data.shopId,
      title: data.title,
      shopifyOrderId: data.shopifyOrderId,
      isRead: false,
    },
  });

  // Try to clear cache if shopId is known
  // Note: We might need the shop domain here, but for now we'll rely on the caller to clear cache or we'll need to fetch shop domain
  return notification;
}

/**
 * Get notification by ID
 */
export async function getNotificationById(id: string) {
  return await prisma.notification.findUnique({
    where: { id },
  });
}

/**
 * Get notifications for a receiver
 */
export async function getNotificationsByReceiver(
  receiverId: string,
  shopId: string,
  options?: {
    isRead?: boolean;
    orderBy?: Prisma.NotificationOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.NotificationWhereInput = {
    receiverId,
    shopId,
    ...(options?.isRead !== undefined && { isRead: options.isRead }),
  };

  return await prisma.notification.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
  });
}

/**
 * Get notifications for admin
 */
export async function getNotificationsByAdmin(
  adminReceiverId: string,
  shopId: string,
  options?: {
    isRead?: boolean;
    orderBy?: Prisma.NotificationOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.NotificationWhereInput = {
    adminReceiverId,
    shopId,
    ...(options?.isRead !== undefined && { isRead: options.isRead }),
  };

  return await prisma.notification.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
  });
}

/**
 * Update a notification
 */
export async function updateNotification(
  id: string,
  data: UpdateNotificationInput,
) {
  const notification = await prisma.notification.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });

  // Fetch shop domain to clear cache
  const store = await prisma.store.findUnique({
    where: { id: notification.shopId },
    select: { shopDomain: true },
  });

  if (store?.shopDomain) {
    if (notification.receiverId) {
      const user = await prisma.user.findUnique({ where: { id: notification.receiverId }, select: { shopifyCustomerId: true } });
      if (user?.shopifyCustomerId) {
        clearNotificationsCache(store.shopDomain, user.shopifyCustomerId.replace("gid://shopify/Customer/", ""));
      }
    }
    // Also clear for admin if needed, but it's harder to clear for multiple admins without knowing who they are
    // For now, clearing by shop prefix might be safer
    clearNotificationsCache(store.shopDomain);
  }

  return notification;
}

/**
 * Mark notification as read
 */
export async function markNotificationAsRead(id: string) {
  return await updateNotification(id, { isRead: true });
}

/**
 * Mark all notifications as read for a receiver
 */
export async function markAllAsReadForReceiver(
  receiverId: string,
  shopId: string,
) {
  const result = await prisma.notification.updateMany({
    where: {
      receiverId,
      shopId,
      isRead: false,
    },
    data: {
      isRead: true,
      updatedAt: new Date(),
    },
  });

  const store = await prisma.store.findUnique({
    where: { id: shopId },
    select: { shopDomain: true },
  });

  if (store?.shopDomain) {
      const user = await prisma.user.findUnique({ where: { id: receiverId }, select: { shopifyCustomerId: true } });
      if (user?.shopifyCustomerId) {
        clearNotificationsCache(store.shopDomain, user.shopifyCustomerId.replace("gid://shopify/Customer/", ""));
      }
  }

  return result;
}

/**
 * Delete a notification
 */
export async function deleteNotification(id: string) {
  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification) return null;

  await prisma.notification.delete({
    where: { id },
  });

  const store = await prisma.store.findUnique({
    where: { id: notification.shopId },
    select: { shopDomain: true },
  });

  if (store?.shopDomain) {
    if (notification.receiverId) {
       const user = await prisma.user.findUnique({ where: { id: notification.receiverId }, select: { shopifyCustomerId: true } });
       if (user?.shopifyCustomerId) {
         clearNotificationsCache(store.shopDomain, user.shopifyCustomerId.replace("gid://shopify/Customer/", ""));
       }
    }
    clearNotificationsCache(store.shopDomain);
  }
  
  return true;
}

/**
 * Count notifications
 */
export async function countNotifications(
  where: Prisma.NotificationWhereInput,
) {
  return await prisma.notification.count({ where });
}

/**
 * Count unread notifications for a receiver
 */
export async function countUnreadNotifications(
  receiverId: string,
  shopId: string,
) {
  return await countNotifications({
    receiverId,
    shopId,
    isRead: false,
  });
}

/**
 * Count read notifications for a receiver
 */
export async function countReadNotifications(
  receiverId: string,
  shopId: string,
) {
  return await countNotifications({
    receiverId,
    shopId,
    isRead: true,
  });
}

/**
 * Send company welcome email
 */
export async function sendCompanyWelcomeEmail(
  submissionEmail: string,
  companyName: string,
  contactName: string,
): Promise<void> {
  try {
    // Format email
    const to = submissionEmail;
    const subject = `New Company Sync: ${companyName}`;
    const htmlContent = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2>Company Sync Complete</h2>
            <p>Hello,</p>
            <p>A new company has been synced from your Shopify B2B network:</p>
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p><strong>Company:</strong> ${companyName}</p>
              <p><strong>Primary Contact:</strong> ${contactName}</p>
            </div>
            <p>The company has been added to your B2B portal system and is ready for use.</p>
            <p>Best regards,<br/>B2B Portal System</p>
          </div>
        </body>
      </html>
    `;

    const textContent = `
      Company Sync Complete

      Hello,

      A new company has been synced from your Shopify B2B network:

      Company: ${companyName}
      Primary Contact: ${contactName}

      The company has been added to your B2B portal system and is ready for use.

      Best regards,
      B2B Portal System
    `;

    // TODO: Implement actual email sending via your email service
    // For now, this is a placeholder that logs the email
    console.log("Email sent:", {
      to,
      subject,
      htmlContent,
      textContent,
    });

  } catch (error) {
    console.error("Error sending company welcome email:", error);
    throw error;
  }
}
