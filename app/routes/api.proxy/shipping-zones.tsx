import type { LoaderFunctionArgs } from "react-router";
import prisma from "app/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // ── 1. Get stored access token for this shop ──────────────────────────
  const session = await prisma.session.findFirst({
    where: { shop },
  });

  if (!session?.accessToken) {
    return Response.json({ error: "No session found for shop" }, { status: 401 });
  }

  // ── 2. Call Admin GraphQL directly with the token ─────────────────────
  const graphqlRes = await fetch(
  `https://${shop}/admin/api/2024-10/graphql.json`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `
        query GetShippingCountriesWithProvinces {
          # ✅ Source of truth — ALL country codes in shipping zones
          shop {
            countriesInShippingZones {
              countryCodes
              includeRestOfWorld
            }
          }
          # Used only to get names + provinces
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

const json = await graphqlRes.json();
console.log(json,"<--- GraphQL response");

if (json.errors) {
  return Response.json({ errors: json.errors }, { status: 500 });
}

// ── Step 1: Get ALL valid country codes from shop ─────────────────────
const shippingZoneData = json.data?.shop?.countriesInShippingZones;
const validCountryCodes = new Set<string>(shippingZoneData?.countryCodes || []);
const includeRestOfWorld = shippingZoneData?.includeRestOfWorld ?? false;

console.log("Total shipping zone countries:", validCountryCodes.size);
console.log("Includes Rest of World:", includeRestOfWorld);
console.log("Country codes:", [...validCountryCodes]);

// ── Step 2: Build map from delivery profiles (names + provinces) ──────
const countriesMap = new Map<string, {
  value: string;
  label: string;
  provinces: { value: string; label: string }[];
}>();

for (const profile of json.data?.deliveryProfiles?.nodes || []) {
  for (const group of profile.profileLocationGroups || []) {
    for (const zoneNode of group.locationGroupZones?.nodes || []) {
      for (const country of zoneNode.zone?.countries || []) {
        const countryCode = country.code?.countryCode;
        if (!countryCode) continue;

        const provinces = (country.provinces || []).map(
          (p: { code: string; name: string }) => ({
            value: p.code,
            label: p.name,
          })
        );

        if (countriesMap.has(countryCode)) {
          const existing = countriesMap.get(countryCode)!;
          const existingCodes = new Set(existing.provinces.map(p => p.value));
          for (const p of provinces) {
            if (!existingCodes.has(p.value)) existing.provinces.push(p);
          }
        } else {
          countriesMap.set(countryCode, {
            value: countryCode,
            label: country.name,
            provinces,
          });
        }
      }
    }
  }
}

// ── Step 3: Add any missing countries from validCountryCodes ──────────
// (codes in shipping zones but not found in delivery profile details)
for (const code of validCountryCodes) {
  if (!countriesMap.has(code)) {
    countriesMap.set(code, {
      value: code,
      label: code,       // fallback: use code as label
      provinces: [],
    });
  }
}

// ── Step 4: Filter to ONLY valid shipping zone countries ──────────────
const countries = Array.from(countriesMap.values())
  .filter(c => validCountryCodes.has(c.value))   // ✅ strict filter
  .sort((a, b) => a.label.localeCompare(b.label));

return Response.json(
  { countries, total: countries.length },
  { headers: { "Access-Control-Allow-Origin": "*" } }
);
};
