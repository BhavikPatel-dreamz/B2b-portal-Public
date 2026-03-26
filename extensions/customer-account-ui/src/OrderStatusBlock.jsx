// use-strict
import '@shopify/ui-extensions/preact';
import { render } from "preact";
import { useEffect, useState } from 'preact/hooks';


export default async () => {
  render(<Extension />, document.body)
}
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
  const [isRedirecting, setIsRedirecting] = useState(false); // ← NEW

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
          setIsRedirecting(true); // ← NEW: show spinner before redirect
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
          const processFields = (arr) => {
            arr.forEach((f) => {
              if (f.type === "group") {
                processFields(f.fields);
              } else if (f.type === "checkbox") {
                initial[f.key] = false;
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
            options={field.options || []}
          />
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

  // 1. Redirecting to dashboard — keep spinner visible during navigation
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

  // 2. Checking status — native s-spinner with subdued label
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
 
  // 2. Server status message — tone replaces old `status` prop (2026-01)
  if (statusMessage) {
    const bannerTone =
      statusMessage.toLowerCase().includes("rejected")
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
 
  // 3. Success confirmation
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
 
            {/* Section heading + divider */}
            <s-heading>{section}</s-heading>
            <s-divider />
 
            {/* Fields: groups → responsive s-grid; singles → stacked s-box */}
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
          {/*
            variant="primary" is the correct 2026-01 prop.
            loading prop shows a native Polaris spinner inside the button.
          */}
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
 



