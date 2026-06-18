export type SalesCartItem = {
  variantId: string;
  quantity: number;
  price: string | number;
  currencyCode?: string | null;
};

export type SalesDiscountType = "PERCENTAGE" | "FIXED_AMOUNT";

export type SalesDraftLineItemInput = {
  variantId: string;
  quantity: number;
  priceOverride: {
    amount: string;
    currencyCode: string;
  };
};

export type SalesDraftShippingLineInput = {
  title: string;
  priceWithCurrency: {
    amount: string;
    currencyCode: string;
  };
};

export function normalizeMoneyAmount(value: string | number) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    return "0.00";
  }

  return amount.toFixed(2);
}

export function normalizeDiscountType(value: string | null | undefined): SalesDiscountType {
  return value === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT";
}

export function getCartCurrency(cartData: SalesCartItem[], fallback = "USD") {
  return (
    cartData.find((item) => item.currencyCode)?.currencyCode?.toUpperCase() ||
    fallback
  );
}

export function buildSalesDraftLineItems(cartData: SalesCartItem[], currencyCode: string): SalesDraftLineItemInput[] {
  return cartData.map((item) => ({
    variantId: item.variantId,
    quantity: item.quantity,
    priceOverride: {
      amount: normalizeMoneyAmount(item.price),
      currencyCode,
    },
  }));
}

export function buildSalesDraftShippingLine(
  shippingCost: string | number,
  currencyCode: string,
): SalesDraftShippingLineInput | undefined {
  const amount = Number(shippingCost);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  return {
    title: "Sales Portal Shipping",
    priceWithCurrency: {
      amount: normalizeMoneyAmount(amount),
      currencyCode,
    },
  };
}

export function calculateSalesOrderTotals(
  cartData: SalesCartItem[],
  discountAmount: number,
  discountType: SalesDiscountType,
  shippingCost = 0,
  taxRate = 0,
) {
  const subtotal = cartData.reduce((acc, item) => acc + Number(item.price) * item.quantity, 0);
  const discountTotal =
    discountType === "PERCENTAGE" ? subtotal * (discountAmount / 100) : discountAmount;
  const taxableAmount = Math.max(0, subtotal - discountTotal);
  const estimatedTax = taxableAmount * (Math.max(0, taxRate) / 100);
  const total = taxableAmount + Math.max(0, shippingCost) + estimatedTax;

  return {
    subtotal,
    discountTotal,
    taxableAmount,
    estimatedTax,
    total,
  };
}
