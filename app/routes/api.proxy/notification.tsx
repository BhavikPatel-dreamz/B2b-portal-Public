import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { getStoreByDomain } from "../../services/store.server";
import { getCustomerCompanyInfo } from "../../utils/b2b-customer.server";
import { getProxyParams, validateB2BCustomerAccess } from "../../utils/proxy.server";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, loggedInCustomerId: customerId } = getProxyParams(request);
  const store = await getStoreByDomain(shop);
  const url = new URL(request.url);
  
  // Extract query params
  const { activityType, senderId, search, isRead, limit, page } = Object.fromEntries(url.searchParams);
  
  const user = await prisma.user.findFirst({
    where: { shopifyCustomerId: `gid://shopify/Customer/${customerId}` }
  });

  // Build where clause
  const where: any = { shopId: store?.id, receiverId: user?.id };
  if (activityType) where.activityType = activityType;
  if (senderId) where.senderId = senderId;
  if (isRead) where.isRead = isRead === 'true';
  if (search) where.message = { contains: search, mode: 'insensitive' };

  // Pagination
  const pageSize = parseInt(limit || '10');
  const currentPage = parseInt(page || '1');
  const skip = (currentPage - 1) * pageSize;

  // Parallel queries
  const [notifications, totalCount, unreadCount, readCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, isRead: false } }),
    prisma.notification.count({ where: { ...where, isRead: true } })
  ]);

  // Fetch users
  const userIds = [...new Set(notifications.flatMap(n => [n.senderId, n.receiverId]).filter(Boolean))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
  const userMap = new Map(users.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim()]));

  const notificationsdata = notifications.map(n => ({
    ...n,
    senderName: userMap.get(n.senderId),
    receiverName: userMap.get(n.receiverId)
  }));

  return {
    notificationsdata,
    unreadCount,
    readCount,
    totalCount,
    pagination: {
      total: totalCount,
      page: currentPage,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize)
    },
    filters: { activityType, receiverId: customerId, senderId, search, isRead }
  };
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
                    activeAction,
                    title
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
