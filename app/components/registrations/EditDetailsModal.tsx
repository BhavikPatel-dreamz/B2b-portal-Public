import type { CSSProperties, Dispatch, SetStateAction } from "react";


type CountryOption = {
  value: string;
  label: string;
};

type FieldWidth = "full" | "half";

type FormField = {
  key: string;
  label: string;
  type: "text" | "email" | "phone" | "select" | "readonly" | "checkbox" | "textarea";
  section: string;
  order: number;
  width?: FieldWidth;
  readOnly?: boolean;
  readOnlyHint?: string;
  options?: CountryOption[];
  countryCode?: string;
  flagEmoji?: string;
};

type FormSection = {
  key: string;
  label: string;
  order: number;
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #c9ccd0",
  fontSize: 14,
  boxSizing: "border-box",
  background: "white",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  marginBottom: 5,
};

const sectionStyle: CSSProperties = {
  border: "1px solid #e3e3e3",
  borderRadius: 10,
  padding: "14px 16px",
  display: "grid",
  gap: 10,
};

const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 4px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#5c5f62",
};

const COUNTRY_PHONE_META: Record<string, { dialCode: string; flagEmoji: string }> = {
  IN: { dialCode: "+91", flagEmoji: "🇮🇳" },
  INDIA: { dialCode: "+91", flagEmoji: "🇮🇳" },
  US: { dialCode: "+1", flagEmoji: "🇺🇸" },
  USA: { dialCode: "+1", flagEmoji: "🇺🇸" },
  "UNITED STATES": { dialCode: "+1", flagEmoji: "🇺🇸" },
  GB: { dialCode: "+44", flagEmoji: "🇬🇧" },
  UK: { dialCode: "+44", flagEmoji: "🇬🇧" },
  "UNITED KINGDOM": { dialCode: "+44", flagEmoji: "🇬🇧" },
  AU: { dialCode: "+61", flagEmoji: "🇦🇺" },
  AUSTRALIA: { dialCode: "+61", flagEmoji: "🇦🇺" },
  CA: { dialCode: "+1", flagEmoji: "🇨🇦" },
  CANADA: { dialCode: "+1", flagEmoji: "🇨🇦" },
};

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  INDIA: "IN",
  "UNITED STATES": "US",
  USA: "US",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  AUSTRALIA: "AU",
  CANADA: "CA",
};

function normalizeCountryCode(countryValue?: string | null) {
  const normalized = (countryValue || "").trim().toUpperCase();
  return COUNTRY_CODE_ALIASES[normalized] || normalized;
}

function getPhoneMetaForCountry(countryValue?: string | null) {
  const normalized = normalizeCountryCode(countryValue);
  return COUNTRY_PHONE_META[normalized] || { dialCode: "+91", flagEmoji: "🇮🇳" };
}

function getProvinceOptionsForCountry(
  countryValue?: string | null,
  shippingProvincesByCountry?: Record<string, CountryOption[]>,
) {
  const normalized = normalizeCountryCode(countryValue);
  const dynamicProvinceOptions = shippingProvincesByCountry?.[normalized] || [];

  if (dynamicProvinceOptions.length > 0) {
    const hasPlaceholder = dynamicProvinceOptions.some((option) => option.value === "");
    return hasPlaceholder
      ? dynamicProvinceOptions
      : [{ value: "", label: "State / Province" }, ...dynamicProvinceOptions];
  }

  return [{ value: "", label: "State / Province" }];
}

