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

export type FieldCategory =
  | "general"
  | "shipping"
  | "billing"
  | "custom"
  | "display";

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
  contact: "Contact information",
  shipping: "Shipping address",
  billing: "Billing address",
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
    { paletteKey: "companyName", label: "Company name", type: "text", key: "companyName", section: "company", required: true, width: "full" },
    { paletteKey: "taxId", label: "Tax ID", type: "text", key: "taxId", section: "company", width: "full" },
    { paletteKey: "firstName", label: "Contact first name", type: "text", key: "firstName", section: "contact", required: true, width: "half" },
    { paletteKey: "lastName", label: "Contact last name", type: "text", key: "lastName", section: "contact", width: "half" },
    { paletteKey: "contactTitle", label: "Contact title", type: "text", key: "contactTitle", section: "contact", width: "full" },
    { paletteKey: "locationName", label: "Main location name", type: "text", key: "locationName", section: "company", width: "full" },
    { paletteKey: "email", label: "Email", type: "email", key: "email", section: "contact", required: true, width: "full" },
  ],
  shipping: [
    { paletteKey: "shipDept", label: "Department/attention", type: "text", key: "shipDept", section: "shipping", width: "full" },
    { paletteKey: "shipFirstName", label: "Shipping first name", type: "text", key: "shipFirstName", section: "shipping", width: "half" },
    { paletteKey: "shipLastName", label: "Shipping last name", type: "text", key: "shipLastName", section: "shipping", width: "half" },
    { paletteKey: "shipPhone", label: "Shipping phone", type: "phone", key: "shipPhone", section: "shipping", width: "full" },
    { paletteKey: "shipAddr1", label: "Shipping address line 1", type: "text", key: "shipAddr1", section: "shipping", width: "full" },
    { paletteKey: "shipAddr2", label: "Shipping address line 2", type: "text", key: "shipAddr2", section: "shipping", width: "full" },
    { paletteKey: "shipCity", label: "Shipping city", type: "text", key: "shipCity", section: "shipping", width: "full" },
    { paletteKey: "shipCountry", label: "Shipping country", type: "country", key: "shipCountry", section: "shipping", width: "full" },
    { paletteKey: "shipState", label: "Shipping state/province", type: "state", key: "shipState", section: "shipping", width: "full" },
    { paletteKey: "shipZip", label: "Shipping ZIP/Postal code", type: "text", key: "shipZip", section: "shipping", width: "full" },
  ],
  billing: [
    { paletteKey: "billSameAsShip", label: "Same as shipping address", type: "checkbox", key: "billSameAsShip", section: "billing", width: "full" },
    { paletteKey: "billDept", label: "Department/attention", type: "text", key: "billDept", section: "billing", width: "full" },
    { paletteKey: "billFirstName", label: "Billing first name", type: "text", key: "billFirstName", section: "billing", width: "half" },
    { paletteKey: "billLastName", label: "Billing last name", type: "text", key: "billLastName", section: "billing", width: "half" },
    { paletteKey: "billPhone", label: "Billing phone", type: "phone", key: "billPhone", section: "billing", width: "full" },
    { paletteKey: "billAddr1", label: "Billing address line 1", type: "text", key: "billAddr1", section: "billing", width: "full" },
    { paletteKey: "billAddr2", label: "Billing address line 2", type: "text", key: "billAddr2", section: "billing", width: "full" },
    { paletteKey: "billCity", label: "Billing city", type: "text", key: "billCity", section: "billing", width: "full" },
    { paletteKey: "billCountry", label: "Billing country", type: "country", key: "billCountry", section: "billing", width: "full" },
    { paletteKey: "billState", label: "Billing state/province", type: "state", key: "billState", section: "billing", width: "full" },
    { paletteKey: "billZip", label: "Billing ZIP/Postal code", type: "text", key: "billZip", section: "billing", width: "full" },
  ],
  custom: [
    { paletteKey: "c_text", label: "Single-line text", type: "text", key: "custom_text", width: "full" },
    { paletteKey: "c_textarea", label: "Multi-line text", type: "textarea", key: "custom_textarea", width: "full" },
    { paletteKey: "c_number", label: "Number", type: "number", key: "custom_number", width: "full" },
    { paletteKey: "c_dropdown", label: "Dropdown", type: "select", key: "custom_dropdown", width: "full" },
    { paletteKey: "c_radio", label: "Radio choices", type: "radio", key: "custom_radio", width: "full" },
    { paletteKey: "c_checkbox", label: "Checkbox", type: "checkbox", key: "custom_checkbox", width: "full" },
    { paletteKey: "c_multicheck", label: "Multi-choice list", type: "multi-check", key: "custom_multicheck", width: "full" },
    { paletteKey: "c_date", label: "Date", type: "date", key: "custom_date", width: "full" },
    { paletteKey: "c_file", label: "File upload", type: "file", key: "custom_file", width: "full" },
    { paletteKey: "c_email", label: "Email address", type: "email", key: "custom_email", width: "full" },
    { paletteKey: "c_phone", label: "Phone number", type: "phone", key: "custom_phone", width: "full" },
  ],
  display: [
    { paletteKey: "d_heading", label: "Heading", type: "heading", key: "display_heading", isDisplay: true, width: "full" },
    { paletteKey: "d_paragraph", label: "Paragraph", type: "paragraph", key: "display_paragraph", isDisplay: true, width: "full" },
    { paletteKey: "d_link", label: "Link", type: "link", key: "display_link", isDisplay: true, width: "full" },
    { paletteKey: "d_divider", label: "Divider", type: "divider", key: "display_divider", isDisplay: true, width: "full" },
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
      key: "display_heading_ct8eu7b",
      order: 0,
      width: "full",
      content: "B2B Onboarding",
      headingTag: "h1",
      headingWidth: 100,
      metafieldTarget: "company",
      headingAlignment: "left",
      validationMessage: "Must not be blank",
      phoneDefaultCountry: "us",
      stepIndex: 0,
    },
    {
      id: "f02",
      paletteKey: "d_paragraph",
      category: "display",
      type: "paragraph",
      label: "Paragraph",
      key: "display_paragraph_7y9ibxj",
      order: 1,
      width: "full",
      content:
        "<p>Please fill out the details below to submit your B2B application. Our team will review and get back to you soon</p>",
      metafieldTarget: "company",
      paragraphFontSize: 14,
      validationMessage: "Must not be blank",
      phoneDefaultCountry: "us",
      stepIndex: 0,
    },
    {
      id: "f03",
      paletteKey: "companyName",
      category: "general",
      type: "text",
      label: "Company name",
      key: "companyName",
      order: 2,
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
      id: "f04",
      paletteKey: "taxId",
      category: "general",
      type: "text",
      label: "Tax registration ID",
      key: "taxId",
      order: 3,
      width: "full",
      section: "company",
      sectionLabel: "Company information",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Company information heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f05",
      paletteKey: "contactTitle",
      category: "general",
      type: "text",
      label: "Contact Person-1",
      key: "contactTitle_wf18fcm",
      order: 4,
      width: "full",
      section: "contact",
      required: true,
      sectionLabel: "Contact information-1",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Contact information heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f06",
      paletteKey: "firstName",
      category: "general",
      type: "text",
      label: "First name",
      key: "firstName",
      order: 5,
      width: "half",
      section: "contact",
      required: true,
      sectionLabel: "Contact information-1",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Contact information heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f07",
      paletteKey: "lastName",
      category: "general",
      type: "text",
      label: "Last name",
      key: "lastName",
      order: 6,
      width: "half",
      section: "contact",
      required: true,
      sectionLabel: "Contact information-1",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Contact information heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f08",
      paletteKey: "email",
      category: "general",
      type: "email",
      label: "Email",
      key: "email",
      order: 7,
      width: "full",
      section: "contact",
      required: true,
      sectionLabel: "Contact information-1",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Contact information heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f09",
      paletteKey: "locationName",
      category: "general",
      type: "text",
      label: "Main location name",
      key: "locationName",
      order: 8,
      width: "full",
      section: "company",
      sectionLabel: "Company information",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Company information heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f10",
      paletteKey: "shipDept",
      category: "shipping",
      type: "text",
      label: "Department / attention",
      key: "shipDept",
      order: 9,
      width: "full",
      section: "shipping",
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f11",
      paletteKey: "shipFirstName",
      category: "shipping",
      type: "text",
      label: "First name",
      key: "shipFirstName",
      order: 10,
      width: "half",
      section: "shipping",
      required: true,
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f12",
      paletteKey: "shipLastName",
      category: "shipping",
      type: "text",
      label: "Last name",
      key: "shipLastName",
      order: 11,
      width: "half",
      section: "shipping",
      required: true,
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f13",
      paletteKey: "shipPhone",
      category: "shipping",
      type: "phone",
      label: "Phone",
      key: "shipPhone",
      order: 12,
      width: "full",
      section: "shipping",
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f14",
      paletteKey: "shipAddr1",
      category: "shipping",
      type: "text",
      label: "Address line 1",
      key: "shipAddr1",
      order: 13,
      width: "full",
      section: "shipping",
      required: true,
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f15",
      paletteKey: "shipAddr2",
      category: "shipping",
      type: "text",
      label: "Apartment, suite, etc",
      key: "shipAddr2",
      order: 14,
      width: "full",
      section: "shipping",
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f16",
      paletteKey: "shipCity",
      category: "shipping",
      type: "text",
      label: "City",
      key: "shipCity",
      order: 15,
      width: "full",
      section: "shipping",
      required: true,
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f17",
      paletteKey: "shipCountry",
      category: "shipping",
      type: "country",
      label: "Country",
      key: "shipCountry",
      order: 16,
      width: "full",
      section: "shipping",
      required: true,
      sectionLabel: "Shipping address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f18",
      paletteKey: "shipState",
      category: "shipping",
      type: "state",
      label: "State/Province",
      key: "shipState",
      order: 17,
      width: "full",
      section: "shipping",
      required: true,
      sectionLabel: "Shipping address",
      metafieldTarget: "company",
      sectionHeadingTag: "h1",
      validationMessage: "Must not be blank",
      phoneDefaultCountry: "us",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f19",
      paletteKey: "shipZip",
      category: "shipping",
      type: "text",
      label: "ZIP/Postal code",
      key: "shipZip",
      order: 18,
      width: "full",
      section: "shipping",
      required: true,
      sectionLabel: "Shipping address",
      metafieldTarget: "company",
      sectionHeadingTag: "h1",
      validationMessage: "Must not be blank",
      phoneDefaultCountry: "us",
      sectionHeadingLabel: "Shipping address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f20",
      paletteKey: "billSameAsShip",
      category: "billing",
      type: "checkbox",
      label: "Same as shipping address",
      key: "billSameAsShip",
      order: 19,
      width: "full",
      section: "billing",
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f21",
      paletteKey: "billDept",
      category: "billing",
      type: "text",
      label: "Department / attention",
      key: "billDept",
      order: 20,
      width: "full",
      section: "billing",
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f22",
      paletteKey: "billFirstName",
      category: "billing",
      type: "text",
      label: "First name",
      key: "billFirstName",
      order: 21,
      width: "half",
      section: "billing",
      required: true,
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f23",
      paletteKey: "billLastName",
      category: "billing",
      type: "text",
      label: "Last name",
      key: "billLastName",
      order: 22,
      width: "half",
      section: "billing",
      required: true,
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f24",
      paletteKey: "billAddr1",
      category: "billing",
      type: "text",
      label: "Address line 1",
      key: "billAddr1",
      order: 23,
      width: "full",
      section: "billing",
      required: true,
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f25",
      paletteKey: "billAddr2",
      category: "billing",
      type: "text",
      label: "Apartment, suite, etc",
      key: "billAddr2",
      order: 24,
      width: "full",
      section: "billing",
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f26",
      paletteKey: "billCity",
      category: "billing",
      type: "text",
      label: "City",
      key: "billCity",
      order: 25,
      width: "full",
      section: "billing",
      required: true,
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f27",
      paletteKey: "billState",
      category: "billing",
      type: "state",
      label: "State/Province",
      key: "billState",
      order: 26,
      width: "full",
      section: "billing",
      sectionLabel: "Billing address",
      metafieldTarget: "company",
      sectionHeadingTag: "h1",
      validationMessage: "Must not be blank",
      phoneDefaultCountry: "us",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f28",
      paletteKey: "billZip",
      category: "billing",
      type: "text",
      label: "ZIP/Postal code",
      key: "billZip",
      order: 27,
      width: "full",
      section: "billing",
      required: true,
      sectionLabel: "Billing address",
      metafieldTarget: "company",
      sectionHeadingTag: "h1",
      validationMessage: "Must not be blank",
      phoneDefaultCountry: "us",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
      stepIndex: 0,
    },
    {
      id: "f29",
      paletteKey: "billPhone",
      category: "billing",
      type: "phone",
      label: "Phone",
      key: "billPhone",
      order: 28,
      width: "full",
      section: "billing",
      required: true,
      sectionLabel: "Billing address",
      sectionHeadingTag: "h1",
      sectionHeadingLabel: "Billing address heading",
      sectionHeadingWidth: 100,
      sectionHeadingHidden: false,
      sectionHeadingAlignment: "left",
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
      const sectionFields = field.section ? sectionMap[field.section] || [] : [];
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
        ...(field.validationMessage ? { validationMessage: field.validationMessage } : {}),
        ...(field.hideTypedCharacters ? { hideTypedCharacters: field.hideTypedCharacters } : {}),
        ...(field.headingTag ? { headingTag: field.headingTag } : {}),
        ...(field.headingAlignment ? { headingAlignment: field.headingAlignment } : {}),
        ...(typeof field.headingWidth === "number" ? { headingWidth: field.headingWidth } : {}),
        ...(typeof field.paragraphFontSize === "number" ? { paragraphFontSize: field.paragraphFontSize } : {}),
        ...(field.linkUrl ? { linkUrl: field.linkUrl } : {}),
        ...(typeof field.linkOpenInNewTab === "boolean" ? { linkOpenInNewTab: field.linkOpenInNewTab } : {}),
        ...(field.linkAlignment ? { linkAlignment: field.linkAlignment } : {}),
        ...(sectionLabel ? { sectionLabel } : {}),
        ...(sectionHeadingSettings?.label ? { sectionHeadingLabel: sectionHeadingSettings.label } : {}),
        ...(sectionHeadingSettings?.headingTag ? { sectionHeadingTag: sectionHeadingSettings.headingTag } : {}),
        ...(sectionHeadingSettings?.alignment ? { sectionHeadingAlignment: sectionHeadingSettings.alignment } : {}),
        ...(typeof sectionHeadingSettings?.width === "number" ? { sectionHeadingWidth: sectionHeadingSettings.width } : {}),
        ...(typeof sectionHeadingSettings?.hidden === "boolean" ? { sectionHeadingHidden: sectionHeadingSettings.hidden } : {}),
        type: field.type,
        order: field.order,
        ...(field.required ? { required: field.required } : {}),
        ...(field.width ? { width: field.width } : {}),
        ...(field.section ? { section: field.section } : {}),
        ...(field.options ? { options: field.options } : {}),
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        ...(field.content ? { content: field.content } : {}),
        ...(field.metafieldTarget ? { metafieldTarget: field.metafieldTarget } : {}),
        ...(field.metafieldDefinition ? { metafieldDefinition: field.metafieldDefinition } : {}),
        ...(field.phoneDefaultCountry ? { phoneDefaultCountry: field.phoneDefaultCountry } : {}),
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
    if (field.section === "billing") return "billing";
    if (field.section === "company" || field.section === "contact") return "general";
    return "custom";
  };

  const steps: FormStep[] = stored.map((group) => group.step);
  const fields: FieldDef[] = stored.flatMap((group, stepIdx) =>
    group.fields
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
  const customLabel = fields.find((field) => field.sectionLabel?.trim())?.sectionLabel?.trim();
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
