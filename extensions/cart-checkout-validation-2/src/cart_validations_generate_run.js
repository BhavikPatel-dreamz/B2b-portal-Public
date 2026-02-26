// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

// Add type definitions to match Rust implementation
/**
 * @typedef {Object} DeliveryAddress
 * @property {string | null} [address1]
 * @property {string | null} [address2]
 */

/**
 * @typedef {Object} DeliveryGroup
 * @property {DeliveryAddress | null} [deliveryAddress]
 */

/**
 * @typedef {Object} Cart
 * @property {DeliveryGroup[]} deliveryGroups
 */

/**
 * @param {string} address
 * @returns {boolean}
 */
function isPoBox(address) {
  const normalized = address.toLowerCase().replace(/\./g, '').replace(/\s/g, '');
  return normalized.includes('pobox') ||
         normalized.includes('afpo') ||
         normalized.includes('postoffice') ||
         normalized.includes('postbox');
}


export function cartValidationsGenerateRun(input) {
  const poBoxFound = (input.cart?.deliveryGroups || []).some((group) => {
    const address1 = group?.deliveryAddress?.address1 || "";
    const address2 = group?.deliveryAddress?.address2 || "";
    return isPoBox(address1) || isPoBox(address2);
  });

  const errors = poBoxFound
    ? [
        {
          message: "Shipping to PO Boxes is not allowed.",
          target: "$.cart.deliveryGroups[0].deliveryAddress",
        },
      ]
    : [];

  return {
    operations: [
      {
        validationAdd: {
          errors,
        },
      },
    ],
  };
}
