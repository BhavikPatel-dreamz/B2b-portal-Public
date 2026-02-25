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

  const buyerIdentity = input.cart.buyerIdentity;

  if (buyerIdentity?.purchasingCompany?.company) {
    const company = buyerIdentity.purchasingCompany.company;

    const creditLimit = parseFloat(company.creditLimit?.value || "0");
    const creditUsed = parseFloat(company.creditUsed?.value || "0");

    const availableCredit = Math.max(0, creditLimit - creditUsed);

    const cartTotal = parseFloat(
      input.cart.cost?.totalAmount?.amount || "0"
    );

    if (creditLimit > 0) {
      if (creditUsed >= creditLimit) {
        errors.push({
          message:
            "Company credit limit has been reached. Please contact support to increase your credit limit.",
          target: "$.cart",
        });
      } else if (cartTotal > availableCredit) {
        errors.push({
          message: `Insufficient credit. Available credit: $${availableCredit.toFixed(
            2
          )}, Cart total: $${cartTotal.toFixed(2)}`,
          target: "$.cart",
        });
      }
    }
  }

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
