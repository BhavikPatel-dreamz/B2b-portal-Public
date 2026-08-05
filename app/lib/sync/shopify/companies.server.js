import { companyNameKey } from "../mapping.js";
import { gqlError } from "./tracking.server.js";

// B2B company location resolution
// ---------------------------------------------------------------------------
// A NetSuite order that carries custbody_ava_customercompanyname belongs to a
// B2B company, and the Shopify order has to be attached to that company's
// location (orderCreate's companyLocationId) for the buyer to see it in their
// company account and for company pricing/terms to apply.
//
// The chain is: NetSuite company name + customer email
//   -> Shopify customer (by email)
//   -> the company named after the NetSuite company    (created if missing)
//   -> the customer as a contact of that company       (created if missing)
//   -> that company's location of the same name        (created if missing)
//   -> a role for the contact at that location         (assigned if missing)
//
// The last two links are not optional decoration: orderCreate rejects a company
// order outright with "no customer_id was provided" unless the customer is named
// by id, and with "the customer has no role in this company" unless that customer
// holds a role at the location.
//
// One Shopify rule shapes the whole thing: a customer can be the contact of
// exactly ONE company. So a customer already attached to a different company is
// where this stops — it cannot be shared or moved, and the order says so instead
// of creating a company nobody can be a contact of.
//
// Otherwise nothing along the way is a dead end: a missing company, contact,
// location or role is created and the chain carries on. The NetSuite company NAME is the authority
// throughout — the customer's other companies are never substituted for it,
// because attaching an order to the wrong company would show one buyer another
// company's order. What does stop the create is a name that can't be resolved to
// exactly one company (an unusable email, or duplicate companies already sharing
// the name); the caller then reports the order as failed rather than dropping the
// company link, since a B2B order created without one is invisible to the buyer
// and impossible to spot afterwards.
//
// Results are cached per run (keyed on email + company name) because a sync
// window normally holds many orders for the same handful of companies, and
// without it two orders for a new company would each create it.
export async function resolveCompanyLocationId(admin, entry, cache) {
  const key = `${companyNameKey(entry.customer?.email)}|${companyNameKey(entry.companyName)}`;
  if (cache?.has(key)) return cache.get(key);
  const resolved = await lookupCompanyLocation(admin, entry);
  // Failures are cached too: the chain is deterministic within a run, so the
  // remaining orders for the same company fail fast instead of re-asking Shopify
  // the same question. `created` is emptied on the cached copy — it describes
  // what THIS order's lookup made, and the orders behind it made nothing.
  cache?.set(key, resolved.companyLocationId ? { ...resolved, created: [] } : resolved);
  return resolved;
}

