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

    const currency =
      input.cart.cost?.totalAmount?.currencyCode || "";

    if (creditLimit > 0) {
      if (creditUsed >= creditLimit) {
        errors.push({
          message:
            "Company credit limit has been reached. Please contact support.",
          target: "$.cart",
        });
      } else if (cartTotal > availableCredit) {
        errors.push({
          message: `Insufficient credit. Available: ${availableCredit.toFixed(
            2
          )} ${currency}, Cart total: ${cartTotal.toFixed(2)} ${currency}`,
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
