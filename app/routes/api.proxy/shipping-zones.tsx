import type { LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "app/shopify.server";
import { authenticateCustomerAccountSession } from "app/utils/customer-account-session.server";

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, init: ResponseInit = {}, request?: Request) {
  const corsHeaders = request ? getCorsHeaders(request) : {};
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers ?? {}),
    },
  });
}

type ShippingZonesPayload = {
  errors?: unknown;
  data?: {
    shop?: {
      countriesInShippingZones?: {
        countryCodes?: string[];
        includeRestOfWorld?: boolean;
      } | null;
    } | null;
    deliveryProfiles?: {
      nodes?: Array<{
        profileLocationGroups?: Array<{
          locationGroupZones?: {
            nodes?: Array<{
              zone?: {
                countries?: Array<{
                  code?: { countryCode?: string | null } | null;
                  name?: string | null;
                  provinces?: Array<{ code: string; name: string }>;
                }>;
              } | null;
            }>;
          } | null;
        }>;
      }>;
    } | null;
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  const respond = (data: unknown, init: ResponseInit = {}) =>
    json(data, init, request);

  try {
    const { shop } = await authenticateCustomerAccountSession(request, {
      requireCustomer: false,
    });

    const { admin } = await unauthenticated.admin(shop);

    const response = await admin.graphql(
      `#graphql
      query GetShippingCountriesWithProvinces {
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
      `
    );

    const payload = (await response.json()) as ShippingZonesPayload;

    if (!response.ok) {
      return respond(
        {
          error: "Shopify Admin API request failed",
          status: response.status,
          details: payload?.errors ?? payload,
        },
        { status: response.status }
      );
    }

    if (payload.errors) {
      return respond({ errors: payload.errors }, { status: 500 });
    }

    const shippingZoneData = payload.data?.shop?.countriesInShippingZones;
    const validCountryCodes = new Set<string>(
      shippingZoneData?.countryCodes || []
    );
    const includeRestOfWorld = shippingZoneData?.includeRestOfWorld ?? false;

    console.log("Total shipping zone countries:", validCountryCodes.size);
    console.log("Includes Rest of World:", includeRestOfWorld);
    console.log("Country codes:", [...validCountryCodes]);

    const countriesMap = new Map<string, {
      value: string;
      label: string;
      provinces: { value: string; label: string }[];
    }>();

    for (const profile of payload.data?.deliveryProfiles?.nodes || []) {
      for (const group of profile.profileLocationGroups || []) {
        for (const zoneNode of group.locationGroupZones?.nodes || []) {
          for (const country of zoneNode.zone?.countries || []) {
            const countryCode = country.code?.countryCode;
            if (!countryCode) continue;

            const provinces = (country.provinces || []).map(
              (province: { code: string; name: string }) => ({
                value: province.code,
                label: province.name,
              })
            );

            if (countriesMap.has(countryCode)) {
              const existing = countriesMap.get(countryCode)!;
              const existingCodes = new Set(
                existing.provinces.map((province) => province.value)
              );
              for (const province of provinces) {
                if (!existingCodes.has(province.value)) {
                  existing.provinces.push(province);
                }
              }
            } else {
              countriesMap.set(countryCode, {
                value: countryCode,
                label: country.name ?? countryCode,
                provinces,
              });
            }
          }
        }
      }
    }

    for (const code of validCountryCodes) {
      if (!countriesMap.has(code)) {
        countriesMap.set(code, {
          value: code,
          label: code,
          provinces: [],
        });
      }
    }

    const countries = Array.from(countriesMap.values())
      .filter((country) => validCountryCodes.has(country.value))
      .sort((a, b) => a.label.localeCompare(b.label));

    return respond({ countries, total: countries.length });
  } catch (error) {
    if (error instanceof Response) {
      return respond(
        { error: error.statusText || "Unauthorized" },
        { status: error.status || 401 }
      );
    }

    console.error("❌ Error fetching shipping zones:", error);
    return respond(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
