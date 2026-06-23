export type DeliveryDetails = {
  locationName: string | null;
  addressLines: string[];
  phone: string | null;
  source: "shipping_address" | "company_location" | "none";
};

type ShopifyAddress = {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  zip?: string | null;
  phone?: string | null;
};

type DeliveryRecord = {
  id?: string | null;
  shopifyOrderId?: string | null;
  orderStatus?: string | null;
  customerId?: string | null;
  customerShopifyId?: string | null;
  company?: {
    shopifyCompanyId?: string | null;
    shop?: {
      shopDomain?: string | null;
      accessToken?: string | null;
    } | null;
  } | null;
};

const EMPTY_DELIVERY_DETAILS: DeliveryDetails = {
  locationName: null,
  addressLines: [],
  phone: null,
  source: "none",
};

export async function getDeliveryDetailsForRecord(
  record: DeliveryRecord,
): Promise<DeliveryDetails> {
  const shopDomain = record.company?.shop?.shopDomain;
  const accessToken = record.company?.shop?.accessToken;
  const shopifyOrder = normalizeShopifyOrderId(record);

  if (!shopDomain || !accessToken || !shopifyOrder) {
    return getCompanyLocationDeliveryDetails(record, EMPTY_DELIVERY_DETAILS);
  }

  try {
    const orderQuery = `
      query GetDeliveryDetails($id: ID!) {
        node(id: $id) {
          ... on Order {
            shippingAddress {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              country
              zip
              phone
            }
            purchasingEntity {
              ... on PurchasingCompany {
                location {
                  id
                  name
                }
              }
            }
            customAttributes {
              key
              value
            }
          }
        }
      }
    `;
    const response = await fetch(
      `https://${shopDomain}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: orderQuery,
          variables: { id: shopifyOrder.id },
        }),
      },
    );
    const payload = await response.json();
    if (payload.errors?.length) {
      console.warn("[delivery-details] order lookup failed", {
        recordId: record.id,
        errors: payload.errors,
      });
      return getCompanyLocationDeliveryDetails(
        record,
        EMPTY_DELIVERY_DETAILS,
      );
    }

    const order = payload.data?.node;
    const purchasingLocation = order?.purchasingEntity?.location || null;
    const customLocationName =
      order?.customAttributes?.find(
        (attribute: { key?: string }) => attribute.key === "Delivery Location",
      )?.value || null;
    const locationName =
      purchasingLocation?.name || customLocationName || null;
    const shippingLines = formatAddressLines(
      order?.shippingAddress,
      locationName,
    );
    if (shippingLines.length > 0) {
      return {
        locationName,
        addressLines: shippingLines,
        phone: order.shippingAddress?.phone || null,
        source: "shipping_address",
      };
    }

    if (purchasingLocation?.id) {
      const locationDetails = await getCompanyLocationById(record, {
        id: purchasingLocation.id,
        name: locationName,
      });
      if (locationDetails.addressLines.length > 0) return locationDetails;
    }

    return getCompanyLocationDeliveryDetails(record, {
      ...EMPTY_DELIVERY_DETAILS,
      locationName,
    });
  } catch (error) {
    console.error("[delivery-details] order lookup unavailable", {
      recordId: record.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return getCompanyLocationDeliveryDetails(record, EMPTY_DELIVERY_DETAILS);
  }
}

async function getCompanyLocationById(
  record: DeliveryRecord,
  locationRef: { id: string; name?: string | null },
): Promise<DeliveryDetails> {
  const shopDomain = record.company?.shop?.shopDomain;
  const accessToken = record.company?.shop?.accessToken;
  if (!shopDomain || !accessToken) return EMPTY_DELIVERY_DETAILS;

  const query = `
    query GetDeliveryLocationAddress($id: ID!) {
      companyLocation(id: $id) {
        id
        name
        phone
        shippingAddress {
          address1
          address2
          city
          province
          country
          zip
          phone
        }
      }
    }
  `;
  const response = await fetch(
    `https://${shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { id: locationRef.id },
      }),
    },
  );
  const payload = await response.json();
  if (payload.errors?.length) {
    console.warn("[delivery-details] location lookup failed", {
      recordId: record.id,
      locationId: locationRef.id,
      errors: payload.errors,
    });
    return EMPTY_DELIVERY_DETAILS;
  }

  const location = payload.data?.companyLocation;
  const addressLines = formatAddressLines(
    location?.shippingAddress,
    location?.name || locationRef.name,
  );
  return {
    locationName: location?.name || locationRef.name || null,
    addressLines,
    phone: location?.shippingAddress?.phone || location?.phone || null,
    source: addressLines.length > 0 ? "company_location" : "none",
  };
}

