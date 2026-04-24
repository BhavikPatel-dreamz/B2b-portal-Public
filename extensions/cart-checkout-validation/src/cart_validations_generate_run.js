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
  /**
   * @type {{ message: string; target: string; }[]}
   */
  const errors = [];
  const buyerJourneyStep = input.buyerJourney?.step;
  const shouldValidateCredit =
    buyerJourneyStep === "CHECKOUT_INTERACTION" ||
    buyerJourneyStep === "CHECKOUT_COMPLETION";

  const parseDecimal = (value) => {
    if (value == null || value === "") return null;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  };

  if (!shouldValidateCredit) {
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

  // Check company credit validation
  const buyerIdentity = input.cart.buyerIdentity;
  const cartTotal = parseDecimal(input.cart.cost?.totalAmount?.amount) ?? 0;

  if (buyerIdentity?.purchasingCompany?.company) {
    const company = buyerIdentity.purchasingCompany.company;
    const companyCreditLimit = parseDecimal(company.creditLimit?.value);
    const companyCreditUsed = parseDecimal(company.creditUsed?.value) ?? 0;

    if (companyCreditLimit == null || companyCreditLimit <= 0) {
      errors.push({
        message:
          "Unable to validate company credit at checkout. Please contact support.",
        target: "$.cart",
      });
    } else {
      const companyAvailableCredit = companyCreditLimit - companyCreditUsed;

      if (companyCreditUsed >= companyCreditLimit) {
        errors.push({
          message: "Company credit limit has been reached. Please contact support to increase your credit limit.",
          target: "$.cart",
        });
      }
      else if (cartTotal > companyAvailableCredit) {
        errors.push({
          message: `Insufficient company credit. Available credit: $${companyAvailableCredit.toFixed(2)}, Cart total: $${cartTotal.toFixed(2)}`,
          target: "$.cart",
        });
      }
    }

    const customer = buyerIdentity.customer;
    const userCreditLimit = parseDecimal(customer?.userCreditLimit?.value);
    const userCreditUsed = parseDecimal(customer?.userCreditUsed?.value) ?? 0;

    if (userCreditLimit != null && userCreditLimit > 0) {
      const userAvailableCredit = userCreditLimit - userCreditUsed;

      if (userCreditUsed >= userCreditLimit) {
        errors.push({
          message: "Your user credit limit has been reached. Please contact your company administrator.",
          target: "$.cart",
        });
      } else if (cartTotal > userAvailableCredit) {
        errors.push({
          message: `Insufficient user credit. Available credit: $${userAvailableCredit.toFixed(2)}, Cart total: $${cartTotal.toFixed(2)}`,
          target: "$.cart",
        });
      }
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
