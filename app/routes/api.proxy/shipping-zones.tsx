import type { LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "app/shopify.server";
import prisma from "app/db.server";
import { authenticateCustomerAccountSession } from "app/utils/customer-account-session.server";
import { getDialCodeForCountry } from "app/utils/company-create-form";
import {
  validateSalesSession,
  getSessionTokenFromCookie,
} from "app/utils/sales-session.server";

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

type MarketsPayload = {
  errors?: unknown;
  data?: {
    markets?: {
      nodes?: Array<{
        regions?: {
          nodes?: Array<{
            name?: string | null;
            code?: string | null;
          }>;
        } | null;
      }>;
    } | null;
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    let shop = "";

    try {
      const customerSession = await authenticateCustomerAccountSession(request, {
        requireCustomer: false,
      });
      shop = customerSession.shop;
    } catch (customerAuthError) {
      const salesSession = await validateSalesSession(
        getSessionTokenFromCookie(request),
      );

      if (!salesSession.valid || !salesSession.user.shopId) {
        throw customerAuthError;
      }

      const store = await prisma.store.findUnique({
        where: { id: salesSession.user.shopId },
        select: { shopDomain: true },
      });

      if (!store?.shopDomain) {
        throw new Response("Missing shop for sales session", {
          status: 401,
          statusText: "Unauthorized",
        });
      }

      shop = store.shopDomain;
    }

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
      return Response.json(
        {
          error: "Shopify Admin API request failed",
          status: response.status,
          details: payload?.errors ?? payload,
        },
        { status: response.status }
      );
    }

    if (payload.errors) {
      return Response.json({ errors: payload.errors }, { status: 500 });
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
      dialCode: string;
      provinces: { value: string; label: string }[];
    }>();

    const upsertCountry = (
      countryCode: string,
      label: string | null | undefined,
      provinces: { value: string; label: string }[] = [],
    ) => {
      if (countriesMap.has(countryCode)) {
        const existing = countriesMap.get(countryCode)!;
        if (label && existing.label === countryCode) {
          existing.label = label;
        }

        const existingCodes = new Set(
          existing.provinces.map((province) => province.value)
        );
        for (const province of provinces) {
          if (!existingCodes.has(province.value)) {
            existing.provinces.push(province);
          }
        }
        return;
      }

      countriesMap.set(countryCode, {
        value: countryCode,
        label: label ?? countryCode,
        dialCode: getDialCodeForCountry(countryCode),
        provinces,
      });
    };

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

            upsertCountry(countryCode, country.name, provinces);
          }
        }
      }
    }

    for (const code of validCountryCodes) {
      if (!countriesMap.has(code)) {
        upsertCountry(code, code);
      }
    }

    let marketCountryCodes: Set<string> | null = null;
    try {
      const marketsResponse = await admin.graphql(
        `#graphql
        query GetMarketCountries {
          markets(first: 250) {
            nodes {
              regions(first: 250) {
                nodes {
                  name
                  ... on MarketRegionCountry {
                    code
                  }
                }
              }
            }
          }
        }
        `
      );
      const marketsPayload = (await marketsResponse.json()) as MarketsPayload;

      if (marketsResponse.ok && !marketsPayload.errors) {
        marketCountryCodes = new Set<string>();

        for (const market of marketsPayload.data?.markets?.nodes || []) {
          for (const region of market.regions?.nodes || []) {
            if (!region.code) continue;

            marketCountryCodes.add(region.code);
            upsertCountry(region.code, region.name);
          }
        }
      } else {
        console.warn("Unable to load Shopify Markets countries:", {
          status: marketsResponse.status,
          errors: marketsPayload.errors,
        });
      }
    } catch (marketsError) {
      console.warn("Unable to load Shopify Markets countries:", marketsError);
    }

    const countries = Array.from(countriesMap.values())
      .filter(
        (country) =>
          marketCountryCodes?.size
            ? marketCountryCodes.has(country.value)
            : validCountryCodes.size === 0 || validCountryCodes.has(country.value),
      )
      .sort((a, b) => a.label.localeCompare(b.label));

    return Response.json({ countries, total: countries.length });
  } catch (error) {
    if (error instanceof Response) {
      return Response.json(
        { error: error.statusText || "Unauthorized" },
        { status: error.status || 401 }
      );
    }

    console.error("❌ Error fetching shipping zones:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
