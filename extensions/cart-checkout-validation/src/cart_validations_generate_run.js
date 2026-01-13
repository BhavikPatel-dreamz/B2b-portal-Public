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

  console.log('🔍 Cart validation - Input received');
  console.log('📧 Customer email:', input.cart.buyerIdentity?.customer?.email || 'None');
  console.log('🏢 Has purchasing company:', !!input.cart.buyerIdentity?.purchasingCompany);
  console.log('🛒 Cart total:', input.cart.cost?.totalAmount?.amount, input.cart.cost?.totalAmount?.currencyCode);
  console.log('📦 Number of line items:', input.cart.lines?.length || 0);
  console.log('----------------------------------------',JSON.stringify(input));

  // Check company credit validation
  const buyerIdentity = input.cart.buyerIdentity;

  if (buyerIdentity?.purchasingCompany?.company) {
    const company = buyerIdentity.purchasingCompany.company;
    console.log('🏢 B2B Customer detected - Company ID:', company.id);
    console.log('🏢 Company Name:', company.name);

    // Extract credit information from metafields using aliases
    const creditLimit = company.creditLimit?.value ? parseFloat(company.creditLimit.value) : 0;
    const creditUsed = company.creditUsed?.value ? parseFloat(company.creditUsed.value) : 0;

    // Calculate available credit
    const availableCredit = creditLimit - creditUsed;

    // Get cart total from the cart cost
    const cartTotal = input.cart.cost?.totalAmount?.amount ? parseFloat(input.cart.cost.totalAmount.amount) : 0;

    console.log('💰 Credit Limit:', creditLimit);
    console.log('💳 Credit Used:', creditUsed);
    console.log('💵 Available Credit:', availableCredit);
    console.log('🛒 Cart Total:', cartTotal);

    // Only perform credit validation if we have valid credit data
    if (creditLimit > 0) {
      // Check if company has reached credit limit first
      if (creditUsed >= creditLimit) {
        errors.push({
          message: "Company credit limit has been reached. Please contact support to increase your credit limit.",
          target: "$.cart",
        });
        console.log('🚫 Credit limit reached validation triggered');
      }
      // Only check cart total if not at limit already
      else if (cartTotal > availableCredit) {
        errors.push({
          message: `Insufficient credit. Available credit: $${availableCredit.toFixed(2)}, Cart total: $${cartTotal.toFixed(2)}`,
          target: "$.cart",
        });
        console.log('🚫 Insufficient credit validation triggered');
      } else {
        console.log('✅ Credit validation passed');
      }
    } else {
      console.log('⚠️ No valid credit data - skipping credit validation');
    }
  } else {
    console.log('ℹ️ No purchasing company - regular B2C customer');
  }

  console.log('🎯 Total validation errors:', errors.length);

  const operations = [
    {
      validationAdd: {
        errors
      },
    },
  ];

  return { operations };
};
