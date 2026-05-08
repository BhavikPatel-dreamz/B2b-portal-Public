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
  /** @type {{ message: string; target: string; }[]} */
  const errors = [];

  // -----------------------------------
  // VALIDATION ENABLE / DISABLE
  // -----------------------------------

  const validationEnabled =
    input.shop?.validationEnabled?.value === "true";

  const blockOrdersWhenCreditUnavailable =
    input.shop?.blockOrdersWhenCreditUnavailable?.value === "true";

  // Disable validation entirely if feature is off
  if (!validationEnabled) {
    return { operations: [] };
  }

  // -----------------------------------
  // CHECKOUT STEP VALIDATION
  // -----------------------------------

  const buyerJourneyStep = input.buyerJourney?.step;

  const shouldValidateCredit =
    buyerJourneyStep === "CHECKOUT_INTERACTION" ||
    buyerJourneyStep === "CHECKOUT_COMPLETION";

  if (!shouldValidateCredit) {
    return { operations: [] };
  }

  // -----------------------------------
  // HELPER FUNCTION
  // -----------------------------------

  /** @param {string | number | null | undefined} value */
  const parseDecimal = (value) => {
    if (value == null || value === "") return null;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  };

  // -----------------------------------
  // CART DATA
  // -----------------------------------

  const buyerIdentity = input.cart?.buyerIdentity;
  const cartTotal = parseDecimal(input.cart?.cost?.totalAmount?.amount) ?? 0;

  // -----------------------------------
  // COMPANY VALIDATION
  // -----------------------------------

  if (buyerIdentity?.purchasingCompany?.company) {
    const company = buyerIdentity.purchasingCompany.company;

    const companyCreditLimit = parseDecimal(company.creditLimit?.value);
    
    // Handle inconsistent creditUsed data - sometimes present, sometimes missing
    const rawCreditUsed = company.creditUsed?.value;
    const companyCreditUsed = parseDecimal(rawCreditUsed) ?? 0;
    
    // Log when creditUsed data is missing for debugging
    if (rawCreditUsed == null || rawCreditUsed === "") {
      console.warn("[Cart Validation] Company creditUsed is missing for company:", company);
    }

    // Company credit not configured
    if (companyCreditLimit == null || companyCreditLimit <= 0) {
      errors.push({
        message: "Unable to validate company credit at checkout. Please contact support.",
        target: "$.cart",
      });
    } else {
      const companyAvailableCredit = companyCreditLimit - companyCreditUsed;

      // Company limit fully exhausted
      if (companyCreditUsed >= companyCreditLimit) {
        errors.push({
          message: "Company credit limit has been reached. Please contact support to increase your credit limit.",
          target: "$.cart",
        });
      }

      // Cart exceeds available company credit
      else if (cartTotal > companyAvailableCredit) {
        if (blockOrdersWhenCreditUnavailable) {
          // 🔴 Hard block — order is stopped
          errors.push({
            message: `This order exceeds your company's available credit. Available credit: $${companyAvailableCredit.toFixed(2)}, Cart total: $${cartTotal.toFixed(2)}`,
            target: "$.cart",
          });
        } else {
          // 🟡 Soft warning — order proceeds but admin is notified
          errors.push({
            message: `Insufficient user credit. Available credit: $${companyAvailableCredit.toFixed(2)}, Cart total: $${cartTotal.toFixed(2)}`,
            target: "$.cart",
          });
        }
      }
    }

    // -----------------------------------
    // USER VALIDATION
    // -----------------------------------

    const customer = buyerIdentity.customer;
    const userCreditLimit = parseDecimal(customer?.userCreditLimit?.value);
    const userCreditUsed = parseDecimal(customer?.userCreditUsed?.value) ?? 0;

    if (userCreditLimit != null && userCreditLimit > 0) {
      const userAvailableCredit = userCreditLimit - userCreditUsed;

      // User limit fully exhausted
      if (userCreditUsed >= userCreditLimit) {
        errors.push({
          message: "Your user credit limit has been reached. Please contact your company administrator.",
          target: "$.cart",
        });
      }

      // Cart exceeds user available credit
      else if (cartTotal > userAvailableCredit) {
        errors.push({
          message: `Insufficient user credit. Available credit: $${userAvailableCredit.toFixed(2)}, Cart total: $${cartTotal.toFixed(2)}`,
          target: "$.cart",
        });
      }
    }
  }

  // -----------------------------------
  // RETURN OPERATIONS
  // -----------------------------------

  return {
    operations: [
      {
        validationAdd: { errors },
      },
    ],
  };
}