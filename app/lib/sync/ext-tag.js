// Every order we create is tagged with its NetSuite id so later runs can find
// it again for update/delete without needing a local mapping table.
//
// A file of its own, for the same reason gql.js and sku.js are: this is the one
// thing the Shopify write modules needed from mapping.js, and mapping.js reaches
// the NetSuite client and from there the database, which puts the whole tracking
// path behind a live app to import. Re-exported from mapping.js, so nothing that
// already reads it from there has to change.
export const extTag = (externalId) => `ext:${externalId}`;
