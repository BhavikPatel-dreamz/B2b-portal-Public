// @ts-check

import { cartValidationsGenerateRun } from "./src/cart_validations_generate_run.js";

/**
 * Test suite for cart checkout validation
 * This tests the B2B credit validation functionality
 */

// Mock test data - B2B customer with sufficient credit
const testInputSufficientCredit = {
  cart: {
    lines: [
      { quantity: 2, merchandise: { id: "gid://shopify/ProductVariant/123", title: "Test Product" } },
      { quantity: 1, merchandise: { id: "gid://shopify/ProductVariant/456", title: "Another Product" } }
    ],
    cost: {
      totalAmount: {
        amount: "150.00",
        currencyCode: "USD"
      }
    },
    buyerIdentity: {
      email: "test@company.com",
      customer: {
        id: "gid://shopify/Customer/123456789",
        email: "test@company.com",
        metafield: { value: "company_123" },
        b2bCompanyId: { value: "company_123" }
      },
      purchasingCompany: {
        company: {
          id: "gid://shopify/Company/987654321",
          name: "Test Company Ltd",
          metafields: [
            {
              namespace: "b2b_credit",
              key: "credit_limit",
              value: "1000.00"
            },
            {
              namespace: "b2b_credit",
              key: "credit_used",
              value: "200.00"
            }
          ]
        }
      }
    }
  }
};

// Mock test data - B2B customer with insufficient credit
const testInputInsufficientCredit = {
  cart: {
    lines: [{ quantity: 5, merchandise: { id: "gid://shopify/ProductVariant/999", title: "Expensive Product" } }],
    cost: {
      totalAmount: {
        amount: "900.00",
        currencyCode: "USD"
      }
    },
    buyerIdentity: {
      email: "test2@company.com",
      customer: {
        id: "gid://shopify/Customer/123456790",
        email: "test2@company.com",
        metafield: { value: "company_456" },
        b2bCompanyId: { value: "company_456" }
      },
      purchasingCompany: {
        company: {
          id: "gid://shopify/Company/987654322",
          name: "Another Test Company",
          metafields: [
            {
              namespace: "b2b_credit",
              key: "credit_limit",
              value: "1000.00"
            },
            {
              namespace: "b2b_credit",
              key: "credit_used",
              value: "700.00"
            }
          ]
        }
      }
    }
  }
};

// Mock test data - Credit limit reached
const testInputCreditLimitReached = {
  cart: {
    lines: [{ quantity: 1, merchandise: { id: "gid://shopify/ProductVariant/777", title: "Any Product" } }],
    cost: {
      totalAmount: {
        amount: "50.00",
        currencyCode: "USD"
      }
    },
    buyerIdentity: {
      email: "test3@company.com",
      customer: {
        id: "gid://shopify/Customer/123456791",
        email: "test3@company.com",
        metafield: { value: "company_789" },
        b2bCompanyId: { value: "company_789" }
      },
      purchasingCompany: {
        company: {
          id: "gid://shopify/Company/987654323",
          name: "Credit Maxed Company",
          metafields: [
            {
              namespace: "b2b_credit",
              key: "credit_limit",
              value: "500.00"
            },
            {
              namespace: "b2b_credit",
              key: "credit_used",
              value: "500.00"
            }
          ]
        }
      }
    }
  }
};

// Mock test data - Regular B2C customer (non-B2B)
const testInputRegularCustomer = {
  cart: {
    lines: [{ quantity: 1, merchandise: { id: "gid://shopify/ProductVariant/888", title: "Regular Product" } }],
    cost: {
      totalAmount: {
        amount: "75.00",
        currencyCode: "USD"
      }
    },
    buyerIdentity: {
      email: "regular@customer.com",
      customer: {
        id: "gid://shopify/Customer/123456792",
        email: "regular@customer.com"
      }
      // No purchasingCompany - regular customer
    }
  }
};

