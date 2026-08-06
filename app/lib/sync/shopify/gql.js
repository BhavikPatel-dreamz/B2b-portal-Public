// Surfaces either GraphQL top-level errors (e.g. access denied) or userErrors.
//
// In a leaf module of its own, with no imports, because every Shopify module
// needs it and two of them (fulfill.server.js, and the tests around it) would
// otherwise have to pull in the whole server chain — mapping.js, the NetSuite
// client, the Prisma db module — to reach one error formatter.
export function gqlError(body, userErrors) {
  if (body?.errors?.length) {
    return body.errors.map((e) => e.message).join("; ");
  }
  if (userErrors?.length) {
    return userErrors.map((e) => `${(e.field || []).join(".")} ${e.message}`.trim()).join("; ");
  }
  return "unknown GraphQL error";
}
