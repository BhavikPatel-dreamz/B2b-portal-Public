export type FieldType =
  | "text"
  | "email"
  | "phone"
  | "number"
  | "textarea"
  | "country"
  | "state"
  | "select"
  | "radio"
  | "checkbox"
  | "multi-check"
  | "date"
  | "file"
  | "heading"
  | "paragraph"
  | "link"
  | "divider";

export type FieldCategory = "general" | "shipping" | "custom" | "display";

export type FieldWidth = "full" | "half";
type HeadingTag = "h1" | "h2" | "h3" | "h4";
type HeadingAlignment = "left" | "center" | "right";
type MetafieldTarget =
  | "customer"
  | "company_location"
  | "company"
  | "customer_locations"
  | "orders"
  | "products"
  | "product_variants";

export interface FieldDef {
  id: string;
  paletteKey: string;
  category: FieldCategory;
  type: FieldType;
  label: string;
  description?: string;
  defaultValue?: string;
  validationMessage?: string;
  hideTypedCharacters?: boolean;
  headingTag?: HeadingTag;
  headingAlignment?: HeadingAlignment;
  headingWidth?: number;
  paragraphFontSize?: number;
  linkUrl?: string;
  linkOpenInNewTab?: boolean;
  linkAlignment?: HeadingAlignment;
  sectionLabel?: string;
  sectionHeadingLabel?: string;
  sectionHeadingTag?: HeadingTag;
  sectionHeadingAlignment?: HeadingAlignment;
  sectionHeadingWidth?: number;
  sectionHeadingHidden?: boolean;
  key: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  section?: string;
  stepIndex: number;
  order: number;
  width?: FieldWidth;
  content?: string;
  isDisplay?: boolean;
  metafieldTarget?: MetafieldTarget;
  metafieldDefinition?: string;
  phoneDefaultCountry?: string;
}

export interface FormStep {
  id: string;
  label: string;
}

export interface FormConfig {
  steps: FormStep[];
  fields: FieldDef[];
}

export interface StoredField {
  paletteKey?: string;
  key: string;
  label: string;
  description?: string;
  defaultValue?: string;
  validationMessage?: string;
  hideTypedCharacters?: boolean;
  headingTag?: HeadingTag;
  headingAlignment?: HeadingAlignment;
  headingWidth?: number;
  paragraphFontSize?: number;
  linkUrl?: string;
  linkOpenInNewTab?: boolean;
  linkAlignment?: HeadingAlignment;
  sectionLabel?: string;
  sectionHeadingLabel?: string;
  sectionHeadingTag?: HeadingTag;
  sectionHeadingAlignment?: HeadingAlignment;
  sectionHeadingWidth?: number;
  sectionHeadingHidden?: boolean;
  type: FieldType;
  order: number;
  required?: boolean;
  width?: FieldWidth;
  section?: string;
  options?: string[];
  placeholder?: string;
  content?: string;
  metafieldTarget?: MetafieldTarget;
  metafieldDefinition?: string;
  phoneDefaultCountry?: string;
}

export interface StoredStepGroup {
  step: FormStep;
  fields: StoredField[];
}

export type StoredConfig = StoredStepGroup[];

export const SECTION_LABELS: Record<string, string> = {
  company: "Company information",
};

export const PALETTE: Record<
  FieldCategory,
  Array<{
    paletteKey: string;
    label: string;
    type: FieldType;
    key: string;
    section?: string;
    required?: boolean;
    isDisplay?: boolean;
    width?: FieldWidth;
  }>
