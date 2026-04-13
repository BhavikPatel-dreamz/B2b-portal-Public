import type { CSSProperties, Dispatch, SetStateAction } from "react";

type CountryOption = {
  value: string;
  label: string;
};

type FieldWidth = "full" | "half";

type PhoneCountryOption = {
  value: string;
  label: string;
  dialCode: string;
  flagEmoji: string;
};

type FormField = {
  key: string;
  label: string;
  type:
    | "text"
    | "email"
    | "phone"
    | "select"
    | "readonly"
    | "checkbox"
    | "textarea";
  section: string;
  order: number;
  width?: FieldWidth;
  readOnly?: boolean;
  readOnlyHint?: string;
  options?: CountryOption[];
  countryCode?: string;
  flagEmoji?: string;
  phoneCountryOptions?: PhoneCountryOption[];
  phoneCountryValue?: string;
  phoneDefaultCountry?: string;
};

type FormSection = {
  key: string;
  label: string;
  order: number;
};

type DisplayBlock = {
  key: string;
  type: "heading" | "paragraph";
  order: number;
  content?: string;
  label?: string;
  headingTag?: "h1" | "h2" | "h3" | "h4";
  headingAlignment?: "left" | "center" | "right";
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

const COUNTRY_PHONE_META: Record<
  string,
  { dialCode: string; flagEmoji: string }
> = {
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

function getResolvedSectionCountryValue(
  field: FormField,
  editForm: Record<string, any>,
) {
  const configuredCountryValue =
    field.section === "billing"
      ? editForm.billCountry
      : field.section === "shipping"
        ? editForm.shipCountry
        : undefined;
  const legacyCountryValue =
    field.section === "billing"
      ? editForm.biCountry
      : field.section === "shipping"
        ? editForm.shCountry
        : undefined;

  return (
    String(
      configuredCountryValue ??
        legacyCountryValue ??
        field.phoneDefaultCountry ??
        "",
    ).trim()
  );
}

function getFlagEmojiFromCountryCode(countryCode?: string | null) {
  const normalized = normalizeCountryCode(countryCode);
  if (!/^[A-Z]{2}$/.test(normalized)) return "🌐";
  return String.fromCodePoint(
    ...normalized.split("").map((char) => 127397 + char.charCodeAt(0)),
  );
}

function buildPhoneCountryOptions(countryOptions: CountryOption[]) {
  return countryOptions
    .filter((option) => option.value)
    .map((option) => {
      const meta = getPhoneMetaForCountry(option.value);
      return {
        value: option.value,
        label: `${option.label} (${meta.dialCode})`,
        dialCode: meta.dialCode,
        flagEmoji: meta.flagEmoji || getFlagEmojiFromCountryCode(option.value),
      };
    });
}

function getProvinceOptionsForCountry(
  countryValue?: string | null,
  shippingProvincesByCountry?: Record<string, CountryOption[]>,
) {
  const normalized = normalizeCountryCode(countryValue);
  const dynamicProvinceOptions = shippingProvincesByCountry?.[normalized] || [];

  if (dynamicProvinceOptions.length > 0) {
    const hasPlaceholder = dynamicProvinceOptions.some(
      (option) => option.value === "",
    );
    return hasPlaceholder
      ? dynamicProvinceOptions
      : [{ value: "", label: "State / Province" }, ...dynamicProvinceOptions];
  }

  return [{ value: "", label: "State / Province" }];
}

function getFieldPlaceholder(field: FormField) {
  const label = field.label;
  if (/state/i.test(field.key)) return "Select a state";
  if (/addr1/i.test(field.key)) return "";
  return `Add ${label}`;
}

function getFieldGridSpan(field: FormField) {
  if (field.width === "full") return "1 / -1";
  if (/Country|Dept|Addr1|Addr2|Phone/.test(field.key)) return "1 / -1";
  return undefined;
}

function sanitizePhoneInput(value: string) {
  return String(value || "").replace(/\D/g, "");
}

function isCountrySelectField(field: FormField) {
  return field.type === "select" && /country/i.test(field.key);
}

function isStateSelectField(field: FormField) {
  return field.type === "select" && /(state|province)/i.test(field.key);
}

function getZipKeysForSection(
  section: string,
  useSameAddress: boolean,
) {
  const zipKeys = new Set<string>();

  if (section === "shipping") {
    zipKeys.add("shipZip");
    zipKeys.add("shZip");
    if (useSameAddress) {
      zipKeys.add("billZip");
      zipKeys.add("biZip");
    }
  }

  if (section === "billing") {
    zipKeys.add("billZip");
    zipKeys.add("biZip");
  }

  return Array.from(zipKeys);
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
  onPhoneCountryChange,
  disabled = false,
}: {
  field: FormField;
  value: string;
  onChange: (val: string) => void;
  onPhoneCountryChange?: (countryCode: string) => void;
  disabled?: boolean;
}) {
  const hasValue = value !== undefined && value !== null && value !== "";
  const showFieldLabel = field.type !== "checkbox";
  const addStyle: CSSProperties = hasValue
    ? {}
    : { borderStyle: "dashed", opacity: 0.75 };
  const placeholder = getFieldPlaceholder(field);
  const isLocked = disabled || field.readOnly || field.type === "email";
  const disabledStyle: CSSProperties = isLocked
    ? {
        background: "#f9fafb",
        color: "#6b7280",
        cursor: "not-allowed",
      }
    : {};

  const resolvedType =
    field.type === "readonly" && !isLocked ? "text" : field.type;

  switch (resolvedType) {
    case "readonly":
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <input
            value={value || ""}
            readOnly
            placeholder={field.label}
            style={{
              ...inputStyle,
              background: "#f3f4f6",
              color: "#9ca3af",
              cursor: "not-allowed",
              border: "1px solid #e5e7eb",
            }}
          />
          {field.readOnlyHint ? (
            <div
              style={{
                fontSize: 11,
                color: "#9ca3af",
                marginTop: 3,
                paddingLeft: 2,
              }}
            >
              {field.readOnlyHint}
            </div>
          ) : null}
        </div>
      );

    case "phone":
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {field.countryCode ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9ccd0",
                  background: "white",
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#374151",
                  minWidth: "60px",
                  textAlign: "center",
                }}
              >
                {field.countryCode}
              </div>
            ) : (
              <select
                value={field.phoneCountryValue || ""}
                onChange={(e) => {
                  const selected = field.phoneCountryOptions?.find(
                    (opt) => opt.value === e.target.value,
                  );
                  if (selected && onPhoneCountryChange) {
                    onPhoneCountryChange(selected.value);
                  }
                }}
                style={{
                  ...inputStyle,
                  flex: "0 0 120px",
                  ...addStyle,
                  ...disabledStyle,
                }}
                disabled={disabled}
              >
                {field.phoneCountryOptions?.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
            <input
              placeholder={placeholder}
              value={value || ""}
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              onChange={(e) => onChange(sanitizePhoneInput(e.target.value))}
              disabled={isLocked || disabled}
              style={{
                ...inputStyle,
                ...addStyle,
                ...disabledStyle,
                ...(isLocked ? {} : { boxShadow: "0 0 0 2px #2563eb inset" }),
                flex: 1,
              }}
            />
          </div>
        </div>
      );

    case "select":
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <select
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={isLocked}
            style={{ ...inputStyle, ...addStyle, ...disabledStyle }}
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
            disabled={isLocked}
          />
          {field.label}
        </label>
      );

    case "textarea":
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <textarea
            placeholder={placeholder}
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={isLocked}
            style={{
              ...inputStyle,
              ...addStyle,
              ...disabledStyle,
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
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <input
            placeholder={placeholder}
            value={value || ""}
            type={field.type === "email" ? "email" : "text"}
            onChange={(e) => onChange(e.target.value)}
            disabled={isLocked}
            style={{ ...inputStyle, ...addStyle, ...disabledStyle }}
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
  isSaving = false,
  sections = [],
  fields = [],
  shippingProvincesByCountry = {},
  mode = "modal",
  title = "Edit details",
  description,
  primaryActionLabel = "Save changes",
  savingActionLabel = "Saving...",
  hideSecondaryAction = false,
  isEditingEnabled = true,
  onEnableEditing,
  editActionLabel = "Edit",
  hideHeader = false,
  displayBlocks = [],
}: {
  editForm: Record<string, any>;
  setEditForm: Dispatch<SetStateAction<Record<string, any>>>;
  onClose: () => void;
  onSave: () => void;
  isSaving?: boolean;
  sections?: FormSection[];
  fields?: FormField[];
  shippingProvincesByCountry?: Record<string, CountryOption[]>;
  mode?: "modal" | "inline";
  title?: string;
  description?: string;
  primaryActionLabel?: string;
  savingActionLabel?: string;
  hideSecondaryAction?: boolean;
  isEditingEnabled?: boolean;
  onEnableEditing?: () => void;
  editActionLabel?: string;
  hideHeader?: boolean;
  displayBlocks?: DisplayBlock[];
}) {
  const sortedSections = [...sections].sort((a, b) => a.order - b.order);
  const sortedDisplayBlocks = [...displayBlocks].sort((a, b) => a.order - b.order);

  const content = (
    <>
      {!hideHeader ? (
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
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
            {description ? (
              <p style={{ margin: "4px 0 0", color: "#5c5f62", fontSize: 13 }}>
                {description}
              </p>
            ) : null}
          </div>
          {onEnableEditing && !isEditingEnabled ? (
            <button
              onClick={onEnableEditing}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                background: "white",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                color: "#374151",
              }}
            >
              {editActionLabel}
            </button>
          ) : mode === "modal" ? (
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
          ) : null}
        </div>
      ) : null}

      <div style={{ padding: "16px 20px", display: "grid", gap: 14 }}>
        {sortedDisplayBlocks.map((block) => {
          if (block.type === "heading") {
            const HeadingTag = block.headingTag || "h2";
            return (
              <HeadingTag
                key={block.key}
                style={{
                  margin: 0,
                  fontSize:
                    block.headingTag === "h1"
                      ? 30
                      : block.headingTag === "h2"
                        ? 24
                        : block.headingTag === "h3"
                          ? 20
                          : 18,
                  fontWeight: 700,
                  color: "#111827",
                  textAlign: block.headingAlignment || "left",
                }}
              >
                {block.content || block.label}
              </HeadingTag>
            );
          }

          return (
            <div
              key={block.key}
              style={{
                fontSize: 14,
                lineHeight: 1.6,
                color: "#4b5563",
              }}
              dangerouslySetInnerHTML={{
                __html: block.content || "",
              }}
            />
          );
        })}

        {sortedSections.map((section) => {
          const sectionFields = sortSectionFields(
            section.key,
            fields.filter((f) => f.section === section.key),
          );

          if (sectionFields.length === 0) return null;

          const isBilling = section.key === "billing";
          const sameAsShippingField = isBilling
            ? sectionFields.find((field) => field.key === "billSameAsShip")
            : null;
          const visibleSectionFields =
            sameAsShippingField == null
              ? sectionFields
              : sectionFields.filter(
                  (field) => field.key !== sameAsShippingField.key,
                );
          const sectionCountryOptions =
            visibleSectionFields.find(
              (field) => field.type === "select" && /country/i.test(field.key),
            )?.options || [];
          const phoneCountryOptions = buildPhoneCountryOptions(
            sectionCountryOptions,
          );

          return (
            <div key={section.key} style={sectionStyle}>
              {isBilling && sameAsShippingField ? (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <h4 style={{ ...sectionHeadingStyle, margin: 0 }}>
                    {section.label}
                  </h4>
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
                        setEditForm((f) => ({
                          ...f,
                          useSameAddress: e.target.checked,
                        }))
                      }
                    />
                    {sameAsShippingField.label}
                  </label>
                </div>
              ) : (
                <h4 style={sectionHeadingStyle}>{section.label}</h4>
              )}

              {isBilling &&
              sameAsShippingField &&
              editForm.useSameAddress ? null : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 10,
                  }}
                >
                  {visibleSectionFields.map((field) => {
                    const countryValue = getResolvedSectionCountryValue(
                      field,
                      editForm,
                    );
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
                                  phoneCountryOptions:
                                    field.type === "phone" ? phoneCountryOptions : undefined,
                                  phoneCountryValue:
                                    field.type === "phone"
                                      ? normalizeCountryCode(String(countryValue ?? "")) || "IN"
                                      : undefined,
                                }
                              : {}),
                            ...(stateOptions ? { options: stateOptions } : {}),
                          }}
                          value={String(editForm[field.key] ?? "")}
                          disabled={!isEditingEnabled}
                          onPhoneCountryChange={(nextCountryCode) => {
                            if (field.section === "billing") {
                              setEditForm((f) => ({
                                ...f,
                                billCountry: nextCountryCode,
                                biCountry: nextCountryCode,
                              }));
                              return;
                            }

                            setEditForm((f) => ({
                              ...f,
                              shipCountry: nextCountryCode,
                              shCountry: nextCountryCode,
                            }));
                          }}
                          onChange={(val) =>
                            setEditForm((f) => {
                              const updated = { ...f, [field.key]: val };

                              if (
                                isCountrySelectField(field) ||
                                isStateSelectField(field)
                              ) {
                                for (const zipKey of getZipKeysForSection(
                                  field.section,
                                  Boolean(f.useSameAddress),
                                )) {
                                  updated[zipKey] = "";
                                }
                              }

                              return updated;
                            })
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
        {!hideSecondaryAction ? (
          <button
            onClick={onClose}
            disabled={isSaving}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #c9ccd0",
              background: "white",
              cursor: isSaving ? "not-allowed" : "pointer",
              opacity: isSaving ? 0.6 : 1,
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
        ) : null}
        <button
          onClick={onSave}
          disabled={isSaving}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: "#1a1a1a",
            color: "white",
            cursor: isSaving ? "not-allowed" : "pointer",
            opacity: isSaving ? 0.8 : 1,
            fontSize: 14,
            fontWeight: 600,
            minWidth: 120,
          }}
        >
          {isSaving ? savingActionLabel : primaryActionLabel}
        </button>
      </div>
    </>
  );

  if (mode === "inline") {
    return (
      <div
        style={{
          background: "#f8f8f8",
          borderRadius: 12,
          border: "1px solid #e3e3e3",
          overflow: "hidden",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {content}
      </div>
    );
  }

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
          {content}
        </div>
      </div>
    </div>
  );
}

export type { CountryOption, DisplayBlock, FormField, FormSection };