// Returns { companyId, companyName, companyLocationId, locationName, customerId,
// created } on success — `created` lists whatever this call had to make
// ("company", "contact", "location", "role") — or { error } describing what
// stopped it.
export async function lookupCompanyLocation(admin, entry) {
  const wantedName = entry.companyName;
  const wantedKey = companyNameKey(wantedName);
  // Note: this is the same email the order is created with, so TEST_EMAIL
  // redirects the company lookup to the test customer too (see mapNetsuiteOrder).
  const email = entry.customer?.email;
  // The email is the one thing that can't be conjured: it's how the buyer is
  // identified as this company's contact.
  if (!email) {
    return { error: "the NetSuite order has no customer email, so no company contact can be identified" };
  }

  // The customer may not exist yet, in which case the contact mutations below
  // create one from these details.
  const customer = await fetchCustomerCompanyContacts(admin, email);
  const profiles = (customer?.companyContactProfiles || []).filter((p) => p?.company?.id);
  const created = [];
  let customerId = customer?.id || null;
  let contactId = null;
  let company = null;
  let locations = null;

  // 1. Already a contact of a company with this name — the common case, no writes.
  const profile = profiles.find((p) => companyNameKey(p.company.name) === wantedKey);
  if (profile) {
    company = profile.company;
    contactId = profile.id;
  } else if (profiles.length) {
    // Shopify allows a customer exactly ONE company: companyAssignCustomerAsContact
    // and companyContactCreate both refuse with "Customer is already associated with
    // a company contact". So a customer attached to a different company cannot be
    // used for this order, and checking here rather than after the create is what
    // matters — creating the company first left an orphan company (with a location,
    // and no contact) behind on every attempt.
    const held = profiles.map((p) => `"${p.company.name}"`).join(", ");
    return {
      error: `Shopify customer ${email} is already the contact of ${held}, and Shopify allows a customer only one company — this order names "${wantedName}". Point the order at that company's own contact email, or fix the customer's company in Shopify.`,
    };
  }

  // 2. The company exists on the shop but this customer isn't one of its contacts
  //    yet (a first order from a new buyer at a company we already know).
  if (!company) {
    const found = await findCompanyByName(admin, wantedName);
    if (found.error) return { error: found.error };
    if (found.company) {
      company = found.company;
      locations = company.locations?.nodes || null;
      const contact = customerId
        ? await assignCustomerAsContact(admin, company.id, customerId)
        : await createCompanyContact(admin, company.id, entry, email);
      if (contact.error) {
        return { error: `adding ${email} as a contact of company "${company.name}" failed: ${contact.error}` };
      }
      contactId = contact.companyContactId;
      customerId = customerId || contact.customerId;
      created.push("contact");
    }
  }

  // 3. No such company anywhere — create it, with its location and (when the
  //    customer doesn't exist yet) its contact in the same call.
  if (!company) {
    const made = await createCompanyWithLocation(admin, entry, customerId ? null : email);
    if (made.error) return { error: `companyCreate for "${wantedName}" failed: ${made.error}` };
    created.push("company", "location", "contact");
    // companyCreate only takes contact DETAILS, not an existing customer id, so
    // an existing customer is attached afterwards. A brand-new one was created by
    // companyCreate itself from the details passed above.
    if (customerId) {
      const assigned = await assignCustomerAsContact(admin, made.companyId, customerId);
      if (assigned.error) {
        return { error: `assigning ${email} as a contact of new company "${wantedName}" failed: ${assigned.error}` };
      }
      contactId = assigned.companyContactId;
    } else {
      contactId = made.companyContactId;
      customerId = made.customerId;
    }
    console.log(
      `[order-sync] created company "${wantedName}" (${made.companyId}) with location ${made.locationId} for ${email}.`,
    );
    const role = await ensureContactRole(admin, made.companyId, contactId, made.locationId);
    if (role.error) return { error: role.error };
    if (role.assigned) created.push("role");
    return {
      companyId: made.companyId,
      companyName: wantedName,
      companyLocationId: made.locationId,
      locationName: made.locationName,
      customerId,
      companyContactId: contactId,
      created,
    };
  }

  // The company was already there; find or add the location named after it.
  if (!locations) locations = await fetchCompanyLocations(admin, company.id);
  let location = locations.find((l) => companyNameKey(l.name) === wantedKey) || null;
  if (!location) {
    const made = await createCompanyLocation(admin, company.id, entry);
    if (made.error) {
      return { error: `companyLocationCreate on company "${company.name}" failed: ${made.error}` };
    }
    location = made;
    created.push("location");
    console.log(
      `[order-sync] created company location "${made.name}" (${made.id}) on company "${company.name}".`,
    );
  }

  const role = await ensureContactRole(admin, company.id, contactId, location.id);
  if (role.error) return { error: role.error };
  if (role.assigned) created.push("role");

  return {
    companyId: company.id,
    companyName: company.name,
    companyLocationId: location.id,
    locationName: location.name,
    customerId,
    companyContactId: contactId,
    created,
  };
}

