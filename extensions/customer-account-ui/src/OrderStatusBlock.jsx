// @ts-nocheck
// use-strict
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};
const API_URL = "https://smartb2b.dynamicdreamz.com";
// "https://dd-79.dynamicdreamz.com"
//"https://b2b-portal-public.vercel.app"
// "https://smartb2b.dynamicdreamz.com";

const SECTION_LABELS = {
  company: "Company information",
  contact: "Contact information",
  shipping: "Shipping address",
  billing: "Billing address",
};

const COUNTRY_PHONE_META = {
  IN: { dialCode: "+91", flagEmoji: "🇮🇳" },
  INDIA: { dialCode: "+91", flagEmoji: "🇮🇳" },
  US: { dialCode: "+1", flagEmoji: "🇺🇸" },
  USA: { dialCode: "+1", flagEmoji: "🇺🇸" },
  "UNITED STATES": { dialCode: "+1", flagEmoji: "🇺🇸" },
  CA: { dialCode: "+1", flagEmoji: "🇨🇦" },
  CANADA: { dialCode: "+1", flagEmoji: "🇨🇦" },
  GB: { dialCode: "+44", flagEmoji: "🇬🇧" },
  UK: { dialCode: "+44", flagEmoji: "🇬🇧" },
  "UNITED KINGDOM": { dialCode: "+44", flagEmoji: "🇬🇧" },
  AU: { dialCode: "+61", flagEmoji: "🇦🇺" },
  AUSTRALIA: { dialCode: "+61", flagEmoji: "🇦🇺" },
  NZ: { dialCode: "+64", flagEmoji: "🇳🇿" },
  "NEW ZEALAND": { dialCode: "+64", flagEmoji: "🇳🇿" },
  SG: { dialCode: "+65", flagEmoji: "🇸🇬" },
  SINGAPORE: { dialCode: "+65", flagEmoji: "🇸🇬" },
  AE: { dialCode: "+971", flagEmoji: "🇦🇪" },
  "UNITED ARAB EMIRATES": { dialCode: "+971", flagEmoji: "🇦🇪" },
  SA: { dialCode: "+966", flagEmoji: "🇸🇦" },
  "SAUDI ARABIA": { dialCode: "+966", flagEmoji: "🇸🇦" },
  DE: { dialCode: "+49", flagEmoji: "🇩🇪" },
  GERMANY: { dialCode: "+49", flagEmoji: "🇩🇪" },
  FR: { dialCode: "+33", flagEmoji: "🇫🇷" },
  FRANCE: { dialCode: "+33", flagEmoji: "🇫🇷" },
  IT: { dialCode: "+39", flagEmoji: "🇮🇹" },
  ITALY: { dialCode: "+39", flagEmoji: "🇮🇹" },
  ES: { dialCode: "+34", flagEmoji: "🇪🇸" },
  SPAIN: { dialCode: "+34", flagEmoji: "🇪🇸" },
  NL: { dialCode: "+31", flagEmoji: "🇳🇱" },
  NETHERLANDS: { dialCode: "+31", flagEmoji: "🇳🇱" },
};

