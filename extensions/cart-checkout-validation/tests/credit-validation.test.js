import { describe, it, expect } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run.js";

describe("Cart Validation Function", () => {
  describe("Credit validation", () => {
    it("should allow cart when sufficient credit is available", () => {
      const input = {
        cart: {
          lines: [{ quantity: 1 }],
          cost: {
            totalAmount: { amount: "50.00" }
          },
          buyerIdentity: {
            purchasingCompany: {
              company: {
                creditLimit: { value: "1000.00" },
                creditUsed: { value: "100.00" }
              }
            }
          }
        }
      };

      const result = cartValidationsGenerateRun(input);
      expect(result.operations[0].validationAdd.errors).toHaveLength(0);
    });

    it("should block cart when insufficient credit", () => {
      const input = {
        cart: {
          lines: [{ quantity: 1 }],
          cost: {
            totalAmount: { amount: "200.00" }
          },
          buyerIdentity: {
            purchasingCompany: {
              company: {
                creditLimit: { value: "1000.00" },
                creditUsed: { value: "900.00" }
              }
            }
          }
        }
      };

      const result = cartValidationsGenerateRun(input);
      const errors = result.operations[0].validationAdd.errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Insufficient credit");
      expect(errors[0].message).toContain("Available credit: $100.00");
      expect(errors[0].message).toContain("Cart total: $200.00");
    });

    it("should block cart when credit limit is reached", () => {
      const input = {
        cart: {
          lines: [{ quantity: 1 }],
          cost: {
            totalAmount: { amount: "50.00" }
          },
          buyerIdentity: {
            purchasingCompany: {
              company: {
                creditLimit: { value: "1000.00" },
                creditUsed: { value: "1000.00" }
              }
            }
          }
        }
      };

      const result = cartValidationsGenerateRun(input);
      const errors = result.operations[0].validationAdd.errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Company credit limit has been reached");
    });

    it("should work with non-B2B customers (no purchasing company)", () => {
      const input = {
        cart: {
          lines: [{ quantity: 1 }],
          cost: {
            totalAmount: { amount: "50.00" }
          },
          buyerIdentity: {
            customer: {
              id: "gid://shopify/Customer/123"
            }
          }
        }
      };

      const result = cartValidationsGenerateRun(input);
      expect(result.operations[0].validationAdd.errors).toHaveLength(0);
    });
  });

  describe("Quantity validation", () => {
    it("should block items with quantity > 1", () => {
      const input = {
        cart: {
          lines: [
            { quantity: 1 },
            { quantity: 2 }
          ],
          cost: {
            totalAmount: { amount: "50.00" }
          },
          buyerIdentity: {
            purchasingCompany: {
              company: {
                creditLimit: { value: "1000.00" },
                creditUsed: { value: "100.00" }
              }
            }
          }
        }
      };

      const result = cartValidationsGenerateRun(input);
      const errors = result.operations[0].validationAdd.errors;
      expect(errors.some(e => e.message.includes("Not possible to order more than one"))).toBe(true);
    });
  });

  describe("Combined validations", () => {
    it("should show both quantity and credit errors", () => {
      const input = {
        cart: {
          lines: [
            { quantity: 1 },
            { quantity: 3 }
          ],
          cost: {
            totalAmount: { amount: "200.00" }
          },
          buyerIdentity: {
            purchasingCompany: {
              company: {
                creditLimit: { value: "1000.00" },
                creditUsed: { value: "900.00" }
              }
            }
          }
        }
      };

      const result = cartValidationsGenerateRun(input);
      const errors = result.operations[0].validationAdd.errors;
      expect(errors).toHaveLength(2);
      expect(errors.some(e => e.message.includes("Not possible to order more than one"))).toBe(true);
      expect(errors.some(e => e.message.includes("Insufficient credit"))).toBe(true);
    });
  });
});
