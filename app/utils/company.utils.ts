/**
 * Format credit value as currency
 * Client-safe utility
 */
export const formatCredit = (value?: string | null, currency: string = "USD") => {
  if (!value) return `${currency === "USD" ? "$" : ""}${Number(0).toLocaleString(undefined, { style: "currency", currency }).replace(/[0-9.,]/g, "")}0.00`;
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  return num.toLocaleString(undefined, {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 2,
  });
};