function Extension() {
  const [fields, setFields] = useState([]);
  const [formData, setFormData] = useState({});
  const [customerDetails, setCustomerDetails] = useState(null);
  const [isLegacyApplePay, setIsLegacyApplePay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [shopDomain, setShopDomain] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [accountCheckComplete, setAccountCheckComplete] = useState(false);
  const [countriesData, setCountriesData] = useState([]);
  const [fieldErrors, setFieldErrors] = useState({});

  const getCustomerMetafieldQuery = {
    query: `query {
      shop {
        id
        myshopifyDomain
      }
      customer {
        id
        firstName
        lastName
        metafield(namespace: "custom", key: "legacy_applepay_status") {
          value
        }
      }
    }`,
  };

  // ───────────────────────────
  // 1. FETCH SHOP & CUSTOMER DATA
  // ───────────────────────────
  useEffect(() => {
    const fetchShopData = async () => {
      try {
        const res = await fetch(
          "shopify://customer-account/api/2026-01/graphql.json",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(getCustomerMetafieldQuery),
          },
        );
        const { data } = await res.json();
        setShopDomain(data?.shop?.myshopifyDomain || "");
        setCustomerId(data?.customer?.id || "");
        if (data?.customer?.metafield?.value === "true") {
          setIsLegacyApplePay(true);
        }
      } catch (err) {
        console.error("Shopify API Error:", err);
        setCheckingStatus(false);
      }
    };
    fetchShopData();
  }, []);

  useEffect(() => {
    if (!shopDomain || !customerId) return;
    const customerIdWithoutPrefix = customerId.replace(
      "gid://shopify/Customer/",
      "",
    );

    const fetchAccountStatus = async () => {
      try {
        setAccountCheckComplete(false);
        const res = await fetch(
          `${API_URL}/api/proxy/customer-account?customerId=${customerIdWithoutPrefix}&shop=${shopDomain}`,
          { method: "GET", headers: { Accept: "application/json" } },
        );
        const result = await res.json();
        const { config, message, redirectTo, reviewNotes: nextReviewNotes } =
          result;
        if (redirectTo) {
          setReviewNotes(nextReviewNotes || "");
          setIsRedirecting(true);
          window.location.replace(redirectTo);
          return;
        }
        if (message) {
          setStatusMessage(message);
          setReviewNotes(nextReviewNotes || "");
          setAccountCheckComplete(true);
          return;
        }
        if (config?.fields) {
          setReviewNotes("");
          setFields(config.fields);
          const initial = {};
          const processFields = (arr) => {
            arr.forEach((f) => {
              if (f.type === "group") {
                processFields(f.fields);
              } else if (f.type === "checkbox") {
                initial[f.key] = false;
              } else if (f.type === "country") {
                initial[f.key] = "IN";
              } else if (f.type === "state") {
                initial[f.key] = getProvinceOptions("IN")[0]?.value ?? "";
              } else {
                initial[f.key] = "";
              }
            });
          };
          processFields(config.fields);
          setFormData(initial);
        }
        setAccountCheckComplete(true);
      } catch (err) {
        console.error("Account API Error:", err);
      } finally {
        setCheckingStatus(false);
      }
    };
    fetchAccountStatus();
  }, [shopDomain, customerId]);

  useEffect(() => {
    if (!shopDomain || !customerId || !accountCheckComplete || isRedirecting)
      return;
    const customerIdWithoutPrefix = customerId.replace(
      "gid://shopify/Customer/",
      "",
    );
    const fetchCustomerDetails = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/proxy/customer-detail?customerId=${customerIdWithoutPrefix}&shop=${shopDomain}`,
          { method: "GET", headers: { Accept: "application/json" } },
        );
        const result = await res.json();
        if (!res.ok)
          throw new Error(result?.error || "Failed to fetch customer details");
        setCustomerDetails(result?.customer || null);
      } catch (err) {
        console.error("Customer detail API Error:", err);
      }
    };
    fetchCustomerDetails();
  }, [shopDomain, customerId, accountCheckComplete, isRedirecting]);

  useEffect(() => {
    if (!shopDomain || !accountCheckComplete || isRedirecting) return;
    const fetchCountries = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/proxy/shipping-zones?shop=${shopDomain}`,
          { method: "GET", headers: { Accept: "application/json" } },
        );
        const { countries } = await res.json();
        console.log(countries, "countries from API");
        setCountriesData(countries || []);
      } catch (err) {
        console.error("Countries fetch error:", err);
      }
    };
    fetchCountries();
  }, [shopDomain, accountCheckComplete, isRedirecting]);

  // =========================
  // HANDLE CHANGE
  // =========================
  const handleChange = (key, value) => {
    const finalValue = getInputValue(value);

    setFormData((prev) => {
      const updated = { ...prev, [key]: finalValue };
      if (key === "billSameAsShip" && finalValue === true) {
        Object.keys(prev).forEach((k) => {
          if (k.startsWith("ship")) {
            const billKey = "bill" + k.slice(4);
            if (billKey in prev) updated[billKey] = prev[k];
          }
        });
      }
      if (key === "billSameAsShip" && finalValue === false) {
        Object.keys(prev).forEach((k) => {
          if (k.startsWith("bill") && k !== "billSameAsShip") updated[k] = "";
        });
      }
      if (key.startsWith("ship") && prev["billSameAsShip"] === true) {
        const billKey = "bill" + key.slice(4);
        if (billKey in prev) updated[billKey] = finalValue;
      }
      return updated;
    });
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      return { ...prev, [key]: "" };
    });
  };

  const getInputValue = (value) =>
    value?.target?.checked !== undefined
      ? value.target.checked
      : (value?.target?.value ?? value?.value ?? value ?? "");

  const findPairedKey = (sourceKey, findWord, replaceWord) => {
    const variants = [
      sourceKey.replace(new RegExp(findWord, "i"), replaceWord),
      sourceKey.replace(
        new RegExp(findWord, "i"),
        replaceWord.charAt(0).toUpperCase() + replaceWord.slice(1),
      ),
      sourceKey.replace(
        new RegExp(findWord.charAt(0).toUpperCase() + findWord.slice(1)),
        replaceWord.charAt(0).toUpperCase() + replaceWord.slice(1),
      ),
    ];
    return variants.find((v) => v in formData) ?? null;
  };

  const clearPairedZipField = (sourceKey) => {
    const zipKey =
      findPairedKey(sourceKey, "country", "zip") ||
      findPairedKey(sourceKey, "state", "zip") ||
      findPairedKey(sourceKey, "province", "zip") ||
      findPairedKey(sourceKey, "country", "postal") ||
      findPairedKey(sourceKey, "state", "postal") ||
      findPairedKey(sourceKey, "province", "postal");

    if (zipKey) {
      handleChange(zipKey, "");
    }
  };

  const getCountryOptions = () =>
    countriesData.map((c) => ({ value: c.value, label: c.label }));

  const getProvinceOptions = (countryCode) => {
    const normalizedCountry = normalizeCountryCode(countryCode);
    const found = countriesData.find(
      (c) =>
        normalizeCountryCode(c.value) === normalizedCountry ||
        normalizeCountryCode(c.label) === normalizedCountry,
    );
    return found?.provinces || [];
  };

  const resolveOptionValue = (options, rawValue) => {
    const normalizedValue = normalizeCountryCode(rawValue);
    if (!normalizedValue) return "";

    const matchedOption = (options || []).find(
      (option) =>
        normalizeCountryCode(option?.value) === normalizedValue ||
        normalizeCountryCode(option?.label) === normalizedValue,
    );

    return matchedOption?.value ?? String(rawValue ?? "");
  };

  const stripHtml = (value) =>
    (value || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const normalizeFieldText = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  const normalizeCountryCode = (value) =>
    String(value || "")
      .trim()
      .toUpperCase();

  const getPhoneMetaForCountry = (countryValue) =>
    COUNTRY_PHONE_META[normalizeCountryCode(countryValue)] || {
      dialCode: "+91",
      flagEmoji: "🇮🇳",
    };

  const isOnlyDialCode = (phoneValue, dialCode) => {
    const phone = String(phoneValue || "").trim();
    const code = String(dialCode || "").trim();
    if (!phone) return true;
    if (!code) return false;
    const phoneDigits = phone.replace(/[^\d]/g, "");
    const codeDigits = code.replace(/[^\d]/g, "");

    return phoneDigits === codeDigits;
  };

  const getPhoneDigitsWithoutDialCode = (phoneValue, dialCode) => {
    const phone = String(phoneValue || "").trim();
    const code = String(dialCode || "").trim();
    if (!phone) return "";
    if (code && phone.startsWith(code)) {
      return phone.slice(code.length).trimStart();
    }
    return phone.replace(/^\+\d{1,4}\s*/, "");
  };

  const sanitizePhoneDigits = (value) =>
    String(value || "").replace(/\D/g, "");

  const getAutofillValue = (field) => {
    if (!customerDetails) return "";
    const key = normalizeFieldText(field?.key);
    const label = normalizeFieldText(field?.label);
    const fieldType = normalizeFieldText(field?.type);
    const combined = `${key}${label}${fieldType}`;
    const defaultAddress = customerDetails.defaultAddress || {};

    if (fieldType === "email" || combined.includes("email"))
      return customerDetails.email || "";
    if (combined.includes("firstname")) {
      if (key.startsWith("ship") || label.includes("shipping"))
        return defaultAddress.firstName || customerDetails.firstName || "";
      return customerDetails.firstName || "";
    }
    if (combined.includes("lastname")) {
      if (key.startsWith("ship") || label.includes("shipping"))
        return defaultAddress.lastName || customerDetails.lastName || "";
      return customerDetails.lastName || "";
    }
    if (key.startsWith("ship") || label.includes("shipping")) {
      if (fieldType === "phone" || combined.includes("phone"))
        return defaultAddress.phone || customerDetails.phone || "";
      if (combined.includes("addressline1") || combined.includes("addr1"))
        return defaultAddress.address1 || "";
      if (combined.includes("addressline2") || combined.includes("addr2"))
        return defaultAddress.address2 || "";
      if (combined.includes("city")) return defaultAddress.city || "";
      if (combined.includes("state") || combined.includes("province"))
        return defaultAddress.provinceCode || defaultAddress.province || "";
      if (combined.includes("zip") || combined.includes("postal"))
        return defaultAddress.zip || "";
      if (combined.includes("country"))
        return defaultAddress.countryCode || defaultAddress.country || "";
    }
    return "";
  };

  useEffect(() => {
    if (!fields.length || !customerDetails) return;
    setFormData((prev) => {
      const updated = { ...prev };
      let hasChanges = false;
      const applyAutofill = (items) => {
        items.forEach((field) => {
          if (field.type === "group") {
            applyAutofill(field.fields || []);
            return;
          }
          const autofillValue = getAutofillValue(field);
          if (!autofillValue) return;
          const currentValue = updated[field.key];
          if (
            currentValue === undefined ||
            currentValue === null ||
            currentValue === ""
          ) {
            updated[field.key] = autofillValue;
            hasChanges = true;
          }
        });
      };
      applyAutofill(fields);
      return hasChanges ? updated : prev;
    });
  }, [fields, customerDetails]);

  const getSectionMeta = (section, sectionFields) => {
    const fieldWithSectionLabel = sectionFields.find(
      (f) => typeof f.sectionLabel === "string" && f.sectionLabel.trim() !== "",
    );
    const fieldWithHeadingWidth = sectionFields.find(
      (f) => typeof f.sectionHeadingWidth === "number",
    );
    const fieldWithHeadingAlignment = sectionFields.find(
      (f) => f.sectionHeadingAlignment,
    );
    const fieldWithHeadingHidden = sectionFields.find(
      (f) => typeof f.sectionHeadingHidden === "boolean",
    );
    return {
      title:
        fieldWithSectionLabel?.sectionLabel?.trim() ||
        SECTION_LABELS[section] ||
        section,
      width: Math.min(
        100,
        Math.max(25, fieldWithHeadingWidth?.sectionHeadingWidth ?? 100),
      ),
      alignment: fieldWithHeadingAlignment?.sectionHeadingAlignment || "left",
      hidden: fieldWithHeadingHidden?.sectionHeadingHidden ?? false,
    };
  };

  const shouldShowSectionHeading = (section, sectionFields) =>
    !getSectionMeta(section, sectionFields).hidden;

  const getVisibleSectionFields = (section, sectionFields) => {
    if (section !== "billing" || formData.billSameAsShip !== true)
      return sectionFields;
    return sectionFields.filter((f) => f?.key === "billSameAsShip");
  };

  const getInlineAlignment = (alignment) => {
    if (alignment === "center") return "center";
    if (alignment === "right") return "end";
    return "start";
  };

  const shouldSkipFieldValidation = (field) =>
    field?.key?.startsWith("bill") &&
    field?.key !== "billSameAsShip" &&
    formData.billSameAsShip === true;

  const getAllFormFields = (items = []) => {
    const flattened = [];
    items.forEach((field) => {
      if (field?.type === "group") {
        flattened.push(...getAllFormFields(field.fields || []));
        return;
      }
      flattened.push(field);
    });
    return flattened;
  };

  const isEmptyFieldValue = (value, field) => {
    if (field?.type === "checkbox") return value !== true;
    if (field?.type === "phone") {
      const countryKey = findPairedKey(field.key, "phone", "country");
      const selectedCountry = countryKey
        ? (formData[countryKey] ?? "IN")
        : "IN";
      const { dialCode } = getPhoneMetaForCountry(selectedCountry);
      return isOnlyDialCode(value, dialCode);
    }
    return String(value ?? "").trim() === "";
  };

  const validateField = (field, value) => {
    if (!field || shouldSkipFieldValidation(field)) return "";
    if (!field.required) return "";

    if (isEmptyFieldValue(value, field)) {
      return `${field.label || "This field"} is required.`;
    }

    if (field.type === "email") {
      const emailValue = String(value || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
        return "Enter a valid email address.";
      }
    }

    return "";
  };

  const validateForm = () => {
    const nextErrors = {};
    getAllFormFields(fields).forEach((field) => {
      const message = validateField(field, formData[field.key]);
      if (message) nextErrors[field.key] = message;
    });
    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const getFieldLabel = (field, fallbackLabel = field?.label) =>
    field?.required ? `${fallbackLabel} *` : fallbackLabel;

  const renderFieldWithMessage = (field, control) => (
    <s-stack direction="block" gap="tight">
      {control}
      {fieldErrors[field.key] && (
        <s-text tone="critical">{fieldErrors[field.key]}</s-text>
      )}
    </s-stack>
  );

  // =============================================
  // AUTO WIDTH DETECTION
  // =============================================
  const getFieldWidthPercent = (field) => {
    if (field?.type === "group") return 100;

    // Explicit config width always wins
    if (typeof field?.width === "number")
      return Math.min(100, Math.max(25, field.width));
    if (field?.width === "half") return 49;
    if (field?.width === "quarter") return 25;
    if (field?.width === "third") return 33;

    const key = normalizeFieldText(field?.key || "");
    const label = normalizeFieldText(field?.label || "");
    const type = normalizeFieldText(field?.type || "");
    const combined = `${key}${label}${type}`;

    // Always full width types
    if (
      [
        "heading",
        "paragraph",
        "link",
        "divider",
        "textarea",
        "checkbox",
      ].includes(field?.type)
    )
      return 100;

    // Full-width address fields
    if (
      type === "country" ||
      combined.includes("addressline1") ||
      combined.includes("address1") ||
      combined.includes("addr1") ||
      combined.includes("addressline2") ||
      combined.includes("address2") ||
      combined.includes("addr2") ||
      combined.includes("apartment") ||
      combined.includes("suite") ||
      combined.includes("company") ||
      combined.includes("email")
    )
      return 100;

    // Half width — firstName & lastName side by side
    if (combined.includes("firstname") || combined.includes("lastname"))
      return 49;

    // Quarter width — city, state, zip, phone in one row
    if (
      combined.includes("city") ||
      type === "state" ||
      combined.includes("state") ||
      combined.includes("province") ||
      combined.includes("zip") ||
      combined.includes("postal") ||
      type === "phone" ||
      combined.includes("phone")
    )
      return 24;

    return 100;
  };

  // =============================================
  // ✅ BUILD ROWS — group fields until row hits 100%
  // =============================================
  const buildFieldRows = (sectionFields) => {
    const rows = [];
    let currentRow = [];
    let currentWidth = 0;

    sectionFields.forEach((field) => {
      const w = getFieldWidthPercent(field);

      if (w >= 100) {
        if (currentRow.length) {
          rows.push([...currentRow]);
          currentRow = [];
          currentWidth = 0;
        }
        rows.push([field]);
        return;
      }

      if (currentWidth + w > 100) {
        rows.push([...currentRow]);
        currentRow = [];
        currentWidth = 0;
      }

      currentRow.push(field);
      currentWidth += w;
    });

    if (currentRow.length) rows.push([...currentRow]);
    return rows;
  };

  // =============================================
  // RENDER ROW
  // =============================================
  const renderRow = (row, rowIndex) => {
    const key = `row-${rowIndex}`;

    if (row.length === 1) {
      const field = row[0];
      return (
        <s-box key={key}>
          {field?.type === "group" ? renderGroup(field) : renderField(field)}
        </s-box>
      );
    }

    return (
      <s-stack key={key} direction="inline" gap="base">
        {row.map((field, fieldIndex) => {
          const w = getFieldWidthPercent(field);
          return (
            <s-box
              key={field.key || `${rowIndex}-${fieldIndex}`}
              inlineSize={`${w}%`}
            >
              {field?.type === "group"
                ? renderGroup(field)
                : renderField(field)}
            </s-box>
          );
        })}
      </s-stack>
    );
  };

  const renderDisplayField = (field) => {
    if (field.type === "divider") return <s-divider />;

    if (field.type === "heading") {
      return (
        <s-box
          inlineSize={`${Math.min(100, Math.max(25, field.headingWidth ?? 100))}%`}
        >
          <s-stack
            direction="block"
            gap="none"
            inlineAlignment={getInlineAlignment(field.headingAlignment)}
          >
            <s-heading>{field.content || field.label}</s-heading>
          </s-stack>
        </s-box>
      );
    }

    if (field.type === "paragraph") {
      const paragraphText = stripHtml(field.content || field.label);
      return paragraphText ? <s-text>{paragraphText}</s-text> : null;
    }

    if (field.type === "link") {
      return (
        <s-stack
          direction="block"
          gap="none"
          inlineAlignment={getInlineAlignment(field.linkAlignment)}
        >
          <s-link
            href={field.linkUrl || "#"}
            target={field.linkOpenInNewTab ? "_blank" : "_self"}
          >
            {field.content || field.label}
          </s-link>
        </s-stack>
      );
    }

    return null;
  };

  // =========================
  // RENDER SINGLE FIELD
  // =========================
  const renderField = (field) => {
    if (["heading", "paragraph", "link", "divider"].includes(field.type)) {
      return renderDisplayField(field);
    }

    switch (field.type) {
      case "select":
        return renderFieldWithMessage(
          field,
          <s-select
            label={getFieldLabel(field)}
            value={formData[field.key] ?? ""}
            onChange={(val) => handleChange(field.key, val)}
          >
            {(field.options || []).map((opt) => (
              <s-option key={opt.value} value={opt.value}>
                {opt.label}
              </s-option>
            ))}
          </s-select>,
        );

      case "checkbox":
        return renderFieldWithMessage(
          field,
          <s-checkbox
            label={field.label}
            checked={formData[field.key] ?? false}
            onChange={(val) => handleChange(field.key, val)}
          />,
        );

      case "textarea":
        return renderFieldWithMessage(
          field,
          <s-text-area
            label={field.label}
            value={formData[field.key] ?? ""}
            onChange={(val) => handleChange(field.key, val)}
          />,
        );

      case "country": {
        const countryOptions = field.options?.length
          ? field.options
          : getCountryOptions();
        const selectedCountry =
          resolveOptionValue(countryOptions, formData[field.key] ?? "IN") ||
          "IN";

        return renderFieldWithMessage(
          field,
          <s-select
            label={field.label}
            value={selectedCountry}
            onChange={(val) => {
              const nextCountry =
                resolveOptionValue(countryOptions, getInputValue(val)) ||
                String(getInputValue(val) ?? "");
              const previousCountry =
                resolveOptionValue(
                  countryOptions,
                  formData[field.key] ?? "IN",
                ) || "IN";

              setFormData((prev) => {
                const updated = { ...prev, [field.key]: nextCountry };

                const stateKey =
                  findPairedKey(field.key, "country", "state") ||
                  findPairedKey(field.key, "country", "province");
                if (stateKey) {
                  const provinces = getProvinceOptions(nextCountry);
                  updated[stateKey] = provinces?.[0]?.value ?? "";
                }

                const phoneKey = findPairedKey(field.key, "country", "phone");
                if (phoneKey) {
                  const { dialCode: newDialCode } =
                    getPhoneMetaForCountry(nextCountry);
                  const currentPhone = String(prev[phoneKey] ?? "").trim();
                  const digits = currentPhone.replace(/^\+\d{1,4}/, "").trim();
                  updated[phoneKey] = digits
                    ? `${newDialCode} ${digits}`
                    : newDialCode;
                }

                if (previousCountry !== nextCountry) {
                  const zipKey =
                    findPairedKey(field.key, "country", "zip") ||
                    findPairedKey(field.key, "country", "postal");
                  if (zipKey) updated[zipKey] = "";
                }

                if (prev["billSameAsShip"] === true) {
                  Object.keys(updated).forEach((k) => {
                    if (k.startsWith("ship")) {
                      const billKey = "bill" + k.slice(4);
                      if (billKey in updated) updated[billKey] = updated[k];
                    }
                  });
                }

                return updated;
              });

              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next[field.key];

                const stateKey =
                  findPairedKey(field.key, "country", "state") ||
                  findPairedKey(field.key, "country", "province");
                if (stateKey) delete next[stateKey];

                const zipKey =
                  findPairedKey(field.key, "country", "zip") ||
                  findPairedKey(field.key, "country", "postal");
                if (zipKey) delete next[zipKey];

                const phoneKey = findPairedKey(field.key, "country", "phone");
                if (phoneKey) delete next[phoneKey];

                return next;
              });
            }}
          >
            <s-option value="">Select a country</s-option>
            {countryOptions.map((opt) => (
              <s-option key={opt.value} value={opt.value}>
                {opt.label}
              </s-option>
            ))}
          </s-select>,
        );
      }

      case "state": {
        const countryKey = findPairedKey(field.key, "state", "country");
        const countryOptions = getCountryOptions();
        const selectedCountry = countryKey
          ? resolveOptionValue(countryOptions, formData[countryKey] ?? "IN") ||
            "IN"
          : "IN";
        const stateOptions = field.options?.length
          ? field.options
          : getProvinceOptions(selectedCountry);
        const currentState = String(formData[field.key] ?? "");
        const resolvedState = resolveOptionValue(stateOptions, currentState);
        const selectedState =
          resolvedState ||
          (currentState === "" ? (stateOptions[0]?.value ?? "") : "");

        return renderFieldWithMessage(
          field,
          <s-select
            label={field.label}
            value={selectedState}
            onChange={(val) => {
              const nextState =
                resolveOptionValue(stateOptions, getInputValue(val)) ||
                String(getInputValue(val) ?? "");
              const previousState = selectedState;

              handleChange(field.key, nextState);
              if (previousState !== nextState) {
                clearPairedZipField(field.key);
              }
            }}
          >
            <s-option value="">Select a state</s-option>
            {stateOptions.length > 0 ? (
              stateOptions.map((opt) => (
                <s-option key={opt.value} value={opt.value}>
                  {opt.label}
                </s-option>
              ))
            ) : (
              <s-option value="">— No states available —</s-option>
            )}
          </s-select>,
        );
      }

      case "phone": {
        const countryKey = findPairedKey(field.key, "phone", "country");
        const selectedCountry = countryKey
          ? (formData[countryKey] ?? "IN")
          : "IN";
        const { dialCode, flagEmoji } = getPhoneMetaForCountry(selectedCountry);
        const currentDigits = getPhoneDigitsWithoutDialCode(
          formData[field.key],
          dialCode,
        );

        return renderFieldWithMessage(
          field,
          <s-stack
            key={`phone-${selectedCountry}`}
            direction="block"
            gap="tight"
          >
            <s-stack direction="inline" gap="small" blockAlignment="end">
              <s-box inlineSize="27%">
                <s-text-field value={`${flagEmoji} ${dialCode}`} disabled />
              </s-box>
              <s-box inlineSize="60%">
                <s-text-field
                  label={getFieldLabel(field, "Phone number")}
                  value={currentDigits}
                  type="tel"
                  inputMode="numeric"
                  placeholder="Enter phone number"
                  onChange={(val) => {
                    const typedValue =
                      val?.target?.value ?? val?.value ?? val ?? "";
                    const digits = sanitizePhoneDigits(typedValue);
                    handleChange(
                      field.key,
                      digits ? `${dialCode} ${digits}` : dialCode,
                    );
                  }}
                />
              </s-box>
            </s-stack>
          </s-stack>,
        );
      }

      // ✅ FIX 2: default case now uses renderFieldWithMessage
      default:
        return renderFieldWithMessage(
          field,
          <s-text-field
            label={getFieldLabel(field)}
            value={formData[field.key] ?? ""}
            onChange={(val) => handleChange(field.key, val)}
          />,
        );
    }
  };

  // ✅ FIX 3: renderGroup no longer references undefined `field`
  const renderGroup = (group) => {
    const colCount = group.fields.length || 2;
    const wideCols = Array(colCount).fill("fill").join(" ");
    return (
      <s-query-container>
        <s-grid
          columns={`@container (inline-size > 480px) '${wideCols}', '1fr'`}
          gap="base"
        >
          {group.fields.map((f) => (
            <s-box key={f.key}>{renderField(f)}</s-box>
          ))}
        </s-grid>
      </s-query-container>
    );
  };

  // ───────────────────────────
  // GROUP FIELDS BY SECTION KEY
  // ───────────────────────────
  const topLevelFields = fields.filter((field) => !field.section);
  const sectionFieldsOnly = fields.filter((field) => field.section);

  const grouped = sectionFieldsOnly.reduce((acc, field) => {
    const section = field.section || "General";
    if (!acc[section]) acc[section] = [];
    acc[section].push(field);
    return acc;
  }, {});

  // ───────────────────────────
  // SUBMIT HANDLER
  // ───────────────────────────
  const handleSubmit = async () => {
    if (!shopDomain) {
      setErrorMessage("Shop domain not loaded yet.");
      return;
    }

    // ✅ FIX 4: Validate before submit — shows inline errors immediately
    if (!validateForm()) return;

    setLoading(true);
    setErrorMessage("");

    try {
      const form = new FormData();
      Object.entries(formData).forEach(([key, value]) => {
        let finalValue =
          typeof value === "boolean" ? (value ? "true" : "false") : value;

        // ✅ FIX 5: Sanitize phone — remove space between dial code and digits
        // "+91 9876543210" → "+919876543210"
        if (typeof finalValue === "string" && /^\+\d+\s/.test(finalValue)) {
          finalValue = finalValue.replace(/\s+/g, "");
        }

        form.append(key, finalValue);
      });

      if (customerId) form.append("shopifyCustomerId", customerId);

      const res = await fetch(
        `${API_URL}/api/proxy/registration?shop=${shopDomain}`,
        { method: "POST", body: form, headers: { Accept: "application/json" } },
      );
      const text = await res.text();
      console.log(text, "text from registration API");

      let result;
      try {
        result = JSON.parse(text);
        console.log(result, "result from registration API");
      } catch {
        throw new Error("Invalid JSON from server");
      }

      if (result.success) {
        setSubmitted(true);
        return;
      }

      // ✅ FIX 6: Map server field errors to inline errors below the exact input
      const rawError = result?.error || "Something went wrong";

      // Server returns "fieldKey: Some message" — parse and match to form field
      const match = rawError.match(/^([a-zA-Z_]+):\s*(.+)$/);
      if (match) {
        const [, serverKey, serverMsg] = match;
        const matchedKey = Object.keys(formData).find((k) =>
          k.toLowerCase().includes(serverKey.toLowerCase()),
        );
        if (matchedKey) {
          setFieldErrors((prev) => ({ ...prev, [matchedKey]: serverMsg }));
          return; // inline error shown — no top banner needed
        }
      }

      // Fallback: no matching field found → show top banner
      setErrorMessage(rawError);
    } catch (err) {
      console.error("Submit ERROR:", err.message);
      setErrorMessage(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  };

  // ═══════════════════════════════════════════════════════════
  //  UI STATES
  // ═══════════════════════════════════════════════════════════

  if (isRedirecting) {
    return (
      <s-box padding="large" inlineAlignment="center" blockAlignment="center">
        <s-stack direction="inline" gap="base" blockAlignment="center">
          <s-spinner size="small" />
          <s-text tone="subdued">Redirecting to your dashboard…</s-text>
        </s-stack>
      </s-box>
    );
  }

  if (checkingStatus) {
    return (
      <s-box padding="large" inlineAlignment="center" blockAlignment="center">
        <s-stack direction="inline" gap="base" blockAlignment="center">
          <s-spinner size="small" />
          <s-text tone="subdued">Checking account status…</s-text>
        </s-stack>
      </s-box>
    );
  }

  if (statusMessage) {
    const bannerTone = statusMessage.toLowerCase().includes("rejected")
      ? "critical"
      : statusMessage.toLowerCase().includes("review")
        ? "warning"
        : "info";
    const bannerTitle =
      bannerTone === "critical"
        ? "Registration Rejected"
        : bannerTone === "warning"
          ? "Under Review"
          : "Account Status";
    return (
      <s-box padding="base">
        <s-banner tone={bannerTone}>
          <s-stack direction="block" gap="small">
            <s-heading>{bannerTitle}</s-heading>
            <s-text>{statusMessage}</s-text>
            {reviewNotes ? (
              <s-text tone="subdued">Note: {reviewNotes}</s-text>
            ) : null}
          </s-stack>
        </s-banner>
      </s-box>
    );
  }

  if (submitted) {
    return (
      <s-box padding="base">
        <s-banner tone="success">
          <s-stack direction="block" gap="small">
            <s-heading>Registration Submitted</s-heading>
            <s-text tone="subdued">
              Your request has been received. We&apos;ll review your details and
              be in touch shortly.
            </s-text>
          </s-stack>
        </s-banner>
      </s-box>
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  MAIN RENDER
  // ═══════════════════════════════════════════════════════════
  return (
    <s-stack direction="block" gap="large">
      {/* ── Top-level fields (no section) ── */}
      {topLevelFields.length > 0 && (
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {buildFieldRows(topLevelFields).map((row, rowIndex) =>
              renderRow(row, rowIndex),
            )}
          </s-stack>
        </s-box>
      )}

      {/* ── Legacy Apple Pay notice ── */}
      {isLegacyApplePay && (
        <s-banner tone="info">
          <s-text>Legacy Apple Pay is currently active on this account.</s-text>
        </s-banner>
      )}

      {/* ── Inline error banner ── */}
      {errorMessage && (
        <s-banner tone="critical">
          <s-stack direction="block" gap="small">
            <s-heading>Submission Error</s-heading>
            <s-text>{errorMessage}</s-text>
          </s-stack>
        </s-banner>
      )}

      {/* ── One s-section per section group ── */}
      {Object.entries(grouped).map(([section, sectionFields]) => {
        const visibleSectionFields = getVisibleSectionFields(
          section,
          sectionFields,
        );
        const sectionMeta = getSectionMeta(section, visibleSectionFields);

        return (
          <s-section key={section} padding>
            <s-stack direction="block" gap="base">
              {/* Section heading + divider */}
              {shouldShowSectionHeading(section, visibleSectionFields) && (
                <s-box inlineSize={`${sectionMeta.width}%`}>
                  <s-stack
                    direction="block"
                    gap="base"
                    inlineAlignment={getInlineAlignment(sectionMeta.alignment)}
                  >
                    <s-heading>{sectionMeta.title}</s-heading>
                    <s-divider />
                  </s-stack>
                </s-box>
              )}

              {/* Fields — row by row */}
              <s-stack direction="block" gap="base">
                {buildFieldRows(visibleSectionFields).map((row, rowIndex) =>
                  renderRow(row, rowIndex),
                )}
              </s-stack>
            </s-stack>
          </s-section>
        );
      })}

    

      {/* ── Submit button (only shown when fields exist) ── */}
      {accountCheckComplete && fields.length === 0 ? (
        <s-banner tone="warning">
          <s-text>
            Registration is currently unavailable. No form fields have been
            configured. Please contact the store administrator.
          </s-text>
        </s-banner>
      ) : fields.length > 0 ? (
        <s-box>
          <s-stack direction="inline" gap="base" blockAlignment="center">
            <s-button
              variant="primary"
              onClick={handleSubmit}
              disabled={loading}
              loading={loading}
            >
              {loading ? "Submitting…" : "Register"}
            </s-button>
            {loading && (
              <s-text tone="subdued">
                Please wait while we process your request…
              </s-text>
            )}
          </s-stack>
        </s-box>
      ) : null}
    </s-stack>
  );
}