> = {
  general: [
    {
      paletteKey: "companyName",
      label: "Business / Company Name",
      type: "text",
      key: "companyName",
      section: "company",
      required: true,
      width: "full",
    },
    {
      paletteKey: "contactName",
      label: "Contact Person Name",
      type: "text",
      key: "contactName",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "contactPhone",
      label: "Contact Person Number",
      type: "phone",
      key: "phone",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "taxId",
      label: "Tax Registration Number",
      type: "text",
      key: "taxId",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "businessType",
      label: "Type of Business (Retailer, Distributor, Reseller, etc.)",
      type: "text",
      key: "businessType",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "website",
      label: "Company Website",
      type: "text",
      key: "website",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "additionalNotes",
      label: "Tell us about your business",
      type: "textarea",
      key: "additionalInfo",
      section: "company",
      width: "full",
    },
  ],
  shipping: [],
  custom: [
    {
      paletteKey: "c_text",
      label: "Single-line text",
      type: "text",
      key: "custom_text",
      width: "full",
    },
    {
      paletteKey: "c_textarea",
      label: "Multi-line text",
      type: "textarea",
      key: "custom_textarea",
      width: "full",
    },
    {
      paletteKey: "c_number",
      label: "Number",
      type: "number",
      key: "custom_number",
      width: "full",
    },
    {
      paletteKey: "c_dropdown",
      label: "Dropdown",
      type: "select",
      key: "custom_dropdown",
      width: "full",
    },
    {
      paletteKey: "c_radio",
      label: "Radio choices",
      type: "radio",
      key: "custom_radio",
      width: "full",
    },
    {
      paletteKey: "c_checkbox",
      label: "Checkbox",
      type: "checkbox",
      key: "custom_checkbox",
      width: "full",
    },
    {
      paletteKey: "c_multicheck",
      label: "Multi-choice list",
      type: "multi-check",
      key: "custom_multicheck",
      width: "full",
    },
    {
      paletteKey: "c_date",
      label: "Date",
      type: "date",
      key: "custom_date",
      width: "full",
    },
    {
      paletteKey: "c_file",
      label: "File upload",
      type: "file",
      key: "custom_file",
      width: "full",
    },
    {
      paletteKey: "c_email",
      label: "Email address",
      type: "email",
      key: "custom_email",
      width: "full",
    },
    {
      paletteKey: "c_phone",
      label: "Phone number",
      type: "phone",
      key: "custom_phone",
      width: "full",
    },
  ],
  display: [
    {
      paletteKey: "d_heading",
      label: "Heading",
      type: "heading",
      key: "display_heading",
      isDisplay: true,
      width: "full",
    },
    {
      paletteKey: "d_paragraph",
      label: "Paragraph",
      type: "paragraph",
      key: "display_paragraph",
      isDisplay: true,
      width: "full",
    },
    {
      paletteKey: "d_link",
      label: "Link",
      type: "link",
      key: "display_link",
      isDisplay: true,
      width: "full",
    },
    {
      paletteKey: "d_divider",
      label: "Divider",
      type: "divider",
      key: "display_divider",
      isDisplay: true,
      width: "full",
    },
  ],
};

export const DEFAULT_CONFIG: FormConfig = {
  steps: [{ id: "step-0", label: "Step 1" }],
  fields: [
    {
      id: "f01",
      paletteKey: "d_heading",
      category: "display",
      type: "heading",
      label: "Heading",
      key: "display_heading",
      order: 1,
      width: "full",
      content: "Apply for a Wholesale Account",
      headingTag: "h1",
      headingWidth: 100,
      metafieldTarget: "company",
      headingAlignment: "left",
      validationMessage: "Must not be blank",
      stepIndex: 0,
    },
    {
      id: "f02",
      paletteKey: "d_paragraph",
      category: "display",
      type: "paragraph",
      label: "Paragraph",
      key: "display_paragraph",
      order: 2,
      width: "full",
      content:
        "<p>Fill out the form below to apply for a B2B/Wholesale account. Our team will review your application and get back to you within 2–3 business days.</p>",
      metafieldTarget: "company",
      paragraphFontSize: 14,
      validationMessage: "Must not be blank",
      stepIndex: 0,
    },
    // --- COMPANY INFORMATION ---
    {
      id: "f03",
      paletteKey: "companyName",
      category: "general",
      type: "text",
      label: "Business / Company Name",
      key: "companyName",
      order: 3,
      width: "full",
      section: "company",
      required: true,
      sectionLabel: "Company information",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Company information heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f06",
      paletteKey: "contactName",
      category: "general",
      type: "text",
      label: "Contact Person Name",
      key: "contactName",
      order: 4,
      width: "full",
      section: "company",
      sectionLabel: "Company information",
      stepIndex: 0,
    },
    {
      id: "f07",
      paletteKey: "contactPhone",
      category: "general",
      type: "phone",
      label: "Contact Person Number",
      key: "phone",
      order: 5,
      width: "full",
      section: "company",
      sectionLabel: "Company information",
      phoneDefaultCountry: "us",
      stepIndex: 0,
    },
    {
      id: "f_businessType",
      paletteKey: "businessType",
      category: "general",
      type: "text",
      label: "Type of Business (Retailer, Distributor, Reseller, etc.)",
      key: "businessType",
      order: 6,
      width: "full",
      section: "company",
      required: false,
      sectionLabel: "Company information",
      stepIndex: 0,
    },
    {
      id: "f04",
      paletteKey: "taxId",
      category: "general",
      type: "text",
      label: "Tax Registration Number",
      key: "taxId",
      order: 7,
      width: "full",
      section: "company",
      sectionLabel: "Company information",
      stepIndex: 0,
    },
    {
      id: "f_website",
      paletteKey: "website",
      category: "general",
      type: "text",
      label: "Company Website",
      key: "website",
      order: 8,
      width: "full",
      section: "company",
      required: false,
      sectionLabel: "Company information",
      stepIndex: 0,
    },
    {
      id: "f_additionalNotes",
      paletteKey: "additionalNotes",
      category: "general",
      type: "textarea",
      label: "Tell us about your business",
      key: "additionalInfo",
      order: 10,
      width: "full",
      section: "company",
      required: false,
      sectionLabel: "Company information",
      stepIndex: 0,
    },
  ],
};

