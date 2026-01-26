import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { validateB2BCustomerAccess } from "../../utils/proxy.server";
import { apiVersion } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { customerId, shop } = await validateB2BCustomerAccess(request);

  const wishlists = await prisma.wishlist.findMany({
    where: {
      customerId,
      shop,
    },
    include: {
      items: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  return { wishlists };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { customerId, shop } = await validateB2BCustomerAccess(request);
  const formData = await request.formData();
  const actionType = formData.get("action");

  try {
    switch (actionType) {
      case "CREATE_WISHLIST": {
        const name = formData.get("name") as string;
        const locationId = formData.get("locationId") as string | null;

        if (!name) return { error: "Name is required" };

        const wishlist = await prisma.wishlist.create({
          data: {
            name,
            customerId,
            shop,
            locationId,
          },
        });
        return { wishlist };
      }

      case "UPDATE_WISHLIST": {
        const wishlistId = formData.get("wishlistId") as string;
        const name = formData.get("name") as string;

        if (!wishlistId || !name) return { error: "Missing required fields" };

        // Verify ownership
        const wishlist = await prisma.wishlist.findUnique({
          where: { id: wishlistId },
        });

        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        const updated = await prisma.wishlist.update({
          where: { id: wishlistId },
          data: { name },
        });

        return { wishlist: updated };
      }

      case "DELETE_WISHLIST": {
        const wishlistId = formData.get("wishlistId") as string;
        if (!wishlistId) return { error: "Wishlist ID is required" };

        // Verify ownership
        const wishlist = await prisma.wishlist.findUnique({
          where: { id: wishlistId },
        });

        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        await prisma.wishlist.delete({
          where: { id: wishlistId },
        });
        return { success: true };
      }

      case "ADD_ITEMS_BATCH": {
        const wishlistId = formData.get("wishlistId") as string;
        const itemsJson = formData.get("items") as string;

        if (!wishlistId || !itemsJson) {
          return { error: "Missing required fields" };
        }

        // Verify ownership
        const wishlist = await prisma.wishlist.findUnique({
          where: { id: wishlistId },
        });

        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        const items = JSON.parse(itemsJson);
        const store = await getStoreByDomain(shop);
        if (!store || !store.accessToken) {
          throw new Error("Store not found");
        }

        // Process each item
        const results = [];
        for (const item of items) {
          console.log(item.productId);

          const response = await fetch(
            `https://${shop}/admin/api/${apiVersion}/graphql.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": store.accessToken,
              },
              body: JSON.stringify({
                query: `
        query getProduct($id: ID!) {
          product(id: $id) {
            id
            title
            featuredImage {
              url
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price
                }
              }
            }
          }
        }
      `,
                variables: {
                  id: item.productId,
                },
              }),
            },
          );

          const productData = await response.json();
          const product = productData?.data?.product;
          const variant = product?.variants?.edges?.find(
            (v: { node: { id: any } }) => v.node.id === item.variantId,
          )?.node;

          // Check if item already exists
          const existingItem = await prisma.wishlistItem.findFirst({
            where: {
              wishlistId,
              variantId: item.variantId,
            },
          });

          if (existingItem) {
            // Update quantity
            const updated = await prisma.wishlistItem.update({
              where: { id: existingItem.id },
              data: {
                quantity: existingItem.quantity + item.quantity,
                price: item.price, // Update price in case it changed
              },
            });
            results.push(updated);
          } else {
            // Create new item
            const newItem = await prisma.wishlistItem.create({
              data: {
                wishlistId,
                productId: product?.id || item.productId,
                variantId: variant?.id || item.variantId,
                productTitle: product?.title || item.title,
                variantTitle: variant?.title || item.variantTitle,
                image: product?.featuredImage?.url || item.image,
                price: variant?.price ? parseFloat(variant.price) : item.price,
                quantity: item.quantity,
              },
            });
            results.push(newItem);
          }
        }

        return { items: results, success: true };
      }

      case "ADD_ITEM": {
        const wishlistId = formData.get("wishlistId") as string;
        const productId = formData.get("productId") as string;
        const variantId = formData.get("variantId") as string;
        const quantity = parseInt(formData.get("quantity") as string) || 1;
        const productTitle = formData.get("productTitle") as string;
        const variantTitle = formData.get("variantTitle") as string;
        const image = formData.get("image") as string;
        const price = parseFloat(formData.get("price") as string) || 0;

        if (!wishlistId || !productId || !variantId) {
          return { error: "Missing required fields" };
        }

        // Verify ownership
        const wishlist = await prisma.wishlist.findUnique({
          where: { id: wishlistId },
        });

        if (!wishlist || wishlist.customerId !== customerId) {
          return { error: "Wishlist not found or access denied" };
        }

        // Check if item already exists
        const existingItem = await prisma.wishlistItem.findFirst({
          where: {
            wishlistId,
            variantId,
          },
        });

        if (existingItem) {
          const updatedItem = await prisma.wishlistItem.update({
            where: { id: existingItem.id },
            data: {
              quantity: existingItem.quantity + quantity,
              price, // Update price
            },
          });
          return { item: updatedItem };
        } else {
          const newItem = await prisma.wishlistItem.create({
            data: {
              wishlistId,
              productId,
              variantId,
              quantity,
              productTitle,
              variantTitle,
              image,
              price,
            },
          });
          return { item: newItem };
        }
      }

      case "UPDATE_ITEM": {
        const itemId = formData.get("itemId") as string;
        const quantity = parseInt(formData.get("quantity") as string);

        if (!itemId || isNaN(quantity)) return { error: "Invalid data" };

        // Verify ownership via wishlist
        const item = await prisma.wishlistItem.findUnique({
          where: { id: itemId },
          include: { wishlist: true },
        });

        if (!item || item.wishlist.customerId !== customerId) {
          return { error: "Item not found or access denied" };
        }

        if (quantity <= 0) {
          await prisma.wishlistItem.delete({ where: { id: itemId } });
          return { success: true, deleted: true };
        }

        const updatedItem = await prisma.wishlistItem.update({
          where: { id: itemId },
          data: { quantity },
        });
        return { item: updatedItem };
      }

      case "DELETE_ITEM": {
        const itemId = formData.get("itemId") as string;
        if (!itemId) return { error: "Item ID is required" };

        // Verify ownership via wishlist
        const item = await prisma.wishlistItem.findUnique({
          where: { id: itemId },
          include: { wishlist: true },
        });

        if (!item || item.wishlist.customerId !== customerId) {
          return { error: "Item not found or access denied" };
        }

        await prisma.wishlistItem.delete({
          where: { id: itemId },
        });
        return { success: true };
      }

      default:
        return { error: "Invalid action" };
    }
  } catch (error) {
    console.error("Wishlist API Error:", error);
    return { error: "An error occurred" };
  }
};
