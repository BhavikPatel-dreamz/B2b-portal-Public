export type SalesCartItem = {
  variantId: string;
  quantity: number;
  price: string | number;
  currencyCode?: string | null;
  productId?: string;
  productTitle?: string;
  variantTitle?: string;
  sku?: string;
  image?: string;
};

export type SalesDiscountType = "PERCENTAGE" | "FIXED_AMOUNT";

export type SalesDraftLineItemInput = {
  variantId?: string;
  title?: string;
  quantity: number;
  priceOverride?: {
    amount: string;
    currencyCode: string;
  };
  originalUnitPriceWithCurrency?: {
    amount: string;
    currencyCode: string;
  };
  taxable?: boolean;
  requiresShipping?: boolean;
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

export function buildSalesDraftTaxLine(
  taxAmount: string | number,
  taxRate: string | number,
  currencyCode: string,
): SalesDraftLineItemInput | undefined {
  const amount = Number(taxAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const rate = Number(taxRate);
  const rateLabel = Number.isFinite(rate) ? Number(rate.toFixed(2)).toString() : "0";

  return {
    title: `Estimated Tax (${rateLabel}%)`,
    quantity: 1,
    originalUnitPriceWithCurrency: {
      amount: normalizeMoneyAmount(amount),
      currencyCode,
    },
    taxable: false,
    requiresShipping: false,
  };
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
  const safeDiscountAmount = Math.max(0, Number.isFinite(discountAmount) ? discountAmount : 0);
  const rawDiscountTotal =
    discountType === "PERCENTAGE" ? subtotal * (safeDiscountAmount / 100) : safeDiscountAmount;
  const discountTotal = Math.min(subtotal, Math.max(0, rawDiscountTotal));
  const taxableAmount = Math.max(0, subtotal - discountTotal);
  const safeShippingCost = Math.max(0, Number.isFinite(shippingCost) ? shippingCost : 0);
  const safeTaxRate = Math.max(0, Number.isFinite(taxRate) ? taxRate : 0);
  const estimatedTax = taxableAmount * (safeTaxRate / 100);
  const total = taxableAmount + safeShippingCost + estimatedTax;

  return {
    subtotal,
    discountTotal,
    taxableAmount,
    estimatedTax,
    total,
  };
}