export function serializeConfig(config: FormConfig): StoredConfig {
  return config.steps.map((step, stepIdx): StoredStepGroup => {
    const stepFields = config.fields
      .filter((field) => field.stepIndex === stepIdx)
      .sort((a, b) => a.order - b.order);
    const { map: sectionMap } = groupBySection(stepFields);

    const storedFields = stepFields.map((field): StoredField => {
      const sectionFields = field.section
        ? sectionMap[field.section] || []
        : [];
      const sectionLabel =
        field.section && sectionFields.length > 0
          ? getSectionDisplayLabel(sectionFields, field.section)
          : field.sectionLabel;
      const sectionHeadingSettings =
        field.section && sectionFields.length > 0
          ? getSectionHeadingSettings(sectionFields, field.section)
          : null;

      return {
        paletteKey: field.paletteKey,
        key: field.key,
        label: field.label,
        ...(field.description ? { description: field.description } : {}),
        ...(field.defaultValue ? { defaultValue: field.defaultValue } : {}),
        ...(field.validationMessage
          ? { validationMessage: field.validationMessage }
          : {}),
        ...(field.hideTypedCharacters
          ? { hideTypedCharacters: field.hideTypedCharacters }
          : {}),
        ...(field.headingTag ? { headingTag: field.headingTag } : {}),
        ...(field.headingAlignment
          ? { headingAlignment: field.headingAlignment }
          : {}),
        ...(typeof field.headingWidth === "number"
          ? { headingWidth: field.headingWidth }
          : {}),
        ...(typeof field.paragraphFontSize === "number"
          ? { paragraphFontSize: field.paragraphFontSize }
          : {}),
        ...(field.linkUrl ? { linkUrl: field.linkUrl } : {}),
        ...(typeof field.linkOpenInNewTab === "boolean"
          ? { linkOpenInNewTab: field.linkOpenInNewTab }
          : {}),
        ...(field.linkAlignment ? { linkAlignment: field.linkAlignment } : {}),
        ...(sectionLabel ? { sectionLabel } : {}),
        ...(sectionHeadingSettings?.label
          ? { sectionHeadingLabel: sectionHeadingSettings.label }
          : {}),
        ...(sectionHeadingSettings?.headingTag
          ? { sectionHeadingTag: sectionHeadingSettings.headingTag }
          : {}),
        ...(sectionHeadingSettings?.alignment
          ? { sectionHeadingAlignment: sectionHeadingSettings.alignment }
          : {}),
        ...(typeof sectionHeadingSettings?.width === "number"
          ? { sectionHeadingWidth: sectionHeadingSettings.width }
          : {}),
        ...(typeof sectionHeadingSettings?.hidden === "boolean"
          ? { sectionHeadingHidden: sectionHeadingSettings.hidden }
          : {}),
        type: field.type,
        order: field.order,
        ...(field.required ? { required: field.required } : {}),
        ...(field.width ? { width: field.width } : {}),
        ...(field.section ? { section: field.section } : {}),
        ...(field.options ? { options: field.options } : {}),
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        ...(field.content ? { content: field.content } : {}),
        ...(field.metafieldTarget
          ? { metafieldTarget: field.metafieldTarget }
          : {}),
        ...(field.metafieldDefinition
          ? { metafieldDefinition: field.metafieldDefinition }
          : {}),
        ...(field.phoneDefaultCountry
          ? { phoneDefaultCountry: field.phoneDefaultCountry }
          : {}),
      };
    });

    return { step, fields: storedFields };
  });
}

