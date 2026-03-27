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

function Extension() {
  const [fields, setFields] = useState([]);
  const [formData, setFormData] = useState({});
  const [isLegacyApplePay, setIsLegacyApplePay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [shopDomain, setShopDomain] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [isRedirecting, setIsRedirecting] = useState(false);

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

  // ── Country → States mapping ──────────────────────────────────────────────
  const COUNTRY_STATES = {
    IN: [
      { value: "GJ", label: "Gujarat" },
      { value: "MH", label: "Maharashtra" },
      { value: "RJ", label: "Rajasthan" },
      { value: "DL", label: "Delhi" },
      { value: "KA", label: "Karnataka" },
      { value: "TN", label: "Tamil Nadu" },
      { value: "UP", label: "Uttar Pradesh" },
      { value: "WB", label: "West Bengal" },
    ],
    US: [
      { value: "CA", label: "California" },
      { value: "TX", label: "Texas" },
      { value: "NY", label: "New York" },
      { value: "FL", label: "Florida" },
      { value: "IL", label: "Illinois" },
      { value: "WA", label: "Washington" },
      { value: "AZ", label: "Arizona" },
      { value: "GA", label: "Georgia" },
    ],
    CA: [
      { value: "ON", label: "Ontario" },
      { value: "BC", label: "British Columbia" },
      { value: "AB", label: "Alberta" },
      { value: "QC", label: "Quebec" },
      { value: "MB", label: "Manitoba" },
    ],
    UK: [
      { value: "ENG", label: "England" },
      { value: "SCT", label: "Scotland" },
      { value: "WLS", label: "Wales" },
      { value: "NIR", label: "Northern Ireland" },
    ],
    AU: [
      { value: "NSW", label: "New South Wales" },
      { value: "VIC", label: "Victoria" },
      { value: "QLD", label: "Queensland" },
      { value: "WA",  label: "Western Australia" },
      { value: "SA",  label: "South Australia" },
    ],
  };

  const DUMMY_COUNTRIES = [
    { value: "IN", label: "India" },
    { value: "US", label: "United States" },
    { value: "CA", label: "Canada" },
    { value: "UK", label: "United Kingdom" },
    { value: "AU", label: "Australia" },
  ];

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
                initial[f.key] = "IN"; // ✅ default country
              } else if (f.type === "state") {
                initial[f.key] = COUNTRY_STATES["IN"][0].value; // ✅ default state = "GJ"
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

  // =========================
  // RENDER SINGLE FIELD
  // =========================
  const renderField = (field) => {
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
        const countryOptions = field.options || DUMMY_COUNTRIES;
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
                  ? COUNTRY_STATES[val]?.[0]?.value || ""
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

        const stateOptions =
          field.options || (selectedCountry ? COUNTRY_STATES[selectedCountry] || [] : []);

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
  const grouped = fields.reduce((acc, field) => {
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

      {/* ── Page header ── */}
      <s-box padding="base">
        <s-stack direction="block" gap="small">
          <s-heading>
            {isLegacyApplePay ? "Legacy Apple Pay" : "Company Registration"}
          </s-heading>
          <s-text tone="subdued">
            {isLegacyApplePay
              ? "Your account is configured with Legacy Apple Pay."
              : "Fill in the details below to register your company and unlock wholesale access."}
          </s-text>
        </s-stack>
      </s-box>

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
      {Object.entries(grouped).map(([section, sectionFields]) => (
        <s-section key={section} padding>
          <s-stack direction="block" gap="base">

            <s-heading>{section}</s-heading>
            <s-divider />

            <s-stack direction="block" gap="base">
              {sectionFields.map((field, i) =>
                field.type === "group" ? (
                  <s-box key={i}>{renderGroup(field)}</s-box>
                ) : (
                  <s-box key={i}>{renderField(field)}</s-box>
                )
              )}
            </s-stack>

          </s-stack>
        </s-section>
      ))}

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
 


