import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { getStoreByDomain } from "../../services/store.server";
import { getCustomerCompanyInfo } from "../../utils/b2b-customer.server";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";


export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { customerId, shop } = await validateB2BCustomerAccess(request);
    const store = await getStoreByDomain(shop);

    // Get URL search params for filtering
    const url = new URL(request.url);
    const activityType = url.searchParams.get("activityType");
    const senderId = url.searchParams.get("senderId");
    const search = url.searchParams.get("search");
    const isRead = url.searchParams.get("isRead");
    const limit = url.searchParams.get("limit");
    const page = url.searchParams.get("page");

    // Build dynamic where clause
    const where: any = {
        shopId: store?.id,
        receiverId: customerId
    };

    // Filter by activity type
    if (activityType) {
        where.activityType = activityType;
    }

    // Filter by sender
    if (senderId) {
        where.senderId = senderId;
    }

    // Filter by isRead status
    if (isRead !== null && isRead !== undefined) {
        where.isRead = isRead == 'true';
    }

    // Search in message
    if (search) {
        where.message = {
            contains: search,
            mode: 'insensitive'
        };
    }

    // Pagination
    const pageSize = limit ? parseInt(limit) : 10;
    const currentPage = page ? parseInt(page) : 1;
    const skip = (currentPage - 1) * pageSize;

    // Get total count for pagination
    const totalCount = await prisma.notification.count({ where });

    // Get UNREAD count (always show this regardless of filter)
    const unreadCount = await prisma.notification.count({
        where: {
            shopId: store?.id,
            receiverId: customerId,
            isRead: false
        }
    });

    const notifications = await prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: pageSize,
        skip: skip,
    });

     const baseWhere = {
    shopId: store?.id,
    receiverId: customerId
  };
  // Get APPROVED count based on activityType
    const readCount = await prisma.notification.count({
        where: {
            shopId: store?.id,
            receiverId: customerId,
            isRead: true
        }
    });
    const notificationsdata = notifications.map((notification) => ({
        id: notification.id,
        message: notification.message,
        senderId: notification.senderId,
        receiverId: notification.receiverId,
        shopId: notification.shopId,
        activityType: notification.activityType,
        isRead: notification.isRead,
        createdAt: notification.createdAt,
    }));

    return ({
        notificationsdata: notificationsdata || [],
        unreadCount: unreadCount,
        readCount: readCount ,
        totalCount: totalCount,
        pagination: {
            total: totalCount,
            page: currentPage,
            pageSize: pageSize,
            totalPages: Math.ceil(totalCount / pageSize)
        },
        filters: {
            activityType,
            receiverId: customerId,
            senderId,
            search,
            isRead: isRead
        }
    });
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
      const adminReceiverId = companyInfo?.companies.map((company: any) => company.mainContact.id)

    try {
        switch (actionType) {
            case "CREATE_NOTIFICATION": {

                const message = formData.get("message") as string;
                const receiverId = formData.get("receiverId") as string | undefined;
                const senderId = formData.get("senderId") as string | undefined;
                const activeAction = formData.get("activeAction") as string | undefined;


                 if (!receiverId  && !senderId) return { error: "At least one receiver or sender is required" };
                if (!message) return { error: "Message is required" };

                const notificationData: any = {
                    message,
                    shopId: store?.id,
                    activityType: 'pending',
                    adminReceiverId,
                    isRead: false,
                    activeAction
                };

                if (receiverId) notificationData.receiverId = receiverId;
                if (senderId) notificationData.senderId = senderId;


                const notification = await prisma.notification.create({
                    data: notificationData,
                });
                return { notification };
            }

            case "UPDATE_NOTIFICATION": {
                const notificationId = formData.get("notificationId") as string;
                const activityType = formData.get("activityType") as string;
                const isRead = formData.get("isRead") as 'true' | 'false' ;

                if (!notificationId || !activityType) return { error: "Missing required fields" };

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
                    activityType,
                    isRead: isRead == 'true'
        },
                });

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
