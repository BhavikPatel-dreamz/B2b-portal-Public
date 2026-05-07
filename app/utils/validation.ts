/**
 * Validate Zip/Postal Code based on country
 * @param zip The zip code to validate
 * @param countryCode The ISO 3166-1 alpha-2 country code
 * @returns { boolean } True if valid, false otherwise
 */
export const isValidZipCode = (zip: string, countryCode: string): boolean => {
  if (!zip || !countryCode) return false;
  
  const cleanZip = zip.trim().toUpperCase();
  const country = countryCode.toUpperCase();

  const patterns: Record<string, RegExp> = {
    US: /^\d{5}(-\d{4})?$/,
    CA: /^[A-Z]\d[A-Z][ ]?\d[A-Z]\d$/,
    GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/,
    IN: /^\d{6}$/,
    AU: /^\d{4}$/,
    DE: /^\d{5}$/,
    FR: /^\d{5}$/,
    IT: /^\d{5}$/,
    ES: /^\d{5}$/,
    NL: /^\d{4}[ ]?[A-Z]{2}$/,
    JP: /^\d{3}-\d{4}$/,
    CN: /^\d{6}$/,
    RU: /^\d{6}$/,
    BR: /^\d{5}-?\d{3}$/,
  };

  if (patterns[country]) {
    return patterns[country].test(cleanZip);
  }

  // Fallback: at least 3 characters for other countries
  return cleanZip.length >= 3 && cleanZip.length <= 12;
};