async function getCompanyLocationDeliveryDetails(
  record: DeliveryRecord,
  fallback: DeliveryDetails,
): Promise<DeliveryDetails> {
  const shopDomain = record.company?.shop?.shopDomain;
  const accessToken = record.company?.shop?.accessToken;
  const shopifyCompanyId = record.company?.shopifyCompanyId;

  if (!shopDomain || !accessToken || !shopifyCompanyId) {
    return fallback;
  }

  try {
    const query = `
      query GetDeliveryCompanyLocations($companyId: ID!) {
        company(id: $companyId) {
          locations(first: 50) {
            nodes {
              id
              name
              phone
              shippingAddress {
                address1
                address2
                city
                province
                country
                zip
                phone
              }
            }
          }
          contacts(first: 50) {
            edges {
              node {
                customer {
                  id
                }
                roleAssignments(first: 5) {
                  edges {
                    node {
                      companyLocation {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const response = await fetch(
      `https://${shopDomain}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { companyId: shopifyCompanyId },
        }),
      },
    );
    const payload = await response.json();
    if (payload.errors?.length) {
      console.warn("[delivery-details] company location fallback failed", {
        recordId: record.id,
        errors: payload.errors,
      });
      return fallback;
    }

    const locations = payload.data?.company?.locations?.nodes || [];
    const contacts = payload.data?.company?.contacts?.edges || [];
    const customerGid = normalizeCustomerGid(
      record.customerShopifyId || record.customerId,
    );
    const assignedLocationId = customerGid
      ? contacts
          .find((edge: any) => edge.node?.customer?.id === customerGid)
          ?.node?.roleAssignments?.edges?.[0]?.node?.companyLocation?.id
      : null;
    const namedLocation = fallback.locationName
      ? locations.find(
          (location: any) =>
            location.name?.toLowerCase() ===
            fallback.locationName?.toLowerCase(),
        )
      : null;
    const location =
      locations.find((item: any) => item.id === assignedLocationId) ||
      namedLocation ||
      (locations.length === 1 ? locations[0] : null);

    if (!location) return fallback;

    const addressLines = formatAddressLines(
      location.shippingAddress,
      location.name,
    );
    return {
      locationName: location.name || fallback.locationName,
      addressLines:
        addressLines.length > 0 ? addressLines : fallback.addressLines,
      phone:
        location.shippingAddress?.phone ||
        location.phone ||
        fallback.phone ||
        null,
      source:
        addressLines.length > 0 ? "company_location" : fallback.source,
    };
  } catch (error) {
    console.error("[delivery-details] company location fallback unavailable", {
      recordId: record.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function normalizeShopifyOrderId(record: DeliveryRecord) {
  const rawId = String(record.shopifyOrderId || "").trim();
  if (!rawId) return null;
  if (rawId.startsWith("gid://shopify/Order/")) return { id: rawId };
  if (rawId.startsWith("gid://shopify/DraftOrder/")) return { id: rawId };
  if (/^\d+$/.test(rawId)) {
    const resource = record.orderStatus === "draft" ? "DraftOrder" : "Order";
    return { id: `gid://shopify/${resource}/${rawId}` };
  }
  return null;
}

function normalizeCustomerGid(customerId?: string | null) {
  const rawId = String(customerId || "").trim();
  if (!rawId) return null;
  if (rawId.startsWith("gid://shopify/Customer/")) return rawId;
  if (/^\d+$/.test(rawId)) return `gid://shopify/Customer/${rawId}`;
  return null;
}

function formatAddressLines(
  address?: ShopifyAddress | null,
  locationName?: string | null,
) {
  if (!address) return [];
  const recipient = [address.firstName, address.lastName]
    .filter(Boolean)
    .join(" ");
  const cityLine = [address.city, address.province, address.zip]
    .filter(Boolean)
    .join(", ");
  const lines = [
    recipient,
    address.company || locationName,
    address.address1,
    address.address2,
    cityLine,
    address.country,
  ];
  return Array.from(
    new Set(lines.map((line) => String(line || "").trim()).filter(Boolean)),
  );
}
