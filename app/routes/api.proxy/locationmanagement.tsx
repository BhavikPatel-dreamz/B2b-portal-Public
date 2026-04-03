import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyWithPermissions } from "../../utils/proxy.server";
import { requirePermission } from "../../utils/permissions.server";
import {
  getCompanyLocations,
  updateCompanyLocation,
  deleteCompanyLocation,
  createLocationAndAssignToContact,
  checkLocationExists,
  checkLocationHasOrders,
  checkLocationHasUsers,
} from "../../utils/b2b-customer.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { companyId, store, shop } =
      await authenticateApiProxyWithPermissions(request);

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 }
      );
    }

    const locationsData = await getCompanyLocations(
      companyId,
      shop,
      store.accessToken
    );
    console.log("🚀 ~ loader ~ locationsData:", locationsData)

    if (locationsData.error) {
      return Response.json(
        { error: "Failed to fetch locations" },
        { status: 500 }
      );
    }

    const graphqlRes = await fetch(
      `https://${shop}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": store.accessToken,
        },
        body: JSON.stringify({
          query: `
            query {
              shop {
                countriesInShippingZones {
                  countryCodes
                  includeRestOfWorld
                }
              }
              deliveryProfiles(first: 10) {
                nodes {
                  profileLocationGroups {
                    locationGroupZones(first: 100) {
                      nodes {
                        zone {
                          countries {
                            code { countryCode }
                            name
                            provinces { code name }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
        }),
      }
    );

    const gql = await graphqlRes.json();

    if (gql.errors) {
      console.error("GraphQL Error:", gql.errors);
      return Response.json(
        { error: "Failed to fetch shipping data" },
        { status: 500 }
      );
    }

    const validCodes = new Set<string>(
      gql.data?.shop?.countriesInShippingZones?.countryCodes || []
    );

    const provincesData: {
      countryCode: string;
      countryName: string;
      provinces: { value: string; label: string }[];
    }[] = [];

    for (const profile of gql.data?.deliveryProfiles?.nodes || []) {
      for (const group of profile.profileLocationGroups || []) {
        for (const zoneNode of group.locationGroupZones?.nodes || []) {
          for (const country of zoneNode.zone?.countries || []) {
            const code = country.code?.countryCode;

            if (!code || !validCodes.has(code)) continue;

            const provinces = (country.provinces || []).map(
              (p: { code: string; name: string }) => ({
                value: p.code,
                label: p.name,
              })
            );

            const existing = provincesData.find(
              (c) => c.countryCode === code
            );

            if (existing) {
              const existingCodes = new Set(
                existing.provinces.map((p) => p.value)
              );

              for (const p of provinces) {
                if (!existingCodes.has(p.value)) {
                  existing.provinces.push(p);
                }
              }
            } else {
              provincesData.push({
                countryCode: code,
                countryName: country.name,
                provinces,
              });
            }
          }
        }
      }
    }

    for (const c of provincesData) {
      c.provinces.sort((a, b) =>
        a.label.localeCompare(b.label)
      );
    }

    provincesData.sort((a, b) =>
      a.countryName.localeCompare(b.countryName)
    );

    return Response.json({
      success: true,
      locations: locationsData.locations || [],
      companyName: locationsData.companyName,
      ShippingAddressProvince: provincesData,
    });

  } catch (error) {
    console.error("Loader error:", error);

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
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

    requirePermission(
      userContext,
      "canManageLocations",
      "You do not have permission to manage locations. Only Company Admins and Main Contacts can create, edit, or delete locations.",
    );

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    const body = await request.json();
    console.log("🚀 ~ action ~ body:", body);
    const { action: actionType } = body;

    switch (actionType) {
      case "create": {
        const {
          name,
          externalId,
          country,
          firstName,
          lastName,
          address1,
          address2,
          city,
          province,
          zip,
          phone,
          recipient,
          billingSameAsShipping,
        } = body;

        const validations = [
          { field: "name", value: name, message: "Location name is required" },
          { field: "firstName", value: firstName, message: "First name is required" },
          { field: "lastName", value: lastName, message: "Last name is required" },
          { field: "address1", value: address1, message: "Street address is required" },
          { field: "city", value: city, message: "City is required" },
          { field: "province", value: province, message: "Province/State is required" },
          { field: "country", value: country, message: "Country is required" },
          { field: "zip", value: zip, message: "Zip/Postal code is required" },
        ];

        for (const v of validations) {
          if (!v.value || v.value.toString().trim() === "") {
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

        const phoneValue = phone && phone.trim() !== "" ? phone : "";

        const result = await createLocationAndAssignToContact(
          companyId,
          `gid://shopify/Customer/${userContext.customerId}`,
          shop,
          store.accessToken,
          {
            name: name || "",
            externalId: externalId || "",
            country: country || "IN",
            firstName: firstName?.trim() || "",
            lastName: lastName?.trim() || "",
            address1: address1 || "",
            address2: address2 || "",
            city: city || "",
            province: province || "GJ",
            zip: zip || "",
            phone: phoneValue,
            recipient: recipient || "",
            billingSameAsShipping: billingSameAsShipping,
          },
        );

        if (result.error) {
          return Response.json(
            {
              error: result.error,
              details: result.details,
            },
            { status: 400 },
          );
        }

        return Response.json({ success: true, locationId: result.locationId });
      }

      case "edit": {
        const {
          locationId,
          name,
          externalId,
          country,
          firstName,
          lastName,
          address1,
          address2,
          city,
          province,
          zip,
          phone,
          recipient,
          billingSameAsShipping,
        } = body;

        if (!locationId) {
          return Response.json(
            { error: "Location ID is required for editing" },
            { status: 400 },
          );
        }

        let phoneValue: string | null | undefined = undefined;

        if (phone !== undefined) {
          if (phone === "") {
            phoneValue = null;
          } else {
            phoneValue = phone;
          }
        }

        let externalIdValue: string | null | undefined = undefined;

        if (externalId !== undefined) {
          if (externalId === "") {
            externalIdValue = null;
          } else {
            externalIdValue = externalId;
          }
        }

        let recipientValue: string | null | undefined = undefined;

        if (recipient !== undefined) {
          if (recipient === "") {
            recipientValue = null;
          } else {
            recipientValue = recipient;
          }
        }

        const result = await updateCompanyLocation(
          locationId,
          shop,
          store.accessToken,
          {
            name: name || undefined,
            externalId: externalIdValue,
            country: country || undefined,
            firstName: firstName?.trim() || undefined,
            lastName: lastName?.trim() || undefined,
            address1: address1 || undefined,
            address2: address2 || undefined,
            city: city || undefined,
            province: province || undefined,
            zip: zip || undefined,
            phone: phoneValue,
            recipient: recipientValue,
            billingSameAsShipping: billingSameAsShipping || undefined,
          },
        );

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

        const orderCheck = await checkLocationHasOrders(
          locationId,
          shop,
          store.accessToken,
        );

        if (orderCheck.error) {
          return Response.json(
            { error: orderCheck.message || "Failed to verify location status" },
            { status: 500 },
          );
        }

        if (orderCheck.hasOrders) {
          const errorMessage = `Cannot delete location "${orderCheck.locationName}". This location has ${orderCheck.ordersCount} order(s) are existing.`;

          return Response.json(
            {
              error: errorMessage,
              ordersCount: orderCheck.ordersCount,
              totalSpent: orderCheck.totalSpent
            },
            { status: 400 },
          );
        }

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

        const isUserAssignedToLocation =
          userContext?.customerEmail &&
          userCheck?.assignedEmails?.includes(userContext.customerEmail);

        const canDelete =
          !userCheck.hasUsers ||
          (userContext?.isMainContact === true &&
            isUserAssignedToLocation &&
            userCheck.userCount === 1);

        if (!canDelete) {
          return Response.json(
            {
              error: `Cannot delete location "${userCheck.locationName}". It has ${userCheck.userCount} assigned user(s). Please unassign all users before deleting.`,
              assignedUsers: userCheck.userCount,
            },
            { status: 400 },
          );
        }

        const result = await deleteCompanyLocation(
          locationId,
          shop,
          store.accessToken,
        );

        if (result.error) {
          return Response.json(
            {
              error: result.error.message || result.error,
              type: result.error.type || "DELETE_FAILED",
            },
            { status: 400 },
          );
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