// Gives the contact a role at the location when it doesn't have one. Shopify
// rejects a company order from a contact with no role there, so this is part of
// the chain rather than a nicety. Already-assigned is the normal case and costs
// one read.
async function ensureContactRole(admin, companyId, companyContactId, companyLocationId) {
  if (!companyContactId) {
    return { error: `no company contact to give a role at location ${companyLocationId}` };
  }
  const resp = await admin.graphql(
    `#graphql
    query CompanyContactRoles($companyId: ID!, $companyContactId: ID!) {
      company(id: $companyId) {
        contactRoles(first: 10) { nodes { id name } }
      }
      companyContact(id: $companyContactId) {
        roleAssignments(first: 250) {
          nodes { id companyLocation { id } role { id name } }
          pageInfo { hasNextPage }
        }
      }
    }`,
    { variables: { companyId, companyContactId } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body));
  const roleAssignments = body?.data?.companyContact?.roleAssignments;
  const assignments = roleAssignments?.nodes || [];
  const existing = assignments.find((a) => a?.companyLocation?.id === companyLocationId);
  if (existing) return { assigned: false, role: existing.role?.name || null };
  // An existing assignment past the first page would look missing here and be
  // assigned again, which Shopify rejects — and that would block the order. A
  // contact with 250+ locations is not a shape this account has, so it's reported
  // rather than paged.
  if (roleAssignments?.pageInfo?.hasNextPage) {
    console.warn(
      `[order-sync] contact ${companyContactId} has more than 250 role assignments — the check for an existing role at ${companyLocationId} used a partial list.`,
    );
  }

  // Ordering is the whole point of the assignment, so the ordering role is
  // preferred over the admin one when the shop has both; a shop that has renamed
  // its roles still gets the first one rather than no role at all.
  const roles = body?.data?.company?.contactRoles?.nodes || [];
  const role = roles.find((r) => /ordering/i.test(r.name)) || roles.find((r) => /admin/i.test(r.name)) || roles[0];
  if (!role?.id) return { error: `company ${companyId} has no contact roles to assign` };

  const assignResp = await admin.graphql(
    `#graphql
    mutation CompanyContactAssignRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
      companyContactAssignRole(companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId, companyLocationId: $companyLocationId) {
        companyContactRoleAssignment { id role { name } }
        userErrors { field message }
      }
    }`,
    { variables: { companyContactId, companyContactRoleId: role.id, companyLocationId } },
  );
  const assignBody = await assignResp.json();
  const payload = assignBody?.data?.companyContactAssignRole;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyContactRoleAssignment?.id) {
    return { error: `assigning the "${role.name}" role at location ${companyLocationId} failed: ${gqlError(assignBody, errors)}` };
  }
  console.log(`[order-sync] assigned role "${role.name}" to contact ${companyContactId} at location ${companyLocationId}.`);
  return { assigned: true, role: role.name };
}

