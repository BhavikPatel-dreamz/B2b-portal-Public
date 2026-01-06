/**
 * Format credit value as USD currency
 * Client-safe utility
 */
export const formatCredit = (value?: string | null) => {
  if (!value) return "$0.00";
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  return num.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
};