export function deserializeConfig(stored: StoredConfig): FormConfig {
  const displayTypes: FieldType[] = ["heading", "paragraph", "link", "divider"];
  const isBuiltInShippingPhoneField = (field: StoredField) =>
    field.paletteKey === "shipPhone" || field.key === "shipPhone";

  const inferCategory = (field: StoredField): FieldCategory => {
    if (displayTypes.includes(field.type)) return "display";
    if (field.section === "shipping") return "shipping";
    if (field.section === "company" || field.section === "contact")
      return "general";
    return "custom";
  };

  const steps: FormStep[] = stored.map((group) => group.step);
  const fields: FieldDef[] = stored.flatMap((group, stepIdx) =>
    group.fields
      .filter((field) => field.section !== "billing")
      .sort((a, b) => a.order - b.order)
      .map(
        (field): FieldDef => ({
          id: `_${field.key}_${stepIdx}_${field.order}`,
          paletteKey: resolveStoredPaletteKey(field),
          category: inferCategory(field),
          isDisplay: displayTypes.includes(field.type),
          key: field.key,
          label: field.label,
          description: field.description,
          defaultValue: field.defaultValue,
          validationMessage: field.validationMessage,
          hideTypedCharacters: field.hideTypedCharacters,
          headingTag: field.headingTag,
          headingAlignment: field.headingAlignment,
          headingWidth: field.headingWidth,
          paragraphFontSize: field.paragraphFontSize,
          linkUrl: field.linkUrl,
          linkOpenInNewTab: field.linkOpenInNewTab,
          linkAlignment: field.linkAlignment,
          sectionLabel: field.sectionLabel,
          sectionHeadingLabel: field.sectionHeadingLabel,
          sectionHeadingTag: field.sectionHeadingTag,
          sectionHeadingAlignment: field.sectionHeadingAlignment,
          sectionHeadingWidth: field.sectionHeadingWidth,
          sectionHeadingHidden: field.sectionHeadingHidden,
          type: field.type,
          order: field.order,
          stepIndex: stepIdx,
          width: field.width ?? "full",
          required: isBuiltInShippingPhoneField(field) ? false : field.required,
          section: field.section,
          options: field.options,
          placeholder: field.placeholder,
          content: field.content,
          metafieldTarget: field.metafieldTarget,
          metafieldDefinition: field.metafieldDefinition,
          phoneDefaultCountry: field.phoneDefaultCountry,
        }),
      ),
  );

  return { steps, fields };
}

function resolveStoredPaletteKey(field: StoredField) {
  if (field.paletteKey) return field.paletteKey;

  const paletteMatch = Object.values(PALETTE)
    .flat()
    .find((item) => item.key === field.key);

  if (paletteMatch) return paletteMatch.paletteKey;

  const keyWithoutGeneratedSuffix = field.key.replace(/_[a-z0-9]+$/i, "");
  const inferredMatch = Object.values(PALETTE)
    .flat()
    .find((item) => item.key === keyWithoutGeneratedSuffix);

  return inferredMatch?.paletteKey ?? field.key;
}

function groupBySection(fields: FieldDef[]) {
  const map: Record<string, FieldDef[]> = {};
  const seen = new Set<string>();
  const order: string[] = [];
  const none: FieldDef[] = [];

  for (const field of fields) {
    if (field.section) {
      if (!seen.has(field.section)) {
        seen.add(field.section);
        order.push(field.section);
      }
      (map[field.section] = map[field.section] || []).push(field);
    } else {
      none.push(field);
    }
  }

  return { map, order, none };
}

function getSectionDisplayLabel(fields: FieldDef[], section: string) {
  const customLabel = fields
    .find((field) => field.sectionLabel?.trim())
    ?.sectionLabel?.trim();
  return customLabel || SECTION_LABELS[section] || section;
}

function getSectionHeadingSettings(fields: FieldDef[], section: string) {
  const baseLabel = getSectionDisplayLabel(fields, section);
  const firstField = fields[0];

  return {
    content: baseLabel,
    label: firstField?.sectionHeadingLabel?.trim() || `${baseLabel} heading`,
    headingTag: firstField?.sectionHeadingTag || "h1",
    alignment: firstField?.sectionHeadingAlignment || "left",
    width: firstField?.sectionHeadingWidth ?? 100,
    hidden: firstField?.sectionHeadingHidden ?? false,
  };
}