// Creates the contact (and its customer) on a company that already exists.
// Returns { companyContactId, customerId } or { error }.
async function createCompanyContact(admin, companyId, entry, email) {
  const resp = await admin.graphql(
    `#graphql
    mutation CompanyContactCreate($companyId: ID!, $input: CompanyContactInput!) {
      companyContactCreate(companyId: $companyId, input: $input) {
        companyContact { id customer { id } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        companyId,
        input: {
          email,
          ...(entry.customer?.firstName ? { firstName: entry.customer.firstName } : {}),
          ...(entry.customer?.lastName ? { lastName: entry.customer.lastName } : {}),
        },
      },
    },
  );
  const body = await resp.json();
  const payload = body?.data?.companyContactCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyContact?.id) return { error: gqlError(body, errors) };
  return {
    companyContactId: payload.companyContact.id,
    customerId: payload.companyContact.customer?.id || null,
  };
}

// Finds the shop's company of this exact name. Search is only used to narrow the
// list — the decision is an exact name match on the results, because Shopify's
// search is fuzzy enough to return neighbours ("Amentum - Intel" for "Amentum -
// PAE") and those are different companies. Returns { company } (null when there
// is none) or { error }.
//
// A name Shopify's search can't be asked about cleanly (embedded quotes) is
// dropped from the term rather than escaped, so the worst case is a miss —
// which creates a company instead of reusing one.
async function findCompanyByName(admin, name) {
  const term = String(name).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!term) return { company: null };
  const resp = await admin.graphql(
    `#graphql
    query CompaniesByName($query: String!) {
      companies(first: 50, query: $query) {
        nodes {
          id
          name
          locations(first: 250) {
            nodes { id name }
            pageInfo { hasNextPage }
          }
        }
      }
    }`,
    { variables: { query: `name:"${term}"` } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body));
  const wantedKey = companyNameKey(name);
  const exact = (body?.data?.companies?.nodes || []).filter((c) => companyNameKey(c.name) === wantedKey);
  if (exact.length > 1) {
    return { error: `the shop has ${exact.length} companies named "${name}" — refusing to guess which one the order belongs to` };
  }
  // Only the first page of locations came back with the search. Dropping the
  // list makes the caller re-fetch it properly (paged) rather than match against
  // a truncated one.
  const company = exact[0] || null;
  if (company?.locations?.pageInfo?.hasNextPage) delete company.locations;
  return { company };
}

// Creates the company, its first location (named after the company, so the
// location match downstream is satisfied) and — when `contactEmail` is given,
// i.e. no Shopify customer exists yet — the contact and its customer record.
// Returns { companyId, locationId, locationName } or { error }.
async function createCompanyWithLocation(admin, entry, contactEmail) {
  const input = {
    company: { name: entry.companyName },
    companyLocation: companyLocationInput(entry),
  };
  if (contactEmail) {
    input.companyContact = {
      email: contactEmail,
      ...(entry.customer?.firstName ? { firstName: entry.customer.firstName } : {}),
      ...(entry.customer?.lastName ? { lastName: entry.customer.lastName } : {}),
    };
  }

  const resp = await admin.graphql(
    `#graphql
    mutation CompanyCreate($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          mainContact { id customer { id } }
          contacts(first: 5) { nodes { id customer { id defaultEmailAddress { emailAddress } } } }
          locations(first: 5) { nodes { id name } }
        }
        userErrors { field message }
      }
    }`,
    { variables: { input } },
  );
  const body = await resp.json();
  const payload = body?.data?.companyCreate;
  const errors = payload?.userErrors || [];
  const company = payload?.company;
  if (errors.length || !company?.id) return { error: gqlError(body, errors) };

  const wantedKey = companyNameKey(entry.companyName);
  const nodes = company.locations?.nodes || [];
  const location = nodes.find((l) => companyNameKey(l.name) === wantedKey) || nodes[0];
  if (!location?.id) {
    return { error: `company ${company.id} was created without a location` };
  }
  // The contact companyCreate made from the contact details, when it was given
  // any. orderCreate needs its customer id (see buildOrderInput) and the contact
  // needs a role at the location (see ensureContactRole), so it is read back from
  // the contact list as well as mainContact — a company whose new contact didn't
  // become the main one would otherwise stall the chain here.
  const contact = contactEmail
    ? company.mainContact
    || (company.contacts?.nodes || []).find(
      (c) => companyNameKey(c?.customer?.defaultEmailAddress?.emailAddress) === companyNameKey(contactEmail),
    )
    : null;
  return {
    companyId: company.id,
    locationId: location.id,
    locationName: location.name,
    companyContactId: contact?.id || null,
    customerId: contact?.customer?.id || null,
  };
}

async function assignCustomerAsContact(admin, companyId, customerId) {
  const resp = await admin.graphql(
    `#graphql
    mutation CompanyAssignCustomerAsContact($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact { id }
        userErrors { field message }
      }
    }`,
    { variables: { companyId, customerId } },
  );
  const body = await resp.json();
  const payload = body?.data?.companyAssignCustomerAsContact;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyContact?.id) return { error: gqlError(body, errors) };
  return { companyContactId: payload.companyContact.id };
}

async function fetchCustomerCompanyContacts(admin, email) {
  const resp = await admin.graphql(
    `#graphql
    query CustomerCompanyContacts($identifier: CustomerIdentifierInput!) {
      customerByIdentifier(identifier: $identifier) {
        id
        companyContactProfiles {
          id
          company { id name }
        }
      }
    }`,
    { variables: { identifier: { emailAddress: email } } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body));
  return body?.data?.customerByIdentifier || null;
}

const LOCATION_PAGE_SIZE = 250;
const MAX_LOCATION_PAGES = 4;

// Every location on the company, paged. The full list is pulled and matched
// locally rather than searched with `query:` — company names come from a
// free-text NetSuite field ("Amentum Services Inc./KPLSS II", "CPCCO - CENTRAL
// PLATEAU CLEANUP CO") and feeding those into search syntax makes the match
// fuzzy, which here would mean attaching an order to the wrong location.
async function fetchCompanyLocations(admin, companyId) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
    const resp = await admin.graphql(
      `#graphql
      query CompanyLocations($companyId: ID!, $first: Int!, $after: String) {
        company(id: $companyId) {
          locations(first: $first, after: $after) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { companyId, first: LOCATION_PAGE_SIZE, after } },
    );
    const body = await resp.json();
    if (body?.errors?.length) throw new Error(gqlError(body));
    const conn = body?.data?.company?.locations;
    if (!conn) break;
    out.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  // Hitting the page cap means the match above ran against a partial list, so an
  // existing location can be missed and duplicated. Loud rather than silent.
  console.warn(
    `[order-sync] company ${companyId} has more than ${MAX_LOCATION_PAGES * LOCATION_PAGE_SIZE} locations — location matching used a partial list.`,
  );
  return out;
}