const shippingBillingFieldLabels: Record<string, string> = {
  shipCountry: "Country/region",
  billCountry: "Country/region",
  shCountry: "Country/region",
  biCountry: "Country/region",
  shipFirstName: "First name",
  billFirstName: "First name",
  shFirstName: "First name",
  biFirstName: "First name",
  shipLastName: "Last name",
  billLastName: "Last name",
  shLastName: "Last name",
  biLastName: "Last name",
  shipDept: "Company/attention",
  billDept: "Company/attention",
  shDepartment: "Company/attention",
  biDepartment: "Company/attention",
  shipAddr1: "Address",
  billAddr1: "Address",
  shAddr1: "Address",
  biAddr1: "Address",
  shipAddr2: "Apartment, suite, etc",
  billAddr2: "Apartment, suite, etc",
  shAddr2: "Apartment, suite, etc",
  biAddr2: "Apartment, suite, etc",
  shipCity: "City",
  billCity: "City",
  shCity: "City",
  biCity: "City",
  shipState: "State",
  billState: "State",
  shState: "State",
  biState: "State",
  shipZip: "PIN code",
  billZip: "PIN code",
  shZip: "PIN code",
  biZip: "PIN code",
  shipPhone: "Phone",
  billPhone: "Phone",
  shPhone: "Phone",
  biPhone: "Phone",
};

function getFieldLabel(field: FormField) {
  return shippingBillingFieldLabels[field.key] || field.label;
}

function getFieldPlaceholder(field: FormField) {
  const label = getFieldLabel(field);
  if (/state/i.test(field.key)) return "Select a state";
  if (/addr1/i.test(field.key)) return "";
  return `Add ${label}`;
}

function getFieldGridSpan(field: FormField) {
  if (field.width === "full") return "1 / -1";
  if (/Country|Dept|Addr1|Addr2|Phone/.test(field.key)) return "1 / -1";
  return undefined;
}

function sortSectionFields(section: string, fields: FormField[]) {
  const preferredOrder =
    section === "shipping" || section === "billing"
      ? [
          "Country",
          "FirstName",
          "LastName",
          "Dept",
          "Department",
          "Addr1",
          "Addr2",
          "City",
          "State",
          "Zip",
          "Phone",
        ]
      : [];

  const score = (key: string) => {
    const index = preferredOrder.findIndex((token) => key.includes(token));
    return index === -1 ? preferredOrder.length : index;
  };

  return [...fields].sort((a, b) => {
    const scoreDiff = score(a.key) - score(b.key);
    if (scoreDiff !== 0) return scoreDiff;
    return a.order - b.order;
  });
}

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string;
  onChange: (val: string) => void;
}) {
  const hasValue = value !== undefined && value !== null && value !== "";
  const showFieldLabel = field.type !== "checkbox";
  const addStyle: CSSProperties = hasValue ? {} : { borderStyle: "dashed", opacity: 0.75 };
  const displayLabel = getFieldLabel(field);
  const placeholder = getFieldPlaceholder(field);

  switch (field.type) {
    case "readonly":
      return (
        <div>
          {showFieldLabel ? <label style={labelStyle}>{displayLabel}</label> : null}
          <input
            value={value || ""}
            readOnly
            placeholder={displayLabel}
            style={{
              ...inputStyle,
              background: "#f3f4f6",
              color: "#9ca3af",
              cursor: "not-allowed",
              border: "1px solid #e5e7eb",
            }}
          />
          {field.readOnlyHint ? (
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3, paddingLeft: 2 }}>
              {field.readOnlyHint}
            </div>
          ) : null}
        </div>
      );

    case "phone":
      return (
        <div>
          {showFieldLabel ? <label style={labelStyle}>{displayLabel}</label> : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "58px minmax(0, 1fr)",
              gap: 8,
              alignItems: "center",
            }}
          >
            <div
              style={{
                ...inputStyle,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "8px 6px",
              }}
            >
              <span>{field.flagEmoji}</span>
              <span style={{ color: "#9ca3af" }}>▾</span>
            </div>
            <input
              placeholder={placeholder}
              value={value || ""}
              onChange={(e) => onChange(e.target.value)}
              style={{ ...inputStyle, ...addStyle, boxShadow: "0 0 0 2px #2563eb inset" }}
            />
          </div>
        </div>
      );

    case "select":
      return (
        <div>
          {showFieldLabel ? <label style={labelStyle}>{displayLabel}</label> : null}
          <select
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, ...addStyle }}
          >
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );

    case "checkbox":
      return (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
            color: "#374151",
            fontSize: 14,
          }}
        >
          <input
            type="checkbox"
            checked={value === "true" || value === "1" || value === "yes"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          />
          {field.label}
        </label>
      );

    case "textarea":
      return (
        <div>
          {showFieldLabel ? <label style={labelStyle}>{displayLabel}</label> : null}
          <textarea
            placeholder={placeholder}
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            style={{
              ...inputStyle,
              ...addStyle,
              minHeight: 92,
              resize: "vertical",
              paddingTop: 10,
            }}
          />
        </div>
      );

    default:
      return (
        <div>
          {showFieldLabel ? <label style={labelStyle}>{displayLabel}</label> : null}
          <input
            placeholder={placeholder}
            value={value || ""}
            type={field.type === "email" ? "email" : "text"}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, ...addStyle }}
          />
        </div>
      );
  }
}

