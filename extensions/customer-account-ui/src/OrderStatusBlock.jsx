// use-strict
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};
const API_URL = "https://b2b-portal-public.vercel.app";
// "https://dd-79.dynamicdreamz.com"
// "https://b2b-portal-public.vercel.app";

const SECTION_LABELS = {
  company: "Company information",
  contact: "Contact information",
  shipping: "Shipping address",
  billing: "Billing address",
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
  const [shopDomain, setShopDomain] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [countriesData, setCountriesData] = useState([]);

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
          }
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
      ""
    );

    const fetchAccountStatus = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/proxy/customer-account?customerId=${customerIdWithoutPrefix}&shop=${shopDomain}`,
          { method: "GET", headers: { Accept: "application/json" } }
        );
        const result = await res.json();
        const { config, message, redirectTo } = result;
        if (redirectTo) {
          setIsRedirecting(true);
          window.location.href = redirectTo;
          return;
        }
        if (message) {
          setStatusMessage(message);
          return;
        }
        if (config?.fields) {
          setFields(config.fields);
          const initial = {};

          // ✅ FIX: initialize country/state with defaults
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
      } catch (err) {
        console.error("Account API Error:", err);
      } finally {
        setCheckingStatus(false);
      }
    };
    fetchAccountStatus();
  }, [shopDomain, customerId]);

  useEffect(() => {
    if (!shopDomain || !customerId) return;

    const customerIdWithoutPrefix = customerId.replace(
      "gid://shopify/Customer/",
      ""
    );

    const fetchCustomerDetails = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/proxy/customer-detail?customerId=${customerIdWithoutPrefix}&shop=${shopDomain}`,
          { method: "GET", headers: { Accept: "application/json" } }
        );
        const result = await res.json();

        if (!res.ok) {
          throw new Error(result?.error || "Failed to fetch customer details");
        }

        setCustomerDetails(result?.customer || null);
      } catch (err) {
        console.error("Customer detail API Error:", err);
      }
    };

    fetchCustomerDetails();
  }, [shopDomain, customerId]);

  useEffect(() => {
    if (!shopDomain) return;

    const fetchCountries = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/proxy/shipping-zones?shop=${shopDomain}`,
          { method: "GET", headers: { Accept: "application/json" } }
        );
        const { countries } = await res.json();
        setCountriesData(countries || []);
      } catch (err) {
        console.error("Countries fetch error:", err);
      }
    };

    fetchCountries();
  }, [shopDomain]);

  // =========================
  // HANDLE CHANGE
  // =========================
  const handleChange = (key, value) => {
    const finalValue =
      value?.target?.checked !== undefined
        ? value.target.checked
        : value?.target?.value ?? value?.value ?? value ?? "";

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
          if (k.startsWith("bill") && k !== "billSameAsShip") {
            updated[k] = "";
          }
        });
      }
      if (key.startsWith("ship") && prev["billSameAsShip"] === true) {
        const billKey = "bill" + key.slice(4);
        if (billKey in prev) updated[billKey] = finalValue;
      }
      return updated;
    });
  };

  // ── Helper: find the paired key in formData ──────────────────────────────
  const findPairedKey = (sourceKey, findWord, replaceWord) => {
    const variants = [
      sourceKey.replace(new RegExp(findWord, "i"), replaceWord),
      sourceKey.replace(
        new RegExp(findWord, "i"),
        replaceWord.charAt(0).toUpperCase() + replaceWord.slice(1)
      ),
      sourceKey.replace(
        new RegExp(findWord.charAt(0).toUpperCase() + findWord.slice(1)),
        replaceWord.charAt(0).toUpperCase() + replaceWord.slice(1)
      ),
    ];
    return variants.find((v) => v in formData) ?? null;
  };

  const getCountryOptions = () => countriesData.map(c => ({ value: c.value, label: c.label }));

  // Replaces COUNTRY_STATES[code] usage
  const getProvinceOptions = (countryCode) => {
    const found = countriesData.find(c => c.value === countryCode);
    return found?.provinces || [];
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

  const getAutofillValue = (field) => {
    if (!customerDetails) return "";

    const key = normalizeFieldText(field?.key);
    const label = normalizeFieldText(field?.label);
    const fieldType = normalizeFieldText(field?.type);
    const combined = `${key}${label}${fieldType}`;

    if (fieldType === "email" || combined.includes("email")) {
      return customerDetails.email || "";
    }

    if (combined.includes("firstname")) {
      return customerDetails.firstName || "";
    }

    if (combined.includes("lastname")) {
      return customerDetails.lastName || "";
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
          if (currentValue === undefined || currentValue === null || currentValue === "") {
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
      (field) =>
        typeof field.sectionLabel === "string" && field.sectionLabel.trim() !== ""
    );
    console.log(fieldWithSectionLabel?.sectionLabel,"testttt");
    const fieldWithHeadingWidth = sectionFields.find(
      (field) => typeof field.sectionHeadingWidth === "number"
    );
    const fieldWithHeadingAlignment = sectionFields.find(
      (field) => field.sectionHeadingAlignment
    );
    const fieldWithHeadingHidden = sectionFields.find(
      (field) => typeof field.sectionHeadingHidden === "boolean"
    );
    console.log(sectionFields ,"fieldWithHeadingWidth?.sectionHeadingWidth ");

    return {
      title:
        fieldWithSectionLabel?.sectionLabel?.trim() ||
        SECTION_LABELS[section] ||
        section,
      width: Math.min(
        100,
        Math.max(25, fieldWithHeadingWidth?.sectionHeadingWidth ?? 100)
      ),
      alignment: fieldWithHeadingAlignment?.sectionHeadingAlignment || "left",
      hidden: fieldWithHeadingHidden?.sectionHeadingHidden ?? false,
    };
  };

  const shouldShowSectionHeading = (section, sectionFields) => {
    return !getSectionMeta(section, sectionFields).hidden;
  };

  const getInlineAlignment = (alignment) => {
    if (alignment === "center") return "center";
    if (alignment === "right") return "end";
    return "start";
  };

  const getFieldWidthPercent = (field) => {
    if (field?.type === "group") return 100;
    if (typeof field?.width === "number") {
      return Math.min(100, Math.max(25, field.width));
    }
    if (field?.width === "half") return 50;
    return 100;
  };

  const buildFieldRows = (sectionFields) => {
    const rows = [];
    let currentRow = [];
    let currentWidth = 0;

    sectionFields.forEach((field) => {
      const fieldWidth = getFieldWidthPercent(field);

      if (fieldWidth >= 100) {
        if (currentRow.length) {
          rows.push([...currentRow]);
          currentRow = [];
          currentWidth = 0;
        }
        rows.push([field]);
        return;
      }

      if (currentWidth + fieldWidth > 100) {
        console.log(currentRow,"currentRow1111");
        rows.push([...currentRow]);
        currentRow = [];
        currentWidth = 0;
      }

      currentRow.push(field);
      currentWidth += fieldWidth;
    });

    if (currentRow.length) rows.push([...currentRow]);
    return rows;
  };

  const getRowColumns = (row) => {
    if (row.length <= 1) return null;
    const columns = row
      .map((field) => `${getFieldWidthPercent(field)}fr`)
      .join(" ");

    return `@container (inline-size > 480px) '${columns}', '1fr'`;
  };

  const getFieldMinHeight = (field) => {
    switch (field?.type) {
      case "textarea":
      case "paragraph":
        return 120;
      case "checkbox":
      case "divider":
        return "auto";
      case "heading":
        return 40;
      case "link":
        return 28;
      default:
        return 72;
    }
  };

  const renderFieldBox = (field, key) => (
    <s-box key={key}>
      <s-stack direction="block" gap={getFieldMinHeight(field) >= 120 ? "base" : "none"}>
        {field?.type === "group" ? renderGroup(field) : renderField(field)}
      </s-stack>
    </s-box>
  );

  const renderDisplayField = (field) => {
    if (field.type === "divider") {
      return <s-divider />;
    }

    if (field.type === "heading") {
      return (
        <s-box inlineSize={`${Math.min(100, Math.max(25, field.headingWidth ?? 100))}%`}>
          <s-stack direction="block" gap="none" inlineAlignment={getInlineAlignment(field.headingAlignment)}>
            <s-heading>{field.content || field.label}</s-heading>
          </s-stack>
        </s-box>
      );
    }

    if (field.type === "paragraph") {
      const paragraphText = stripHtml(field.content || field.label);
      return paragraphText ? (
        <s-text>{paragraphText}</s-text>
      ) : null;
    }

    if (field.type === "link") {
      return (
        <s-stack direction="block" gap="none" inlineAlignment={getInlineAlignment(field.linkAlignment)}>
          <s-link href={field.linkUrl || "#"} target={field.linkOpenInNewTab ? "_blank" : "_self"}>
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
        return (
          <s-select
            label={field.label}
            value={formData[field.key] ?? ""}
            onChange={(val) => handleChange(field.key, val)}
          >
            {(field.options || []).map((opt) => (
              <s-option
                key={opt.value}
                value={opt.value}
                defaultSelected={formData[field.key] === opt.value}
              >
                {opt.label}
              </s-option>
            ))}
          </s-select>
        );

      case "checkbox":
        return (
          <s-checkbox
            label={field.label}
            checked={formData[field.key] ?? false}
            onChange={(val) => handleChange(field.key, val)}
          />
        );

      case "textarea":
        return (
          <s-text-area
            label={field.label}
            value={formData[field.key] ?? ""}
            onChange={(val) => handleChange(field.key, val)}
          />
        );

      case "country": {
        const countryOptions = field.options?.length
          ? field.options
          : getCountryOptions();
        const selectedCountry = formData[field.key] ?? "IN";

        return (
          <s-select
            label={field.label}
            value={selectedCountry}
            onChange={(val) => {
              handleChange(field.key, val);
              const stateKey = findPairedKey(field.key, "country", "state");
              if (stateKey) {
                const firstState = val
                  ? getProvinceOptions(val)?.[0]?.value ?? ""
                  : "";
                handleChange(stateKey, firstState);
              }
            }}
          >
            <s-option value="">Select a country</s-option>
            {countryOptions.map((opt) => (
              <s-option
                key={opt.value}
                value={opt.value}
                defaultSelected={selectedCountry === opt.value}
              >
                {opt.label}
              </s-option>
            ))}
          </s-select>
        );
      }

      case "state": {
        const countryKey = findPairedKey(field.key, "state", "country");
        const selectedCountry = countryKey ? (formData[countryKey] ?? "IN") : "IN";

        const stateOptions = field.options?.length
          ? field.options
          : getProvinceOptions(selectedCountry);

        const selectedState =
          formData[field.key] ?? stateOptions[0]?.value ?? "";

        return (
          <s-select
            label={field.label}
            value={selectedState}
            onChange={(val) => handleChange(field.key, val)}
          >
            <s-option value="">Select a state</s-option>
            {stateOptions.length > 0 ? (
              stateOptions.map((opt) => (
                <s-option
                  key={opt.value}
                  value={opt.value}
                  defaultSelected={selectedState === opt.value}
                >
                  {opt.label}
                </s-option>
              ))
            ) : (
              <s-option value="" defaultSelected>
                — No states available —
              </s-option>
            )}
          </s-select>
        );
      }

      case "phone":
        return (
          <s-phone-field
            label={field.label}
            value={formData[field.key] ?? ""}
            onChange={(val) => handleChange(field.key, val)}
          />
        );

      default:
        return (
          <s-text-field
            label={field.label}
            value={formData[field.key] ?? ""}
            onChange={(val) => handleChange(field.key, val)}
          />
        );
    }
  };

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
    setLoading(true);
    setErrorMessage("");

    try {
      const form = new FormData();
      Object.entries(formData).forEach(([key, value]) => {
        form.append(
          key,
          typeof value === "boolean" ? (value ? "true" : "false") : value
        );
      });
      if (customerId) form.append("shopifyCustomerId", customerId);

      const res = await fetch(
        `${API_URL}/api/proxy/registration?shop=${shopDomain}`,
        { method: "POST", body: form, headers: { Accept: "application/json" } }
      );
      const text = await res.text();

      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error("Invalid JSON from server");
      }

      if (!res.ok) {
        setErrorMessage(result?.error || "Request failed");
        return;
      }
      if (result.success) {
        setSubmitted(true);
        return;
      }
      setErrorMessage(result.error || "Something went wrong");
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

  // 1. Redirecting
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

  // 2. Checking status
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

  // 3. Server status message
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
          </s-stack>
        </s-banner>
      </s-box>
    );
  }

  // 4. Success confirmation
  if (submitted) {
    return (
      <s-box padding="base">
        <s-banner tone="success">
          <s-stack direction="block" gap="small">
            <s-heading>Registration Submitted</s-heading>
            <s-text tone="subdued">
              Your request has been received. We'll review your details and be
              in touch shortly.
            </s-text>
          </s-stack>
        </s-banner>
      </s-box>
    );
  }

  return (
    <s-stack direction="block" gap="large">
      {topLevelFields.length > 0 && (
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {buildFieldRows(topLevelFields).map((row, rowIndex) =>
              row.length > 1 ? (
                <s-query-container key={rowIndex}>
                  <s-grid columns={getRowColumns(row)} gap="base">
                    {row.map((field, fieldIndex) =>
                      renderFieldBox(field, `${rowIndex}-${field.key || fieldIndex}`)
                    )}
                  </s-grid>
                </s-query-container>
              ) : (
                renderFieldBox(row[0], `${rowIndex}-${row[0]?.key || rowIndex}`)
              )
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

      {/* ── One s-section card per section group ── */}
      {Object.entries(grouped).map(([section, sectionFields]) => {
        const sectionMeta = getSectionMeta(section, sectionFields);

        return (
        <s-section key={section} padding>
          <s-stack direction="block" gap="base">
            {shouldShowSectionHeading(section, sectionFields) && (
              <s-box inlineSize={`${sectionMeta.width}%`}>
                <s-stack direction="block" gap="base" inlineAlignment={getInlineAlignment(sectionMeta.alignment)}>
                  <s-heading>{sectionMeta.title}</s-heading>
                  <s-divider />
                </s-stack>
              </s-box>
            )}

            <s-stack direction="block" gap="base">
              {buildFieldRows(sectionFields).map((row, rowIndex) =>
                row.length > 1 ? (
                  <s-query-container key={rowIndex}>
                    <s-grid columns={getRowColumns(row)} gap="base">
                      {row.map((field, fieldIndex) =>
                        renderFieldBox(field, `${rowIndex}-${field.key || fieldIndex}`)
                      )}
                    </s-grid>
                  </s-query-container>
                ) : (
                  renderFieldBox(row[0], `${rowIndex}-${row[0]?.key || rowIndex}`)
                )
              )}
            </s-stack>

          </s-stack>
        </s-section>
        );
      })}

      {/* ── Submit button row ── */}
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

    </s-stack>
  );
}