// Mock test data - Missing metafields
const testInputMissingMetafields = {
  cart: {
    lines: [{ quantity: 1, merchandise: { id: "gid://shopify/ProductVariant/555", title: "Test Product" } }],
    cost: {
      totalAmount: {
        amount: "100.00",
        currencyCode: "USD"
      }
    },
    buyerIdentity: {
      email: "broken@company.com",
      customer: {
        id: "gid://shopify/Customer/123456793",
        email: "broken@company.com"
      },
      purchasingCompany: {
        company: {
          id: "gid://shopify/Company/987654324",
          name: "Company Without Metafields",
          metafields: [] // Empty metafields array
        }
      }
    }
  }
};

/**
 * Run all validation tests
 */
function runTests() {
  console.log("🧪 Starting Cart Checkout Validation Tests\n");

  // Test 1: Sufficient credit
  console.log("Test 1: B2B Customer with Sufficient Credit");
  console.log("Expected: No errors (validation passes)");
  const result1 = cartValidationsGenerateRun(testInputSufficientCredit);
  const errors1 = result1.operations[0].validationAdd.errors;
  console.log(`Actual: ${errors1.length} errors`);
  if (errors1.length > 0) {
    console.log("❌ FAILED - Expected no errors");
    console.log("Errors:", errors1);
  } else {
    console.log("✅ PASSED - No validation errors");
  }
  console.log("─".repeat(50));

  // Test 2: Insufficient credit
  console.log("Test 2: B2B Customer with Insufficient Credit");
  console.log("Expected: 1 error (insufficient credit)");
  const result2 = cartValidationsGenerateRun(testInputInsufficientCredit);
  const errors2 = result2.operations[0].validationAdd.errors;
  console.log(`Actual: ${errors2.length} errors`);
  if (errors2.length === 1 && errors2[0].message.includes("Insufficient credit")) {
    console.log("✅ PASSED - Correct insufficient credit error");
    console.log("Error message:", errors2[0].message);
  } else {
    console.log("❌ FAILED - Expected insufficient credit error");
    console.log("Errors:", errors2);
  }
  console.log("─".repeat(50));

  // Test 3: Credit limit reached
  console.log("Test 3: B2B Customer with Credit Limit Reached");
  console.log("Expected: 1 error (credit limit reached)");
  const result3 = cartValidationsGenerateRun(testInputCreditLimitReached);
  const errors3 = result3.operations[0].validationAdd.errors;
  console.log(`Actual: ${errors3.length} errors`);
  if (errors3.length === 1 && errors3[0].message.includes("credit limit has been reached")) {
    console.log("✅ PASSED - Correct credit limit reached error");
    console.log("Error message:", errors3[0].message);
  } else {
    console.log("❌ FAILED - Expected credit limit reached error");
    console.log("Errors:", errors3);
  }
  console.log("─".repeat(50));

  // Test 4: Regular customer
  console.log("Test 4: Regular B2C Customer");
  console.log("Expected: No errors (no B2B validation)");
  const result4 = cartValidationsGenerateRun(testInputRegularCustomer);
  const errors4 = result4.operations[0].validationAdd.errors;
  console.log(`Actual: ${errors4.length} errors`);
  if (errors4.length === 0) {
    console.log("✅ PASSED - Regular customer allowed through");
  } else {
    console.log("❌ FAILED - Regular customer should not have validation errors");
    console.log("Errors:", errors4);
  }
  console.log("─".repeat(50));

  // Test 5: Missing metafields
  console.log("Test 5: B2B Customer with Missing Metafields");
  console.log("Expected: No errors (fallback behavior)");
  const result5 = cartValidationsGenerateRun(testInputMissingMetafields);
  const errors5 = result5.operations[0].validationAdd.errors;
  console.log(`Actual: ${errors5.length} errors`);
  if (errors5.length === 0) {
    console.log("✅ PASSED - Missing metafields handled gracefully");
  } else {
    console.log("⚠️ WARNING - Metafields missing caused validation errors");
    console.log("Errors:", errors5);
  }
  console.log("─".repeat(50));

  console.log("\n🏁 Tests completed!");
}

// Run the tests
runTests();
