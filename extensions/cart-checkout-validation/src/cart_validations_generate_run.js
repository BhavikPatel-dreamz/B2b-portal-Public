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
    console.log('🏢 Available metafields:', company.metafields);

    // Extract credit information from metafields array
    let creditLimit = 0;
    let creditUsed = 0;

    if (company.metafields) {
      const creditLimitMetafield = company.metafields.find(m =>
        m.namespace === 'b2b_credit' && m.key === 'credit_limit'
      );
      const creditUsedMetafield = company.metafields.find(m =>
        m.namespace === 'b2b_credit' && m.key === 'credit_used'
      );

      creditLimit = creditLimitMetafield?.value ? parseFloat(creditLimitMetafield.value) : 0;
      creditUsed = creditUsedMetafield?.value ? parseFloat(creditUsedMetafield.value) : 0;
    }

    // Calculate available credit
    const availableCredit = creditLimit - creditUsed;

    // Get cart total from the cart cost
    const cartTotal = input.cart.cost?.totalAmount?.amount ? parseFloat(input.cart.cost.totalAmount.amount) : 0;

    console.log('💰 Credit Limit:', creditLimit);
    console.log('💳 Credit Used:', creditUsed);
    console.log('💵 Available Credit:', availableCredit);
    console.log('🛒 Cart Total:', cartTotal);

    // Fallback: Check if customer has B2B metafields if company metafields are not found
    if (creditLimit === 0 && buyerIdentity?.customer) {
      console.log('⚠️ No company metafields found, checking customer metafields as fallback');
      const customer = buyerIdentity.customer;
      console.log('👤 Customer ID:', customer.id);
      console.log('👤 Customer metafields available:', !!customer.b2bCompanyId);
    }

    console.log('💰 Final Credit Limit:', creditLimit);
    console.log('💳 Final Credit Used:', creditUsed);
    console.log('💵 Final Available Credit:', availableCredit);

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
