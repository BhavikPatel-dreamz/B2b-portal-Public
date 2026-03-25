// use-strict
import '@shopify/ui-extensions/preact';
import { render } from "preact";
import { useEffect, useState } from 'preact/hooks';



export default async () => {
  render(<Extension />, document.body)
}
const API_URL = "https://b2b-portal-public.vercel.app";

function Extension() {
  const [fields, setFields] = useState([]);
  const [formData, setFormData] = useState({});
  const [isLegacyApplePay, setIsLegacyApplePay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const [checkingStatus, setCheckingStatus] = useState(true);
  const [statusMessage, setStatusMessage] = useState(""); // ✅ NEW: server message (PENDING/REJECTED/APPROVED)

  const [shopDomain, setShopDomain] = useState("");
  const [customerId, setCustomerId] = useState("");

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

  // =========================
  // 1. FETCH SHOP DATA
  // =========================
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
        console.log("Shopify API Response------", data);

        setShopDomain(data?.shop?.myshopifyDomain || "");
        setCustomerId(data?.customer?.id || "");

        if (data?.customer?.metafield?.value === "true") {
          setIsLegacyApplePay(true);
        }
      } catch (err) {
        console.error("Shopify API Error------", err);
        setCheckingStatus(false);
      }
    };

    fetchShopData();
  }, []);

  // =========================
  // 2. FETCH ACCOUNT STATUS
  // =========================
  useEffect(() => {
    if (!shopDomain || !customerId) return;
    const customerIdWithoutPrefix = customerId.replace("gid://shopify/Customer/", "");
    console.log(shopDomain, customerId, "shopDomain111");

    const fetchAccountStatus = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/proxy/customer-account?customerId=${customerIdWithoutPrefix}&shop=${shopDomain}`,
          {
            method: "GET",
            headers: {
              "Accept": "application/json"
            }
          }
        );

        const result = await res.json();

        const { config, message, redirectTo } = result;

        // ✅ If server returned a redirect, go there immediately
        if (redirectTo) {
          window.location.href = redirectTo;
          return;
        }

        // ✅ If server returned a status message (PENDING / REJECTED / APPROVED fallback)
        if (message) {
          setStatusMessage(message);
          return; // stop here — don't load the form
        }

        // ✅ Load form fields only when no message/redirect
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
        : value?.target?.value ??
        value?.value ??
        value ??
        "";

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
  // RENDER FIELD
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

  // =========================
  // GROUP LAYOUT
  // =========================
  const renderGroup = (group) => {
    let size = "100%";
    if (group.layout === "2-col") size = "50%";
    if (group.layout === "3-col") size = "33%";
    if (group.layout === "4-col") size = "25%";

    return (
      <s-inline-stack gap="base">
        {group.fields.map((f) => (
          <s-box key={f.key} inlineSize={size}>
            {renderField(f)}
          </s-box>
        ))}
      </s-inline-stack>
    );
  };

  // =========================
  // GROUP BY SECTION
  // =========================
  const grouped = fields.reduce((acc, field) => {
    const section = field.section || "General";
    if (!acc[section]) acc[section] = [];
    acc[section].push(field);
    return acc;
  }, {});

  // =========================
  // SUBMIT
  // =========================
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

      if (customerId) {
        form.append("shopifyCustomerId", customerId);
      }

      console.log("📤 Sending:", Object.fromEntries(form.entries()));

      const res = await fetch(
        `${API_URL}/api/proxy/registration`,
        {
          method: "POST",
          body: form,
          headers: { Accept: "application/json" },
        }
      );

      const text = await res.text();
      console.log("RAW RESPONSE:", text);

      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error("Invalid JSON from server");
      }

      console.log("Parsed Result:", result);

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

  // =========================
  // UI STATES
  // =========================

  // 1. Loading
  if (checkingStatus) {
    return <s-text>Checking account status...</s-text>;
  }

  // 2. ✅ Server message (PENDING / REJECTED / APPROVED without redirect)
  if (statusMessage) {
    const bannerStatus =
      statusMessage.toLowerCase().includes("rejected") ? "critical" :
        statusMessage.toLowerCase().includes("review") ? "warning" :
          "info";

    return (
      <s-banner status={bannerStatus}>
        <s-text>{statusMessage}</s-text>
      </s-banner>
    );
  }

  // 3. Submitted successfully
  if (submitted) {
    return (
      <s-banner status="success">
        <s-text>Request submitted successfully.</s-text>
      </s-banner>
    );
  }

  // =========================
  // FORM UI
  // =========================
  return (
    <s-stack gap="base">
      <s-banner>
        <s-text>
          {isLegacyApplePay ? "Legacy Apple Pay Active" : "Customer Account"}
        </s-text>
      </s-banner>

      {errorMessage && (
        <s-banner status="critical">
          <s-text>{errorMessage}</s-text>
        </s-banner>
      )}

      {Object.entries(grouped).map(([section, sectionFields]) => (
        <s-stack key={section} gap="base">
          <s-text appearance="heading-md">{section}</s-text>

          {sectionFields.map((field, i) =>
            field.type === "group" ? (
              <s-box key={i}>{renderGroup(field)}</s-box>
            ) : (
              <s-box key={i}>{renderField(field)}</s-box>
            )
          )}
        </s-stack>
      ))}

      <s-button kind="primary" onClick={handleSubmit} disabled={loading}>
        {loading ? "Submitting..." : "Register"}
      </s-button>
    </s-stack>
  );
}