export default function EditDetailsModal({
  editForm,
  setEditForm,
  onClose,
  onSave,
  sections = [],
  fields = [],
  shippingProvincesByCountry = {},
}: {
  editForm: Record<string, any>;
  setEditForm: Dispatch<SetStateAction<Record<string, any>>>;
  onClose: () => void;
  onSave: () => void;
  sections?: FormSection[];
  fields?: FormField[];
  shippingProvincesByCountry?: Record<string, CountryOption[]>;
}) {
  const sortedSections = [...sections].sort((a, b) => a.order - b.order);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17,24,39,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(560px, 96vw)",
          background: "#f8f8f8",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
          maxHeight: "92vh",
          overflowY: "auto",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e3e3e3",
            background: "white",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            position: "sticky",
            top: 0,
            zIndex: 1,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Edit details</h3>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: 20,
              cursor: "pointer",
              color: "#5c5f62",
              lineHeight: 1,
              padding: "0 2px",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: "16px 20px", display: "grid", gap: 14 }}>
          {sortedSections.map((section) => {
            const sectionFields = sortSectionFields(
              section.key,
              fields.filter((f) => f.section === section.key),
            );

            if (sectionFields.length === 0) return null;

            const isBilling = section.key === "billing";

            return (
              <div key={section.key} style={sectionStyle}>
                {isBilling ? (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <h4 style={{ ...sectionHeadingStyle, margin: 0 }}>{section.label}</h4>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 13,
                        cursor: "pointer",
                        color: "#374151",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!editForm.useSameAddress}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, useSameAddress: e.target.checked }))
                        }
                      />
                      Same as shipping
                    </label>
                  </div>
                ) : (
                  <h4 style={sectionHeadingStyle}>{section.label}</h4>
                )}

                {isBilling && editForm.useSameAddress ? null : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {sectionFields.map((field) => {
                      const countryValue =
                        field.section === "billing"
                          ? editForm.billCountry ??
                            editForm.biCountry
                          : field.section === "shipping"
                            ? editForm.shipCountry ??
                              editForm.shCountry
                            : editForm.shipCountry ??
                              editForm.shCountry;
                      const phoneMeta =
                        field.type === "phone"
                          ? getPhoneMetaForCountry(String(countryValue ?? ""))
                          : null;
                      const stateOptions =
                        field.type === "select" && /state/i.test(field.key)
                          ? getProvinceOptionsForCountry(
                              String(countryValue ?? ""),
                              shippingProvincesByCountry,
                            )
                          : null;

                      return (
                        <div
                          key={field.key}
                          style={{
                            gridColumn: getFieldGridSpan(field),
                          }}
                        >
                          <DynamicField
                            field={{
                              ...field,
                              ...(phoneMeta
                                ? {
                                    countryCode: phoneMeta.dialCode,
                                    flagEmoji: phoneMeta.flagEmoji,
                                  }
                                : {}),
                              ...(stateOptions ? { options: stateOptions } : {}),
                            }}
                            value={String(editForm[field.key] ?? "")}
                            onChange={(val) =>
                              setEditForm((f) => ({ ...f, [field.key]: val }))
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e3e3e3",
            background: "white",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            position: "sticky",
            bottom: 0,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #c9ccd0",
              background: "white",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "#1a1a1a",
              color: "white",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

export type { CountryOption, FormField, FormSection };
