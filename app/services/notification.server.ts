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
}

export interface UpdateNotificationInput {
  isRead?: boolean;
  message?: string;
}

/**
 * Create a new notification
 */
export async function createNotification(data: CreateNotificationInput) {
  return await prisma.notification.create({
    data: {
      receiverId: data.receiverId,
      adminReceiverId: data.adminReceiverId,
      senderId: data.senderId,
      message: data.message,
      activityType: data.activityType,
      activeAction: data.activeAction,
      shopId: data.shopId,
      isRead: false,
    },
  });
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
  return await prisma.notification.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });
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
  return await prisma.notification.updateMany({
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
}

/**
 * Delete a notification
 */
export async function deleteNotification(id: string) {
  return await prisma.notification.delete({
    where: { id },
  });
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
