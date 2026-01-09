import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyWithPermissions } from "../../utils/proxy.server";
import { requirePermission } from "../../utils/permissions.server";
import {
  getCompanyCustomers,
  createCompanyCustomer,
  getCompanyRoles,
  getCompanyLocations,
  updateCompanyCustomer,
  deleteCompanyCustomer,
  getCompanyContactEmail,
} from "../../utils/b2b-customer.server";
import prisma from "app/db.server";

/**
 * API Proxy Route for User Management
 *
 * Endpoints:
 * - GET: List users with pagination
 * - POST: Create, Edit, Delete users based on action type
 *
 * Access via: /apps/b2b-portal/api/proxy/usermanagement
 *
 * Required Permission: canManageUsers
 * Allowed Roles: Company Admin, Main Contact
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Authenticate and validate B2B access with permissions
    const { companyId, store, shop, userContext, customerId } =
      await authenticateApiProxyWithPermissions(request);

    // Check if user has permission to manage users
    requirePermission(
      userContext,
      "canManageUsers",
      "You do not have permission to view users. Only Company Admins and Main Contacts can access user management.",
    );

    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Ensure accessToken is available
    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    // Handle different GET actions
    if (action === "roles") {
      // Fetch available roles
      const roles = await getCompanyRoles(shop, store.accessToken);
      return Response.json({ success: true, roles });
    }

    if (action === "locations") {
      // Fetch available locations
      const locationsData = await getCompanyLocations(
        companyId,
        shop,
        store.accessToken,
      );
      return Response.json({
        success: true,
        locations: locationsData.locations || [],
      });
    }

    const Registrationdata = await prisma.registrationSubmission.findFirst({
      where: {
        shopifyCustomerId: `gid://shopify/Customer/${customerId}`,
      },
    });
    // Default: List users
    const after = url.searchParams.get("after") || undefined;
    const query = url.searchParams.get("query") || "";
    const sortParam = url.searchParams.get("sort") || "Sort: Name";

    let sortKey = "NAME";
    if (sortParam === "Sort: Name") {
      sortKey = "NAME";
    } else if (sortParam === "Sort: Company") {
      sortKey = "NAME";
    }

    // Fetch customers for the company
    const customersData = await getCompanyCustomers(
      companyId,
      shop,
      store.accessToken,
      {
        first: 10,
        after,
        query,
        sortKey,
        reverse: false,
      },
    );

    if (customersData.error) {
      return Response.json(
        { error: "Failed to fetch customers" },
        { status: 500 },
      );
    }

    // Map to the format expected by the component with locationRoles array
    const users = customersData.customers.map((c: any) => {
      // Build locationRoles array from roleAssignments
      const locationRoles =
        c.customer.roleAssignments?.edges?.map((edge: any) => ({
          roleName: userContext.isMainContact == true ? "Company Admin" : edge.node.role.name,
          locationName: edge.node.companyLocation?.name || null,
          roleId: edge.node.role.id || null,
          locationId: edge.node.companyLocation?.id || null,
        })) || [];

      const name = c.customer.lastName
        ? `${c.customer.firstName} ${c.customer.lastName}`.trim()
        : c.customer.firstName || Registrationdata?.contactName;
      return {
        id: c.id,
        name,
        email: c.customer.email,
        company: customersData.companyName,
        role: userContext.isMainContact == true ? "Company Admin" : c.roles.length > 0 ? c.roles.join(", ") : "",
        credit: c.credit !== undefined && c.credit !== null ? c.credit : 0,
        locations:
          c.locationNames && c.locationNames.length > 0
            ? c.locationNames.join(", ")
            : "",
        locationRoles: locationRoles,
        reports: {
          activity: {
            lastOrder: "N/A",
            totalOrders: "0",
            totalOrdersCount: 0,
          },
          orders: [],
          creditUsage: {
            creditUsed: 0,
            creditLimit: 0,
            transactions: [],
          },
        },
      };
    });

    return Response.json({
      success: true,
      users,
      pageInfo: customersData.pageInfo,
      companyName: customersData.companyName,
    });
  } catch (error) {
    console.error("Proxy error (GET):", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { companyId, store, shop, userContext } =
      await authenticateApiProxyWithPermissions(request);
    console.log(userContext.customerEmail, "45454454");
    requirePermission(
      userContext,
      "canManageUsers",
      "You do not have permission to manage users. Only Company Admins and Main Contacts can create, edit, or delete users.",
    );

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    const body = await request.json();
    const { action: actionType } = body;

    switch (actionType) {
      case "create": {
        const { name, email, locationRoles, credit } = body;

        if (!name || !email) {
          return Response.json(
            { error: "Name and email are required" },
            { status: 400 },
          );
        }

        const [firstName, ...lastNameParts] = name.trim().split(" ");
        const lastName = lastNameParts.join(" ");

        const result = await createCompanyCustomer(
          companyId,
          shop,
          store.accessToken,
          {
            firstName: firstName || "",
            lastName: lastName || "",
            email,
            locationRoles: locationRoles || [],
            credit: parseFloat(credit) || 0,
          },
        );

        // ✅ Handle errors properly
        if (result.error) {
          return Response.json(
            { success: false, error: result.error },
            { status: 400 }, // Use 400 for validation errors, not 500
          );
        }

        return Response.json({
          success: true,
          customerId: result.customerId,
          contactId: result.contactId,
        });
      }

      case "edit": {
        const { userId, name, email, locationRoles, credit } = body;

        if (!userId) {
          return Response.json(
            { error: "User ID is required for editing" },
            { status: 400 },
          );
        }

        const [firstName, ...lastNameParts] = (name || "").trim().split(" ");
        const lastName = lastNameParts.join(" ");

        const result = await updateCompanyCustomer(
          userId,
          companyId,
          shop,
          store.accessToken,
          {
            firstName: firstName || undefined,
            lastName: lastName || undefined,
            email,
            locationRoles: locationRoles || undefined,
            credit: parseFloat(credit) || 0,
          },
        );

        if (result.error) {
          return Response.json({ error: result.error }, { status: 500 });
        }

        return Response.json({ success: true, result });
      }

      // case "delete": {
      //   const { userId } = body;

      //   if (!userId) {
      //     return Response.json(
      //       { error: "User ID is required for deletion" },
      //       { status: 400 },
      //     );
      //   }

      //   const result = await deleteCompanyCustomer(
      //     userId,
      //     shop,
      //     store.accessToken,
      //   );

      //   if (result.error) {
      //     return Response.json({ error: result.error }, { status: 500 });
      //   }

      //   return Response.json({ success: true, deletedId: result.deletedId });
      // }
      case "delete": {
        const { userId } = body;

        if (!userId) {
          return Response.json(
            { error: "User ID is required for deletion" },
            { status: 400 },
          );
        }

        // 🔒 Fetch contact email
        const contactEmail = await getCompanyContactEmail(
          userId,
          shop,
          store.accessToken,
        );

        if (!contactEmail) {
          return Response.json(
            { error: "Company contact not found" },
            { status: 404 },
          );
        }

        // 🔥 BLOCK SELF DELETE
        if (
          userContext.customerEmail &&
          contactEmail.toLowerCase() === userContext.customerEmail.toLowerCase()
        ) {
          return Response.json(
            {
              error: "You cannot delete your own account.",
            },
            { status: 403 },
          );
        }

        // ✅ Allow delete
        const result = await deleteCompanyCustomer(
          userId,
          shop,
          store.accessToken,
        );
        await prisma.user.delete({
          where: { id: userId },
        });

        if (result.error) {
          return Response.json({ error: result.error }, { status: 500 });
        }

        return Response.json({
          success: true,
          deletedId: result.deletedId,
        });
      }

      default:
        return Response.json({ error: "Invalid action type" }, { status: 400 });
    }
  } catch (error) {
    console.error("Proxy error (POST):", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
};
