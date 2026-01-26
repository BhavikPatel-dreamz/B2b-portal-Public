import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyWithPermissions } from "../../utils/proxy.server";
import { requirePermission } from "../../utils/permissions.server";
import {
  getCompanyLocations,
  updateCompanyLocation,
  deleteCompanyLocation,
  checkLocationHasUsers,
  createLocationAndAssignToContact,
  checkLocationExists,
} from "../../utils/b2b-customer.server";

/**
 * API Proxy Route for Location Management
 *
 * Endpoints:
 * - GET: List locations
 * - POST: Create, Edit, Delete locations based on action type
 *
 * Access via: /apps/b2b-portal/api/proxy/locationmanagement
 *
 * Required Permissions:
 * - GET: canViewReports (all users can view locations)
 * - POST (create/edit/delete): canManageLocations
 *
 * Allowed Roles: Company Admin, Main Contact (for write operations)
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { companyId, store, shop } =
      await authenticateApiProxyWithPermissions(request);

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }
    // Fetch all locations
    const locationsData = await getCompanyLocations(
      companyId,
      shop,
      store.accessToken,
    );

    if (locationsData.error) {
      return Response.json(
        { error: "Failed to fetch locations" },
        { status: 500 },
      );
    }

    return Response.json({
      success: true,
      locations: locationsData.locations || [],
      companyName: locationsData.companyName,
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
    // Authenticate and validate B2B access with permissions
    const { companyId, store, shop, userContext } =
      await authenticateApiProxyWithPermissions(request);

    // Check if user has permission to manage locations
    requirePermission(
      userContext,
      "canManageLocations",
      "You do not have permission to manage locations. Only Company Admins and Main Contacts can create, edit, or delete locations.",
    );

    // Ensure accessToken is available
    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    // Parse the body for action and other data
    const body = await request.json();
    const { action: actionType } = body;

    // Handle different actions
    switch (actionType) {
      case "create": {
        const {
          name,
          address1,
          address2,
          city,
          province,
          zip,
          country,
          phone,
          externalId,
          note,
        } = body;

        const validations = [
          { condition: !name, message: "Location name is required" },
          {
            condition: !address1,
            message: "Address field is required",
          },
          { condition: !phone, message: "Phone number is required" },
          { condition: !externalId, message: "External ID is required" },
          {
            condition: !city,
            message: "City field is required",
          },
          {
            condition: !country,
            message: "Country field is required",
          },
          {
            condition: !zip,
            message: "Zip field is required",
          },
        ];

        for (const v of validations) {
          if (v.condition) {
            return Response.json({ error: v.message }, { status: 400 });
          }
        }

        const alreadyExists = await checkLocationExists(
          companyId,
          shop,
          store.accessToken,
          name,
        );

        if (alreadyExists) {
          return Response.json({
            success: false,
            error: "Already exist this location in this company",
          });
        }

        const result = await createLocationAndAssignToContact(
          companyId,
          `gid://shopify/Customer/${userContext.customerId}`,
          shop,
          store.accessToken,
          {
            name,
            address1: address1 || "",
            address2: address2 || "",
            city: city || "",
            province: province || "GJ",
            zip: zip || "",
            country: country || "IN",
            phone: phone || "",
            externalId: externalId || "",
            note: note || "",
          },
        );

        // FIX: Check for error and return proper status code
        if (result.error) {
          return Response.json(
            {
              error: result.error,
              details: result.details,
            },
            { status: 400 }, // Changed from 500 to 400 for better error handling
          );
        }

        return Response.json({ success: true, locationId: result.locationId });
      }

      case "edit": {
        const {
          locationId,
          name,
          address1,
          address2,
          city,
          province,
          zip,
          country,
          phone,
          externalId,
          note,
        } = body;

        if (!locationId) {
          return Response.json(
            { error: "Location ID is required for editing" },
            { status: 400 },
          );
        }

        const result = await updateCompanyLocation(
          locationId,
          shop,
          store.accessToken,
          {
            name: name || undefined,
            address1: address1 || undefined,
            address2: address2 || undefined,
            city: city || undefined,
            province: province || undefined,
            zip: zip || undefined,
            country: country || undefined,
            phone: phone || undefined,
            externalId: externalId || undefined,
            note: note || undefined,
          },
        );

        // FIX: Proper error handling
        if (result.error) {
          return Response.json(
            {
              error: result.error,
              userErrors: result.userErrors,
            },
            { status: 400 },
          );
        }

        return Response.json({ success: true });
      }

      case "delete": {
        const { locationId } = body;

        if (!locationId) {
          return Response.json(
            { error: "Location ID is required for deletion" },
            { status: 400 },
          );
        }

        // Check if location has assigned users
        const userCheck = await checkLocationHasUsers(
          locationId,
          shop,
          store.accessToken,
        );

        if (userCheck.error) {
          return Response.json(
            { error: "Failed to verify location status" },
            { status: 500 },
          );
        }

        if (userCheck.hasUsers) {
          return Response.json(
            {
              error: `Cannot delete location "${userCheck.locationName}". It has ${userCheck.userCount} assigned user(s). Please unassign all users before deleting.`,
              assignedUsers: userCheck.userCount,
            },
            { status: 400 },
          );
        }

        // Proceed with deletion
        const result = await deleteCompanyLocation(
          locationId,
          shop,
          store.accessToken,
        );

        if (result.error) {
          return Response.json({ error: result.error }, { status: 400 });
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