// The CompanyLocationInput for this order's company: named after the NetSuite
// company and seeded with the order's addresses, so the buyer's company account
// isn't left address-less. Shared by companyCreate and companyLocationCreate.
function companyLocationInput(entry) {
  const input = { name: entry.companyName };
  const shippingAddress = toCompanyAddress(entry.shippingAddress, entry.companyName);
  const billingAddress = toCompanyAddress(entry.billingAddress, entry.companyName);
  if (shippingAddress) input.shippingAddress = shippingAddress;
  if (billingAddress) input.billingAddress = billingAddress;
  else if (shippingAddress) input.billingSameAsShipping = true;
  return input;
}

// Adds the location to an existing company. Returns { id, name } or { error }.
async function createCompanyLocation(admin, companyId, entry) {
  const input = companyLocationInput(entry);

  const resp = await admin.graphql(
    `#graphql
    mutation CompanyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
      companyLocationCreate(companyId: $companyId, input: $input) {
        companyLocation { id name }
        userErrors { field message }
      }
    }`,
    { variables: { companyId, input } },
  );
  const body = await resp.json();
  const payload = body?.data?.companyLocationCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyLocation?.id) {
    return { error: gqlError(body, errors) };
  }
  return { id: payload.companyLocation.id, name: payload.companyLocation.name };
}

// MailingAddressInput (what mapAddress produces) -> CompanyAddressInput. The
// two differ: province is `zoneCode` here, and the company/attention line is
// `recipient`. address1 and countryCode are non-null on the stored address, so
// an address missing either is dropped instead of being half-created.
//
// Two fields on the mailing address are deliberately dropped. The phone, because
// company addresses require E.164 while NetSuite stores free-form numbers
// ("(806) 555-1212") — a rejected address would block the order. And the
// first/last name, because they're a best-effort split of the NetSuite customer
// display name (see mapNetsuiteOrder), which on these records is the company
// itself; `recipient` already carries that.
function toCompanyAddress(addr, companyName) {
  if (!addr?.address1 || !addr?.countryCode) return null;
  const out = {
    address1: addr.address1,
    countryCode: addr.countryCode,
    recipient: companyName,
  };
  if (addr.address2) out.address2 = addr.address2;
  if (addr.city) out.city = addr.city;
  if (addr.zip) out.zip = addr.zip;
  if (addr.provinceCode) out.zoneCode = addr.provinceCode;
  return out;
}

// Builds the Shopify OrderCreateOrderInput object from a mapped entry.
// Used by createOrder for the actual mutation and by the export block for
// preview/test JSON files. `company` is the resolved B2B link (see
// resolveCompanyLocationId) and is absent for non-company orders and in the
// export preview, which runs before an admin client exists.
//
// The same is true of `variantIds` (skuKey -> variant gid, see
// resolveVariantsBySku): without it every line is a custom line item, which is
// what this sync produced before variants were matched at all.
