// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const errors = [];

  // Check quantity validation (existing logic)
  const quantityErrors = input.cart.lines
    .filter(({ quantity }) => quantity > 1)
    .map(() => ({
      message: "Not possible to order more than one of each",
      target: "$.cart",
    }));

  errors.push(...quantityErrors);

  // Check company credit validation
  const buyerIdentity = input.cart.buyerIdentity;

  if (buyerIdentity?.purchasingCompany?.company) {
    const company = buyerIdentity.purchasingCompany.company;

    // Extract credit information from metafields using aliases
    const creditLimit = company.creditLimit?.value ? parseFloat(company.creditLimit.value) : 0;
    const creditUsed = company.creditUsed?.value ? parseFloat(company.creditUsed.value) : 0;

    // Calculate available credit
    const availableCredit = creditLimit - creditUsed;

    // Get cart total from the cart cost
    const cartTotal = input.cart.cost?.totalAmount?.amount ? parseFloat(input.cart.cost.totalAmount.amount) : 0;

    // Check if company has reached credit limit first
    if (creditUsed >= creditLimit) {
      errors.push({
        message: "Company credit limit has been reached. Please contact support to increase your credit limit.",
        target: "$.cart",
      });
    }
    // Only check cart total if not at limit already
    else if (cartTotal > availableCredit) {
      errors.push({
        message: `Insufficient credit. Available credit: $${availableCredit.toFixed(2)}, Cart total: $${cartTotal.toFixed(2)}`,
        target: "$.cart",
      });
    }
  }

  const operations = [
    {
      validationAdd: {
        errors
      },
    },
  ];

  return { operations };
};
