import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  useFetcher,
  useLoaderData,
} from "react-router";

import { useAppBridge } from "@shopify/app-bridge-react";
import {
  boundary
} from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";


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

export interface FieldDef {
  id: string;
  paletteKey: string;
  category: FieldCategory;
  type: FieldType;
  label: string;
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
  key: string; // unique field key
  label: string; // visible label
  type: FieldType; // input type
  order: number; // position within this step
  required?: boolean;
  width?: FieldWidth; // "full" | "half"  (default: "full")
  section?: string; // visual grouping e.g. "company" | "contact" | "shipping" | "billing"
  options?: string[]; // for select / radio / multi-check
  placeholder?: string;
  content?: string; // for heading / paragraph / link display-only fields
}

// One entry per step
export interface StoredStepGroup {
  step: FormStep; // { id, label }
  fields: StoredField[]; // fields belonging to this step, sorted by order
}

// The full stored value — an array of step groups
export type StoredConfig = StoredStepGroup[];

// Loader response type
interface LoaderData {
  config: FormConfig;
  storeMissing: boolean;
  savedAt: string | null;
}

export const COUNTRY_LIST = [
  "Afghanistan",
  "Albania",
  "Algeria",
  "Andorra",
  "Angola",
  "Argentina",
  "Armenia",
  "Australia",
  "Austria",
  "Azerbaijan",
  "Bahamas",
  "Bahrain",
  "Bangladesh",
  "Barbados",
  "Belarus",
  "Belgium",
  "Belize",
  "Bolivia",
  "Bosnia and Herzegovina",
  "Botswana",
  "Brazil",
  "Brunei",
  "Bulgaria",
  "Cambodia",
  "Cameroon",
  "Canada",
  "Chile",
  "China",
  "Colombia",
  "Costa Rica",
  "Croatia",
  "Cuba",
  "Cyprus",
  "Czech Republic",
  "Denmark",
  "Dominican Republic",
  "Ecuador",
  "Egypt",
  "El Salvador",
  "Estonia",
  "Ethiopia",
  "Finland",
  "France",
  "Georgia",
  "Germany",
  "Ghana",
  "Greece",
  "Guatemala",
  "Honduras",
  "Hungary",
  "Iceland",
  "India",
  "Indonesia",
  "Iran",
  "Iraq",
  "Ireland",
  "Israel",
  "Italy",
  "Jamaica",
  "Japan",
  "Jordan",
  "Kazakhstan",
  "Kenya",
  "Kuwait",
  "Latvia",
  "Lebanon",
  "Libya",
  "Lithuania",
  "Luxembourg",
  "Malaysia",
  "Maldives",
  "Malta",
  "Mexico",
  "Moldova",
  "Monaco",
  "Mongolia",
  "Montenegro",
  "Morocco",
  "Myanmar",
  "Nepal",
  "Netherlands",
  "New Zealand",
  "Nicaragua",
  "Nigeria",
  "Norway",
  "Oman",
  "Pakistan",
  "Palestine",
  "Panama",
  "Paraguay",
  "Peru",
  "Philippines",
  "Poland",
  "Portugal",
  "Qatar",
  "Romania",
  "Russia",
  "Rwanda",
  "Saudi Arabia",
  "Senegal",
  "Serbia",
  "Singapore",
  "Slovakia",
  "Slovenia",
  "South Africa",
  "South Korea",
  "South Sudan",
  "Spain",
  "Sri Lanka",
  "Sudan",
  "Sweden",
  "Switzerland",
  "Syria",
  "Taiwan",
  "Tanzania",
  "Thailand",
  "Tunisia",
  "Turkey",
  "Uganda",
  "Ukraine",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Uruguay",
  "Uzbekistan",
  "Venezuela",
  "Vietnam",
  "Yemen",
  "Zambia",
  "Zimbabwe",
];

export const SECTION_LABELS: Record<string, string> = {
  company: "Company information",
  contact: "Contact information",
  shipping: "Shipping address",
  billing: "Billing address",
};

const CATEGORY_INFO: Record<
  FieldCategory,
  { label: string; icon: string; description: string }
> = {
  general: {
    label: "General",
    icon: "👤",
    description:
      "Collect general information about the company, and who represents it as the main contact",
  },
  shipping: {
    label: "Shipping",
    icon: "🚚",
    description: "Collect the company's main shipping address",
  },
  billing: {
    label: "Billing",
    icon: "💳",
    description: "Collect the company's main billing address",
  },
  custom: {
    label: "Custom",
    icon: "✏️",
    description:
      "Collect additional information and save to Shopify metafields",
  },
  display: {
    label: "Display",
    icon: "🖼️",
    description: "Add elements that do not require customer input",
  },
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
      label: "Company name",
      type: "text",
      key: "companyName",
      section: "company",
      required: true,
      width: "full",
    },
    {
      paletteKey: "taxId",
      label: "Tax registration ID",
      type: "text",
      key: "taxId",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "firstName",
      label: "Contact first name",
      type: "text",
      key: "firstName",
      section: "contact",
      required: true,
      width: "half",
    },
    {
      paletteKey: "lastName",
      label: "Contact last name",
      type: "text",
      key: "lastName",
      section: "contact",
      width: "half",
    },
    {
      paletteKey: "contactTitle",
      label: "Contact title",
      type: "text",
      key: "contactTitle",
      section: "contact",
      width: "full",
    },
    {
      paletteKey: "locationName",
      label: "Main location name",
      type: "text",
      key: "locationName",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "email",
      label: "Email",
      type: "email",
      key: "email",
      section: "contact",
      required: true,
      width: "full",
    },
    {
      paletteKey: "phone",
      label: "Phone",
      type: "phone",
      key: "phone",
      section: "contact",
      width: "full",
    },
    {
      paletteKey: "website",
      label: "Website",
      type: "text",
      key: "website",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "businessType",
      label: "Business type",
      type: "text",
      key: "businessType",
      section: "company",
      width: "full",
    },
    {
      paletteKey: "additionalInfo",
      label: "Additional info",
      type: "textarea",
      key: "additionalInfo",
      width: "full",
    },
  ],
  shipping: [
    {
      paletteKey: "shipDept",
      label: "Department/attention",
      type: "text",
      key: "shipDept",
      section: "shipping",
      width: "full",
    },
    {
      paletteKey: "shipFirstName",
      label: "Shipping first name",
      type: "text",
      key: "shipFirstName",
      section: "shipping",
      width: "half",
    },
    {
      paletteKey: "shipLastName",
      label: "Shipping last name",
      type: "text",
      key: "shipLastName",
      section: "shipping",
      width: "half",
    },
    {
      paletteKey: "shipPhone",
      label: "Shipping phone",
      type: "phone",
      key: "shipPhone",
      section: "shipping",
      width: "full",
    },
    {
      paletteKey: "shipAddr1",
      label: "Shipping address line 1",
      type: "text",
      key: "shipAddr1",
      section: "shipping",
      width: "full",
    },
    {
      paletteKey: "shipAddr2",
      label: "Shipping address line 2",
      type: "text",
      key: "shipAddr2",
      section: "shipping",
      width: "full",
    },
    {
      paletteKey: "shipCity",
      label: "Shipping city",
      type: "text",
      key: "shipCity",
      section: "shipping",
      width: "full",
    },
    {
      paletteKey: "shipCountry",
      label: "Shipping country",
      type: "country",
      key: "shipCountry",
      section: "shipping",
      width: "full",
    },
    {
      paletteKey: "shipState",
      label: "Shipping state/province",
      type: "state",
      key: "shipState",
      section: "shipping",
      width: "full",
    },
    {
      paletteKey: "shipZip",
      label: "Shipping ZIP/Postal code",
      type: "text",
      key: "shipZip",
      section: "shipping",
      width: "full",
    },
  ],
  billing: [
    {
      paletteKey: "billSameAsShip",
      label: "Same as shipping address",
      type: "checkbox",
      key: "billSameAsShip",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billDept",
      label: "Department/attention",
      type: "text",
      key: "billDept",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billFirstName",
      label: "Billing first name",
      type: "text",
      key: "billFirstName",
      section: "billing",
      width: "half",
    },
    {
      paletteKey: "billLastName",
      label: "Billing last name",
      type: "text",
      key: "billLastName",
      section: "billing",
      width: "half",
    },
    {
      paletteKey: "billPhone",
      label: "Billing phone",
      type: "phone",
      key: "billPhone",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billAddr1",
      label: "Billing address line 1",
      type: "text",
      key: "billAddr1",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billAddr2",
      label: "Billing address line 2",
      type: "text",
      key: "billAddr2",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billCity",
      label: "Billing city",
      type: "text",
      key: "billCity",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billCountry",
      label: "Billing country",
      type: "country",
      key: "billCountry",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billState",
      label: "Billing state/province",
      type: "state",
      key: "billState",
      section: "billing",
      width: "full",
    },
    {
      paletteKey: "billZip",
      label: "Billing ZIP/Postal code",
      type: "text",
      key: "billZip",
      section: "billing",
      width: "full",
    },
  ],
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

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIG — all fields in Step 1
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_CONFIG: FormConfig = {
  steps: [{ id: "step-0", label: "Step 1" }],
  fields: [
    // Company information
    {
      id: "f01",
      paletteKey: "companyName",
      category: "general",
      type: "text",
      label: "Company name",
      key: "companyName",
      section: "company",
      required: true,
      width: "full",
      stepIndex: 0,
      order: 0,
    },
    {
      id: "f02",
      paletteKey: "taxId",
      category: "general",
      type: "text",
      label: "Tax registration ID",
      key: "taxId",
      section: "company",
      width: "full",
      stepIndex: 0,
      order: 1,
    },
    // Contact information
    {
      id: "f03",
      paletteKey: "firstName",
      category: "general",
      type: "text",
      label: "First name",
      key: "firstName",
      section: "contact",
      required: true,
      width: "half",
      stepIndex: 0,
      order: 2,
    },
    {
      id: "f04",
      paletteKey: "lastName",
      category: "general",
      type: "text",
      label: "Last name",
      key: "lastName",
      section: "contact",
      width: "half",
      stepIndex: 0,
      order: 3,
    },
    {
      id: "f05",
      paletteKey: "contactTitle",
      category: "general",
      type: "text",
      label: "Job title/position",
      key: "contactTitle",
      section: "contact",
      width: "full",
      stepIndex: 0,
      order: 4,
    },
    // Shipping address
    {
      id: "f06",
      paletteKey: "shipDept",
      category: "shipping",
      type: "text",
      label: "Department/attention",
      key: "shipDept",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 5,
    },
    {
      id: "f07",
      paletteKey: "shipFirstName",
      category: "shipping",
      type: "text",
      label: "First name",
      key: "shipFirstName",
      section: "shipping",
      width: "half",
      stepIndex: 0,
      order: 6,
    },
    {
      id: "f08",
      paletteKey: "shipLastName",
      category: "shipping",
      type: "text",
      label: "Last name",
      key: "shipLastName",
      section: "shipping",
      width: "half",
      stepIndex: 0,
      order: 7,
    },
    {
      id: "f09",
      paletteKey: "shipPhone",
      category: "shipping",
      type: "phone",
      label: "Phone",
      key: "shipPhone",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 8,
    },
    {
      id: "f10",
      paletteKey: "shipAddr1",
      category: "shipping",
      type: "text",
      label: "Address line 1",
      key: "shipAddr1",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 9,
    },
    {
      id: "f11",
      paletteKey: "shipAddr2",
      category: "shipping",
      type: "text",
      label: "Address line 2",
      key: "shipAddr2",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 10,
    },
    {
      id: "f12",
      paletteKey: "shipCity",
      category: "shipping",
      type: "text",
      label: "City",
      key: "shipCity",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 11,
    },
    {
      id: "f13",
      paletteKey: "shipCountry",
      category: "shipping",
      type: "country",
      label: "Country",
      key: "shipCountry",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 12,
    },
    {
      id: "f14",
      paletteKey: "shipState",
      category: "shipping",
      type: "state",
      label: "State/Province",
      key: "shipState",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 13,
    },
    {
      id: "f15",
      paletteKey: "shipZip",
      category: "shipping",
      type: "text",
      label: "ZIP/Postal code",
      key: "shipZip",
      section: "shipping",
      width: "full",
      stepIndex: 0,
      order: 14,
    },
    // Billing address
    {
      id: "f16",
      paletteKey: "billSameAsShip",
      category: "billing",
      type: "checkbox",
      label: "Same as shipping address",
      key: "billSameAsShip",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 15,
    },
    {
      id: "f17",
      paletteKey: "billDept",
      category: "billing",
      type: "text",
      label: "Department/attention",
      key: "billDept",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 16,
    },
    {
      id: "f18",
      paletteKey: "billFirstName",
      category: "billing",
      type: "text",
      label: "First name",
      key: "billFirstName",
      section: "billing",
      width: "half",
      stepIndex: 0,
      order: 17,
    },
    {
      id: "f19",
      paletteKey: "billLastName",
      category: "billing",
      type: "text",
      label: "Last name",
      key: "billLastName",
      section: "billing",
      width: "half",
      stepIndex: 0,
      order: 18,
    },
    {
      id: "f20",
      paletteKey: "billPhone",
      category: "billing",
      type: "phone",
      label: "Phone",
      key: "billPhone",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 19,
    },
    {
      id: "f21",
      paletteKey: "billAddr1",
      category: "billing",
      type: "text",
      label: "Address line 1",
      key: "billAddr1",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 20,
    },
    {
      id: "f22",
      paletteKey: "billAddr2",
      category: "billing",
      type: "text",
      label: "Address line 2",
      key: "billAddr2",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 21,
    },
    {
      id: "f23",
      paletteKey: "billCity",
      category: "billing",
      type: "text",
      label: "City",
      key: "billCity",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 22,
    },
    {
      id: "f24",
      paletteKey: "billCountry",
      category: "billing",
      type: "country",
      label: "Country",
      key: "billCountry",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 23,
    },
    {
      id: "f25",
      paletteKey: "billState",
      category: "billing",
      type: "state",
      label: "State/Province",
      key: "billState",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 24,
    },
    {
      id: "f26",
      paletteKey: "billZip",
      category: "billing",
      type: "text",
      label: "ZIP/Postal code",
      key: "billZip",
      section: "billing",
      width: "full",
      stepIndex: 0,
      order: 25,
    },
  ],
};



// Serialize: FormConfig → StoredConfig (array of step-groups, no stepIndex on fields)
function serializeConfig(config: FormConfig): StoredConfig {
  return config.steps.map((step, stepIdx): StoredStepGroup => {
    const stepFields = config.fields
      .filter((f) => f.stepIndex === stepIdx)
      .sort((a, b) => a.order - b.order)
      .map(
        (f): StoredField => ({
          key: f.key,
          label: f.label,
          type: f.type,
          order: f.order,
          ...(f.required ? { required: f.required } : {}),
          ...(f.width && f.width !== "full"
            ? { width: f.width }
            : f.width === "full"
              ? { width: f.width }
              : {}),
          ...(f.section ? { section: f.section } : {}),
          ...(f.options ? { options: f.options } : {}),
          ...(f.placeholder ? { placeholder: f.placeholder } : {}),
          ...(f.content ? { content: f.content } : {}),
        }),
      );

    return { step, fields: stepFields };
  });
}

// Deserialize: StoredConfig (array of step-groups) → FormConfig (flat with stepIndex)
function deserializeConfig(stored: StoredConfig): FormConfig {
  const DISPLAY_TYPES: FieldType[] = [
    "heading",
    "paragraph",
    "link",
    "divider",
  ];

  const inferCategory = (f: StoredField): FieldCategory => {
    if (DISPLAY_TYPES.includes(f.type)) return "display";
    if (f.section === "shipping") return "shipping";
    if (f.section === "billing") return "billing";
    if (f.section === "company" || f.section === "contact") return "general";
    return "custom";
  };

  const steps: FormStep[] = stored.map((g) => g.step);

  const fields: FieldDef[] = stored.flatMap((group, stepIdx) =>
    group.fields
      .sort((a, b) => a.order - b.order)
      .map(
        (f): FieldDef => ({
          // Runtime-only props — derived, never stored
          id: `_${f.key}_${stepIdx}_${f.order}`,
          paletteKey: f.key,
          category: inferCategory(f),
          isDisplay: DISPLAY_TYPES.includes(f.type),
          // Stored props
          key: f.key,
          label: f.label,
          type: f.type,
          order: f.order,
          stepIndex: stepIdx, // ← re-injected from array position
          width: f.width ?? "full",
          required: f.required,
          section: f.section,
          options: f.options,
          placeholder: f.placeholder,
          content: f.content,
        }),
      ),
  );

  return { steps, fields };
}

// Pre-serialized default (array of step-groups) — used for resetConfig
const STORED_DEFAULT: StoredConfig = serializeConfig(DEFAULT_CONFIG);



export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json({
      config: DEFAULT_CONFIG,
      storeMissing: true,
      savedAt: null,
    });
  }

  const formFieldConfig = await prisma.formFieldConfig.findUnique({
    where: { shopId: store.id },
  });

  let config = DEFAULT_CONFIG;

  if (formFieldConfig?.fields) {
    try {
      const stored = formFieldConfig.fields as unknown as StoredConfig;
      if (
        Array.isArray(stored) &&
        stored.length > 0 &&
        stored.every(
          (g) =>
            g.step?.id &&
            g.step?.label &&
            Array.isArray(g.fields) &&
            g.fields.every((f) => f.key && f.label && f.type !== undefined)
        )
      ) {
        config = deserializeConfig(stored);
      }
    } catch {
      config = DEFAULT_CONFIG;
    }
  }

  return Response.json({
    config,
    storeMissing: false,
    savedAt: formFieldConfig?.updatedAt?.toISOString() ?? null,
  });
};



// ✅ Helper: map form data → prisma data
function mapToRegistrationData(formData: Record<string, any>) {
  const REGISTRATION_COLUMNS = [
    "companyName",
    "email",
    "firstName",
    "lastName",
    "contactTitle",
    "isPrivacyPolicy",
  ];

  const mainData: Record<string, any> = {};
  const customFields: Record<string, any> = {};
  let shipping: Record<string, any> = {};
  let billing: Record<string, any> = {};

  for (const key in formData) {
    const value = formData[key];

    // ✅ direct columns
    if (REGISTRATION_COLUMNS.includes(key)) {
      mainData[key] = value;
      continue;
    }

    // ✅ shipping
    if (key.startsWith("ship")) {
      shipping[key] = value;
      continue;
    }

    // ✅ billing
    if (key.startsWith("bill")) {
      billing[key] = value;
      continue;
    }
  if (key === "email" || key.startsWith("email")) {
  mainData.email = value;
  continue;
}

    customFields[key] = value;
  }

  return {
    ...mainData,
    shipping,
    billing,
    customFields,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { success: false, intent: "unknown", error: "Store not found" },
      { status: 404 },
    );
  }

  const body = (await request.json()) as {
    intent: string;
    config?: FormConfig;
  };
  const { intent, config } = body;

  // ── intent: saveConfig ────────────────────────────────────────────────────
  if (intent === "saveConfig") {
    if (
      !config ||
      !Array.isArray(config.steps) ||
      !Array.isArray(config.fields)
    ) {
      return Response.json(
        { success: false, intent, error: "Invalid config payload" },
        { status: 400 },
      );
    }

    // Serialize: strip id/paletteKey/category/isDisplay → minimal StoredConfig
    const toStore: StoredConfig = serializeConfig(config);

    const saved = await prisma.formFieldConfig.upsert({
      where: { shopId: store.id },
      update: { fields: toStore as any },
      create: { shopId: store.id, fields: toStore as any },
    });

    return Response.json({
      success: true,
      intent,
      savedAt: saved.updatedAt.toISOString(),
      stepCount: toStore.length, // ✅ array length = number of steps
      fieldCount: toStore.reduce((sum, g) => sum + g.fields.length, 0), // ✅ sum fields across all step-groups
    });
  }

  // ── intent: resetConfig ───────────────────────────────────────────────────
  if (intent === "resetConfig") {
    const saved = await prisma.formFieldConfig.upsert({
      where: { shopId: store.id },
      update: { fields: STORED_DEFAULT as any },
      create: { shopId: store.id, fields: STORED_DEFAULT as any },
    });

    return Response.json({
      success: true,
      intent,
      config: DEFAULT_CONFIG, // full FormConfig back to UI
      savedAt: saved.updatedAt.toISOString(),
    });
  }

  if (intent === "submitRegistration") {
 
  const formData = body.data;

  const mapped = mapToRegistrationData(formData);
  console.log(mapped,"mapped....");

  return Response.json({
    success: true,
    intent,
    mappedData: mapped, // 👈 ONLY return mapped result
  });
}

  return Response.json(
    { success: false, intent, error: `Unknown intent: ${intent}` },
    { status: 400 },
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const uid = () => Math.random().toString(36).slice(2, 9);

function groupBySection(fields: FieldDef[]) {
  const map: Record<string, FieldDef[]> = {};
  const seen = new Set<string>();
  const order: string[] = [];
  const none: FieldDef[] = [];
  for (const f of fields) {
    if (f.section) {
      if (!seen.has(f.section)) {
        seen.add(f.section);
        order.push(f.section);
      }
      (map[f.section] = map[f.section] || []).push(f);
    } else {
      none.push(f);
    }
  }
  return { map, order, none };
}

function pairHalfWidths(
  fields: FieldDef[],
): Array<FieldDef | [FieldDef, FieldDef]> {
  const rows: Array<FieldDef | [FieldDef, FieldDef]> = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (
      f.width === "half" &&
      i + 1 < fields.length &&
      fields[i + 1].width === "half"
    ) {
      rows.push([f, fields[i + 1]]);
      i += 2;
    } else {
      rows.push(f);
      i++;
    }
  }
  return rows;
}

function formatSavedAt(iso: string | null): string {
  if (!iso) return "Never saved";
  const d = new Date(iso);
  return `Last saved ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS FIELD PREVIEW INPUT
// ═══════════════════════════════════════════════════════════════════════════════

const previewInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 14px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 16,
  color: "#9ca3af",
  background: "#fff",
  boxSizing: "border-box",
  minHeight: 30,
};

function FieldPreviewInput({ field }: { field: FieldDef }) {
  switch (field.type) {
    case "divider":
      return (
        <hr
          style={{
            border: "none",
            borderTop: "1px solid #e5e7eb",
            margin: "2px 0",
          }}
        />
      );
    case "heading":
      return (
        <div style={{ fontWeight: 700, fontSize: 18, color: "#111827" }}>
          {field.label}
        </div>
      );
    case "paragraph":
      return (
        <div style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.5 }}>
          {field.content || field.label}
        </div>
      );
    case "link":
      return (
        <a
          href="#"
          style={{ fontSize: 14, color: "#2c6ecb", pointerEvents: "none" }}
        >
          {field.label}
        </a>
      );
    case "textarea":
      return <div style={{ ...previewInputStyle, minHeight: 50 }} />;
    case "checkbox":
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "4px 0",
          }}
        >
          <input
            type="checkbox"
            disabled
            style={{ width: 16, height: 16, cursor: "default" }}
          />
          <span style={{ fontSize: 15, color: "#374151" }}>{field.label}</span>
        </div>
      );
    case "country":
      return (
        <div
          style={{
            ...previewInputStyle,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Select a country...</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#9ca3af"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      );
    case "state":
      return (
        <div
          style={{
            ...previewInputStyle,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>&nbsp;</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#9ca3af"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      );
    case "select":
      return (
        <div
          style={{
            ...previewInputStyle,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Select an option</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#9ca3af"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      );
    case "date":
      return (
        <div style={{ ...previewInputStyle, color: "#c4c4c4" }}>dd/mm/yyyy</div>
      );
    case "file":
      return (
        <div style={{ ...previewInputStyle, fontSize: 14 }}>Choose file…</div>
      );
    case "radio":
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "2px 0",
          }}
        >
          {["Option 1", "Option 2"].map((o) => (
            <label
              key={o}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 15,
                color: "#6b7280",
              }}
            >
              <input type="radio" disabled style={{ width: 16, height: 16 }} />{" "}
              {o}
            </label>
          ))}
        </div>
      );
    default:
      return <div style={previewInputStyle} />;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS FIELD ROW
// ═══════════════════════════════════════════════════════════════════════════════

function CanvasField({
  field,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
}: {
  field: FieldDef;
  onRemove: () => void;
  onDragStart: (e: DragEvent, f: FieldDef) => void;
  onDragOver: (e: DragEvent, f: FieldDef) => void;
  onDrop: (e: DragEvent, f: FieldDef) => void;
  isDragOver: boolean;
}) {
  const isDisplay = ["heading", "paragraph", "divider", "link"].includes(
    field.type,
  );
  const isCheck = field.type === "checkbox";

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, field)}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDragOver(e, field);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop(e, field);
      }}
      style={{
        padding: "6px 6px",
        borderRadius: 6,
        border: isDragOver ? "2px dashed #6366f1" : "2px solid transparent",
        background: isDragOver ? "#eef2ff" : "transparent",
        cursor: "grab",
        transition: "all 0.12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
        {/* Drag grip */}
        <div
          style={{
            color: "#d1d5db",
            fontSize: 14,
            marginTop: 12,
            flexShrink: 0,
            lineHeight: 1,
            cursor: "grab",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2" cy="2" r="1.5" />
            <circle cx="8" cy="2" r="1.5" />
            <circle cx="2" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="2" cy="14" r="1.5" />
            <circle cx="8" cy="14" r="1.5" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {!isDisplay && !isCheck && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "#374151",
                marginBottom: 4,
              }}
            >
              {field.label}
              {field.required && (
                <span style={{ color: "#dc2626", marginLeft: 2 }}>*</span>
              )}
            </div>
          )}
          <FieldPreviewInput field={field} />
        </div>
        {/* Delete button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            color: "#dc2626",
            padding: "8px 4px",
            flexShrink: 0,
            borderRadius: 4,
            opacity: 0.6,
            transition: "opacity 0.1s",
            display: "flex",
            alignItems: "center",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
          title="Remove field"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD ROWS (handles half-width pairing)
// ═══════════════════════════════════════════════════════════════════════════════

function FieldRows({
  fields,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  dragOverId,
}: {
  fields: FieldDef[];
  onRemove: (id: string) => void;
  onDragStart: (e: DragEvent, f: FieldDef) => void;
  onDragOver: (e: DragEvent, f: FieldDef) => void;
  onDrop: (e: DragEvent, f: FieldDef) => void;
  dragOverId: string | null;
}) {
  const rows = pairHalfWidths(fields);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {rows.map((row, ri) =>
        Array.isArray(row) ? (
          <div
            key={ri}
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            {row.map((f) => (
              <CanvasField
                key={f.id}
                field={f}
                onRemove={() => onRemove(f.id)}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                isDragOver={dragOverId === f.id}
              />
            ))}
          </div>
        ) : (
          <CanvasField
            key={row.id}
            field={row}
            onRemove={() => onRemove(row.id)}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            isDragOver={dragOverId === row.id}
          />
        ),
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION BLOCK — draggable header with copy + delete actions
// ═══════════════════════════════════════════════════════════════════════════════

function SectionBlock({
  section,
  fields,
  sectionLabel,
  isActive,
  onRemoveField,
  onRemoveSection,
  onDuplicateSection,
  onSectionDragStart,
  onSectionDragOver,
  onSectionDrop,
  onFieldDragStart,
  onFieldDragOver,
  onFieldDrop,
  fieldDragOverId,
  isSectionDragOver,
  onActivate,
}: {
  section: string;
  fields: FieldDef[];
  sectionLabel: string;
  isActive: boolean;
  onRemoveField: (id: string) => void;
  onRemoveSection: (s: string) => void;
  onDuplicateSection: (s: string) => void;
  onSectionDragStart: (e: DragEvent, s: string) => void;
  onSectionDragOver: (e: DragEvent, s: string) => void;
  onSectionDrop: (e: DragEvent, s: string) => void;
  onFieldDragStart: (e: DragEvent, f: FieldDef) => void;
  onFieldDragOver: (e: DragEvent, f: FieldDef) => void;
  onFieldDrop: (e: DragEvent, f: FieldDef) => void;
  fieldDragOverId: string | null;
  isSectionDragOver: boolean;
  onActivate: () => void;
}) {
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onActivate();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSectionDragOver(e, section);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSectionDrop(e, section);
      }}
      style={{
        marginBottom: 12,
        borderRadius: 10,
        background: "#fff",
        border: isSectionDragOver
          ? "2px dashed #6366f1"
          : isActive
            ? "2px solid #e5e7eb"
            : "2px solid transparent",
        boxShadow: isActive ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
        overflow: "hidden",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      {/* Section header */}
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          onSectionDragStart(e, section);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px 10px 10px",
          background: isActive ? "#fafafa" : "transparent",
          borderBottom: isActive
            ? "1px solid #f3f4f6"
            : "1px solid transparent",
          cursor: "grab",
          userSelect: "none",
        }}
      >
        {/* Drag grip */}
        <div style={{ color: "#c4b5fd", flexShrink: 0 }}>
          <svg width="10" height="10" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2" cy="2" r="1.5" />
            <circle cx="8" cy="2" r="1.5" />
            <circle cx="2" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="2" cy="14" r="1.5" />
            <circle cx="8" cy="14" r="1.5" />
          </svg>
        </div>

        {/* Section title */}
        <h3
          style={{
            flex: 1,
            margin: 0,
            fontWeight: 700,
            fontSize: 17,
            color: "#111827",
          }}
        >
          {sectionLabel}
        </h3>

        {/* Duplicate */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDuplicateSection(section);
          }}
          title="Duplicate section"
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            color: "#6b7280",
            padding: "4px 5px",
            borderRadius: 5,
            display: "flex",
            alignItems: "center",
            transition: "background 0.12s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>

        {/* Delete */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemoveSection(section);
          }}
          title="Remove section"
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            color: "#dc2626",
            padding: "4px 5px",
            borderRadius: 5,
            display: "flex",
            alignItems: "center",
            opacity: 0.7,
            transition: "background 0.12s, opacity 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#fef2f2";
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.opacity = "0.7";
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      </div>

      {/* Fields */}
      <div style={{ padding: "10px 12px 12px" }}>
        <FieldRows
          fields={fields}
          onRemove={onRemoveField}
          onDragStart={onFieldDragStart}
          onDragOver={onFieldDragOver}
          onDrop={onFieldDrop}
          dragOverId={fieldDragOverId}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function FormEditor() {
  const {
    config: initialConfig,
    storeMissing,
    savedAt: initialSavedAt,
  } = useLoaderData<LoaderData>();

  const fetcher = useFetcher<{
    success: boolean;
    intent: string;
    savedAt?: string;
    config?: FormConfig;
    error?: string;
  }>();
  const shopify = useAppBridge();

  const [config, setConfig] = useState<FormConfig>(initialConfig);
  const [savedAt, setSavedAt] = useState<string | null>(initialSavedAt);
  const [activeCategory, setActiveCategory] =
    useState<FieldCategory>("general");
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [editingSteps, setEditingSteps] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [fieldDragOverId, setFieldDragOverId] = useState<string | null>(null);
  const [sectionDragOver, setSectionDragOver] = useState<string | null>(null);
  const [isDragOverCanvas, setIsDragOverCanvas] = useState(false);
  const [hasUnsaved, setHasUnsaved] = useState(false);

  const dragPayloadRef = useRef<
    | { kind: "palette"; item: (typeof PALETTE.general)[0] }
    | { kind: "field"; field: FieldDef }
    | { kind: "section"; section: string }
    | null
  >(null);

  const isSaving = fetcher.state !== "idle";
  const isResetting = isSaving && fetcher.formData === undefined;
  const pendingSubmitRef = useRef(false);

 const handleSaveAndSubmit = useCallback(() => {
  // Step 1: Save config
  fetcher.submit(
    JSON.stringify({
      intent: "saveConfig",
      config,
    }),
    {
      method: "post",
      encType: "application/json",
    }
  );

  // Mark that after save → we need submit
  pendingSubmitRef.current = true;

}, [config, fetcher]);

  // ── Handle fetcher response ────────────────────────────────────────────────
useEffect(() => {
  if (!fetcher.data) return;

  // ✅ SAVE SUCCESS
  if (fetcher.data.success && fetcher.data.intent === "saveConfig") {
    setSavedAt(fetcher.data.savedAt ?? null);
    setHasUnsaved(false);
    shopify.toast.show?.("Form saved successfully");

    // 👉 STEP 2: Now trigger submitRegistration
    if (pendingSubmitRef.current) {
      pendingSubmitRef.current = false;

      const formData: Record<string, any> = {};

      config.fields.forEach((field) => {
        formData[field.key] = `${field.key}`; // replace with real values
      });

      fetcher.submit(
        JSON.stringify({
          intent: "submitRegistration",
          data: formData,
        }),
        {
          method: "post",
          encType: "application/json",
        }
      );
    }
  }
  else if (fetcher.data.success && fetcher.data.intent === "submitRegistration") {
    shopify.toast.show?.("Registration mapped successfully 🎉");
  }

  // ❌ ERROR
  else if (!fetcher.data.success) {
    pendingSubmitRef.current = false;
    shopify.toast.show?.(
      `Error: ${fetcher.data.error ?? "Unknown error"}`,
      { isError: true }
    );
  }

}, [fetcher.data, config, shopify]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const stepFields = useMemo(
    () =>
      config.fields
        .filter((f) => f.stepIndex === activeStepIndex)
        .sort((a, b) => a.order - b.order),
    [config.fields, activeStepIndex],
  );

  const {
    map: sectionMap,
    order: sectionOrder,
    none: noSection,
  } = useMemo(() => groupBySection(stepFields), [stepFields]);

  // Mark unsaved changes whenever config changes (but not on initial load)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setHasUnsaved(true);
  }, [config]);

  // ── Save & Reset ───────────────────────────────────────────────────────────
  const save = useCallback(() => {
    fetcher.submit(JSON.stringify({ intent: "saveConfig", config }), {
      method: "post",
      encType: "application/json",
    });
  }, [config, fetcher]);

  const resetToDefault = useCallback(() => {
    if (
      !window.confirm("Reset form to default? All customizations will be lost.")
    )
      return;
    fetcher.submit(JSON.stringify({ intent: "resetConfig" }), {
      method: "post",
      encType: "application/json",
    });
  }, [fetcher]);

  // ── Field management ───────────────────────────────────────────────────────
  const addField = useCallback(
    (paletteItem: (typeof PALETTE.general)[0], afterFieldId?: string) => {
      const newField: FieldDef = {
        id: uid(),
        paletteKey: paletteItem.paletteKey,
        category: activeCategory,
        type: paletteItem.type,
        label: paletteItem.label,
        key: `${paletteItem.key}_${uid()}`,
        section: paletteItem.section,
        required: paletteItem.required,
        isDisplay: paletteItem.isDisplay,
        width: paletteItem.width ?? "full",
        stepIndex: activeStepIndex,
        order: 0,
      };

      setConfig((prev) => {
        const stepF = prev.fields
          .filter((f) => f.stepIndex === activeStepIndex)
          .sort((a, b) => a.order - b.order);

        if (afterFieldId) {
          const idx = stepF.findIndex((f) => f.id === afterFieldId);
          stepF.splice(Math.max(idx + 1, 0), 0, newField);
        } else {
          newField.order = stepF.length;
          return { ...prev, fields: [...prev.fields, newField] };
        }

        return {
          ...prev,
          fields: [
            ...prev.fields.filter((f) => f.stepIndex !== activeStepIndex),
            ...stepF.map((f, i) => ({ ...f, order: i })),
          ],
        };
      });
    },
    [activeCategory, activeStepIndex],
  );

  const removeField = useCallback((id: string) => {
    setConfig((prev) => {
      const si = prev.fields.find((f) => f.id === id)?.stepIndex ?? 0;
      const rest = prev.fields.filter((f) => f.id !== id);
      const reord = rest
        .filter((f) => f.stepIndex === si)
        .sort((a, b) => a.order - b.order)
        .map((f, i) => ({ ...f, order: i }));
      return {
        ...prev,
        fields: [...rest.filter((f) => f.stepIndex !== si), ...reord],
      };
    });
  }, []);

  const removeSection = useCallback(
    (section: string) => {
      if (
        !window.confirm(
          `Remove "${SECTION_LABELS[section] || section}" and all its fields?`,
        )
      )
        return;
      setConfig((prev) => {
        const rest = prev.fields.filter(
          (f) => !(f.section === section && f.stepIndex === activeStepIndex),
        );
        const reord = rest
          .filter((f) => f.stepIndex === activeStepIndex)
          .sort((a, b) => a.order - b.order)
          .map((f, i) => ({ ...f, order: i }));
        return {
          ...prev,
          fields: [
            ...rest.filter((f) => f.stepIndex !== activeStepIndex),
            ...reord,
          ],
        };
      });
    },
    [activeStepIndex],
  );

  const duplicateSection = useCallback(
    (section: string) => {
      setConfig((prev) => {
        const stepF = prev.fields
          .filter((f) => f.stepIndex === activeStepIndex)
          .sort((a, b) => a.order - b.order);
        const sectionFields = stepF.filter((f) => f.section === section);
        const newKey = `${section}_${uid()}`;
        const lastOrder = stepF[stepF.length - 1]?.order ?? -1;
        const copies = sectionFields.map((f, i) => ({
          ...f,
          id: uid(),
          key: `${f.key}_${uid()}`,
          section: newKey,
          order: lastOrder + 1 + i,
        }));
        return { ...prev, fields: [...prev.fields, ...copies] };
      });
    },
    [activeStepIndex],
  );

  // ── Drag handlers ──────────────────────────────────────────────────────────
  const handlePaletteDragStart = useCallback(
    (e: DragEvent, item: (typeof PALETTE.general)[0]) => {
      dragPayloadRef.current = { kind: "palette", item };
      e.dataTransfer.effectAllowed = "copy";
    },
    [],
  );

  const handleFieldDragStart = useCallback((e: DragEvent, field: FieldDef) => {
    dragPayloadRef.current = { kind: "field", field };
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleFieldDragOver = useCallback((_e: DragEvent, field: FieldDef) => {
    setFieldDragOverId(field.id);
  }, []);

  const handleFieldDrop = useCallback(
    (_e: DragEvent, targetField: FieldDef) => {
      const payload = dragPayloadRef.current;
      setFieldDragOverId(null);
      if (!payload) return;

      if (payload.kind === "palette") {
        addField(payload.item, targetField.id);
      } else if (payload.kind === "field") {
        const srcId = payload.field.id;
        if (srcId === targetField.id) return;
        setConfig((prev) => {
          const stepF = prev.fields
            .filter((f) => f.stepIndex === activeStepIndex)
            .sort((a, b) => a.order - b.order);
          const si = stepF.findIndex((f) => f.id === srcId);
          const ti = stepF.findIndex((f) => f.id === targetField.id);
          if (si === -1 || ti === -1) return prev;
          const [moved] = stepF.splice(si, 1);
          stepF.splice(ti, 0, moved);
          return {
            ...prev,
            fields: [
              ...prev.fields.filter((f) => f.stepIndex !== activeStepIndex),
              ...stepF.map((f, i) => ({ ...f, order: i })),
            ],
          };
        });
      }
      dragPayloadRef.current = null;
    },
    [activeStepIndex, addField],
  );

  const handleSectionDragStart = useCallback(
    (e: DragEvent, section: string) => {
      dragPayloadRef.current = { kind: "section", section };
      e.dataTransfer.effectAllowed = "move";
    },
    [],
  );

  const handleSectionDragOver = useCallback(
    (_e: DragEvent, section: string) => {
      if (
        dragPayloadRef.current?.kind === "section" &&
        dragPayloadRef.current.section !== section
      ) {
        setSectionDragOver(section);
      }
    },
    [],
  );

  const handleSectionDrop = useCallback(
    (_e: DragEvent, targetSection: string) => {
      const payload = dragPayloadRef.current;
      setSectionDragOver(null);
      if (
        !payload ||
        payload.kind !== "section" ||
        payload.section === targetSection
      )
        return;

      const srcSection = payload.section;
      setConfig((prev) => {
        const stepF = prev.fields
          .filter((f) => f.stepIndex === activeStepIndex)
          .sort((a, b) => a.order - b.order);
        const seen = new Set<string>();
        const secOrder: string[] = [];
        for (const f of stepF) {
          const s = f.section || "__none__";
          if (!seen.has(s)) {
            seen.add(s);
            secOrder.push(s);
          }
        }
        const si = secOrder.indexOf(srcSection);
        const ti = secOrder.indexOf(targetSection);
        if (si === -1 || ti === -1) return prev;
        const copy = [...secOrder];
        const [moved] = copy.splice(si, 1);
        copy.splice(ti, 0, moved);

        const bySection: Record<string, FieldDef[]> = {};
        for (const f of stepF) {
          const s = f.section || "__none__";
          (bySection[s] = bySection[s] || []).push(f);
        }

        let order = 0;
        const reordered: FieldDef[] = [];
        for (const sec of copy) {
          for (const f of bySection[sec] || [])
            reordered.push({ ...f, order: order++ });
        }

        return {
          ...prev,
          fields: [
            ...prev.fields.filter((f) => f.stepIndex !== activeStepIndex),
            ...reordered,
          ],
        };
      });
      dragPayloadRef.current = null;
    },
    [activeStepIndex],
  );

  const handleCanvasZoneDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragOverCanvas(false);
      const payload = dragPayloadRef.current;
      if (!payload || payload.kind !== "palette") return;
      addField(payload.item);
      dragPayloadRef.current = null;
    },
    [addField],
  );

  // ── Step management ────────────────────────────────────────────────────────
  const addStep = () =>
    setConfig((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        { id: uid(), label: `Step ${prev.steps.length + 1}` },
      ],
    }));

  const removeStep = (idx: number) => {
    if (config.steps.length <= 1) return;
    if (config.fields.some((f) => f.stepIndex === idx)) {
      alert("Remove all fields from this step first.");
      return;
    }
    setConfig((prev) => ({
      steps: prev.steps.filter((_, i) => i !== idx),
      fields: prev.fields
        .filter((f) => f.stepIndex !== idx)
        .map((f) => ({
          ...f,
          stepIndex: f.stepIndex > idx ? f.stepIndex - 1 : f.stepIndex,
        })),
    }));
    if (activeStepIndex >= config.steps.length - 1)
      setActiveStepIndex(Math.max(0, activeStepIndex - 1));
  };

  const updateStepLabel = (idx: number, label: string) =>
    setConfig((prev) => ({
      ...prev,
      steps: prev.steps.map((s, i) => (i === idx ? { ...s, label } : s)),
    }));

  const palette = PALETTE[activeCategory];
  const totalFields = stepFields.length;
  const totalSections = sectionOrder.length;

  // ═════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════════

  if (storeMissing) {
    return (
      <s-page heading="Form editor">
        <s-section>
          <s-banner tone="critical">
            <p>Store not found. Please reinstall the app.</p>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Form editor">
      {/* ── Top action bar ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {/* Left: save status + field count */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>
            {formatSavedAt(savedAt)}
          </span>
          {hasUnsaved && (
            <span
              style={{
                fontSize: 12,
                color: "#f59e0b",
                fontWeight: 500,
                background: "#fffbeb",
                padding: "2px 8px",
                borderRadius: 99,
                border: "1px solid #fde68a",
              }}
            >
              Unsaved changes
            </span>
          )}
          <span style={{ fontSize: 12, color: "#9ca3af" }}>
            {totalFields} field{totalFields !== 1 ? "s" : ""} · {totalSections}{" "}
            section{totalSections !== 1 ? "s" : ""} · {config.steps.length} step
            {config.steps.length !== 1 ? "s" : ""}
          </span>
        </div>
        {/* Right: buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <s-button
            variant="tertiary"
            onClick={resetToDefault}
            disabled={isSaving}
          >
            Reset to default
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => shopify.toast.show?.("Install form — coming soon")}
            disabled={isSaving}
          >
            Install form
          </s-button>
          <s-button
  variant="primary"
  onClick={handleSaveAndSubmit}
  loading={isSaving}
>
  Save & Submit
</s-button>
        </div>
      </div>

      {/* ── Tab bar ────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid #e5e7eb",
          marginBottom: 16,
        }}
      >
        {["Form", "Rules", "Advanced settings"].map((t, ti) => (
          <button
            key={t}
            style={{
              padding: "8px 20px",
              border: "none",
              borderBottom:
                ti === 0 ? "2px solid #1f2937" : "2px solid transparent",
              background: "none",
              fontWeight: ti === 0 ? 600 : 400,
              fontSize: 14,
              color: ti === 0 ? "#111827" : "#6b7280",
              cursor: "pointer",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── 3-column editor ────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          overflow: "hidden",
          minHeight: 640,
          background: "#fff",
        }}
      >
        {/* ── Column 1: Category sidebar ─────────────────────────────────── */}
        <div
          style={{
            width: 152,
            borderRight: "1px solid #e5e7eb",
            background: "#fafafa",
            flexShrink: 0,
          }}
        >
          <div style={{ padding: "14px 0" }}>
            <div
              style={{
                padding: "0 14px 8px",
                fontSize: 10,
                fontWeight: 700,
                color: "#9ca3af",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              Fields
            </div>
            {(
              ["general", "shipping", "billing", "custom"] as FieldCategory[]
            ).map((cat) => (
              <button
                key={cat}
                onClick={() => {
                  setActiveCategory(cat);
                  setEditingSteps(false);
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 14px",
                  border: "none",
                  borderLeft:
                    activeCategory === cat && !editingSteps
                      ? "3px solid #6366f1"
                      : "3px solid transparent",
                  background:
                    activeCategory === cat && !editingSteps
                      ? "#f0f0ff"
                      : "none",
                  fontWeight:
                    activeCategory === cat && !editingSteps ? 600 : 400,
                  fontSize: 13,
                  color: "#111827",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  transition: "background 0.12s, border-color 0.12s",
                }}
              >
                <span style={{ fontSize: 15 }}>{CATEGORY_INFO[cat].icon}</span>
                {CATEGORY_INFO[cat].label}
              </button>
            ))}

            <div
              style={{
                padding: "12px 14px 8px",
                fontSize: 10,
                fontWeight: 700,
                color: "#9ca3af",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginTop: 4,
              }}
            >
              Other
            </div>
            <button
              onClick={() => {
                setActiveCategory("display");
                setEditingSteps(false);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 14px",
                border: "none",
                borderLeft:
                  activeCategory === "display" && !editingSteps
                    ? "3px solid #6366f1"
                    : "3px solid transparent",
                background:
                  activeCategory === "display" && !editingSteps
                    ? "#f0f0ff"
                    : "none",
                fontWeight:
                  activeCategory === "display" && !editingSteps ? 600 : 400,
                fontSize: 13,
                color: "#111827",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 15 }}>🖼️</span>Display
            </button>
            <button
              onClick={() => setEditingSteps(true)}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 14px",
                border: "none",
                borderLeft: editingSteps
                  ? "3px solid #6366f1"
                  : "3px solid transparent",
                background: editingSteps ? "#f0f0ff" : "none",
                fontWeight: editingSteps ? 600 : 400,
                fontSize: 13,
                color: "#111827",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 15 }}>📋</span>Form steps
            </button>
          </div>
        </div>

        {/* ── Column 2: Palette ──────────────────────────────────────────── */}
        <div
          style={{
            width: 214,
            borderRight: "1px solid #e5e7eb",
            background: "#fff",
            padding: "16px 12px",
            flexShrink: 0,
            overflowY: "auto",
          }}
        >
          {editingSteps ? (
            /* ── Steps editor ──────────────────────────────────────────────── */
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 14,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  Edit form steps
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => setEditingSteps(false)}
                    style={{
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      borderRadius: 6,
                      padding: "4px 10px",
                      fontSize: 12,
                      cursor: "pointer",
                      color: "#6b7280",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setEditingSteps(false)}
                    style={{
                      border: "none",
                      background: "#1f2937",
                      borderRadius: 6,
                      padding: "4px 10px",
                      fontSize: 12,
                      cursor: "pointer",
                      color: "#fff",
                      fontWeight: 600,
                    }}
                  >
                    Done
                  </button>
                </div>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "#6b7280",
                  marginBottom: 14,
                  lineHeight: 1.5,
                }}
              >
                Create a multi-step form by adding form steps. Assign fields to
                steps by dragging them to the desired form step tab.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {config.steps.map((step, idx) => (
                  <div
                    key={step.id}
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span
                      style={{ color: "#9ca3af", fontSize: 12, cursor: "grab" }}
                    >
                      ⠿
                    </span>
                    <input
                      value={step.label}
                      onChange={(e) => updateStepLabel(idx, e.target.value)}
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        border: "1px solid #d1d5db",
                        borderRadius: 6,
                        fontSize: 13,
                      }}
                    />
                    {idx > 0 && (
                      <button
                        onClick={() => removeStep(idx)}
                        style={{
                          border: "none",
                          background: "none",
                          cursor: "pointer",
                          color: "#dc2626",
                          padding: "4px",
                          borderRadius: 4,
                        }}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={addStep}
                style={{
                  marginTop: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "#1f2937",
                  color: "#fff",
                  border: "none",
                  borderRadius: 7,
                  padding: "7px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add new form step
              </button>
              <p
                style={{
                  fontSize: 11,
                  color: "#9ca3af",
                  marginTop: 12,
                  lineHeight: 1.5,
                }}
              >
                A step with fields cannot be deleted until the fields have been
                removed from it.
              </p>
            </div>
          ) : (
            /* ── Field palette ─────────────────────────────────────────────── */
            <div>
              <p
                style={{
                  fontSize: 12,
                  color: "#6b7280",
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                {CATEGORY_INFO[activeCategory].description}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {palette.map((item) => (
                  <div
                    key={item.paletteKey}
                    draggable
                    onDragStart={(e) => handlePaletteDragStart(e as any, item)}
                    onClick={() => addField(item)}
                    style={{
                      padding: "8px 11px",
                      background: "#fff",
                      border: "1px solid #e5e7eb",
                      borderRadius: 7,
                      cursor: "grab",
                      fontSize: 13,
                      color: "#374151",
                      userSelect: "none",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      transition:
                        "border-color 0.12s, box-shadow 0.12s, background 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLDivElement;
                      el.style.borderColor = "#6366f1";
                      el.style.background = "#fafafe";
                      el.style.boxShadow = "0 1px 4px rgba(99,102,241,0.12)";
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLDivElement;
                      el.style.borderColor = "#e5e7eb";
                      el.style.background = "#fff";
                      el.style.boxShadow = "none";
                    }}
                  >
                    <span style={{ color: "#9ca3af", fontSize: 11 }}>⠿</span>
                    {item.label}
                  </div>
                ))}
              </div>
              {["general", "shipping", "billing"].includes(activeCategory) && (
                <button
                  onClick={() => palette.forEach((item) => addField(item))}
                  style={{
                    marginTop: 14,
                    width: "100%",
                    background: "#1f2937",
                    color: "#fff",
                    border: "none",
                    borderRadius: 7,
                    padding: "9px 0",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    transition: "background 0.12s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "#374151")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "#1f2937")
                  }
                >
                  + Add all {CATEGORY_INFO[activeCategory].label.toLowerCase()}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Column 3: Canvas ───────────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            background: "#f3f4f6",
            padding: "16px 14px",
            overflowY: "auto",
            minWidth: 0,
          }}
          onClick={() => setActiveSection(null)}
        >
          {/* Step tabs */}
          <div
            style={{
              display: "flex",
              gap: 3,
              marginBottom: 0,
              flexWrap: "wrap",
            }}
          >
            {config.steps.map((step, idx) => (
              <button
                key={step.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveStepIndex(idx);
                  setEditingSteps(false);
                }}
                style={{
                  padding: "6px 18px",
                  border: "none",
                  borderRadius: activeStepIndex === idx ? "7px 7px 0 0" : 7,
                  background: activeStepIndex === idx ? "#1f2937" : "#e5e7eb",
                  color: activeStepIndex === idx ? "#fff" : "#374151",
                  fontWeight: activeStepIndex === idx ? 600 : 400,
                  fontSize: 13,
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
              >
                {step.label}
              </button>
            ))}
          </div>

          {/* Canvas card */}
          <div
            style={{
              background: "#f3f4f6",
              borderRadius: "0 8px 8px 8px",
              padding: "14px 0",
              minHeight: 400,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOverCanvas(true);
            }}
            onDragLeave={() => {
              setIsDragOverCanvas(false);
              setSectionDragOver(null);
            }}
            onDrop={handleCanvasZoneDrop}
          >
            {stepFields.length === 0 ? (
              /* Empty state */
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 240,
                  border: `2px dashed ${isDragOverCanvas ? "#6366f1" : "#d1d5db"}`,
                  borderRadius: 10,
                  background: isDragOverCanvas ? "#eef2ff" : "#fff",
                  color: "#9ca3af",
                  fontSize: 14,
                  gap: 10,
                  transition: "all 0.15s",
                }}
              >
                <div style={{ fontSize: 32 }}>📋</div>
                <div style={{ fontWeight: 500 }}>Drop fields here</div>
                <div style={{ fontSize: 12 }}>
                  or click a field in the palette to add it
                </div>
              </div>
            ) : (
              <div>
                {/* Section blocks */}
                {sectionOrder.map((section) => (
                  <SectionBlock
                    key={section}
                    section={section}
                    sectionLabel={SECTION_LABELS[section] || section}
                    fields={sectionMap[section] || []}
                    isActive={activeSection === section}
                    onActivate={() => setActiveSection(section)}
                    onRemoveField={removeField}
                    onRemoveSection={removeSection}
                    onDuplicateSection={duplicateSection}
                    onSectionDragStart={handleSectionDragStart}
                    onSectionDragOver={handleSectionDragOver}
                    onSectionDrop={handleSectionDrop}
                    onFieldDragStart={handleFieldDragStart}
                    onFieldDragOver={handleFieldDragOver}
                    onFieldDrop={handleFieldDrop}
                    fieldDragOverId={fieldDragOverId}
                    isSectionDragOver={sectionDragOver === section}
                  />
                ))}

                {/* Fields without a section */}
                {noSection.length > 0 && (
                  <div
                    style={{
                      background: "#fff",
                      borderRadius: 10,
                      padding: "12px",
                      marginBottom: 12,
                      border: "2px solid transparent",
                    }}
                  >
                    <FieldRows
                      fields={noSection}
                      onRemove={removeField}
                      onDragStart={handleFieldDragStart}
                      onDragOver={handleFieldDragOver}
                      onDrop={handleFieldDrop}
                      dragOverId={fieldDragOverId}
                    />
                  </div>
                )}

                {/* Bottom drop target */}
                <div
                  style={{
                    marginTop: 6,
                    border: `2px dashed ${isDragOverCanvas ? "#6366f1" : "#d1d5db"}`,
                    borderRadius: 8,
                    padding: "14px 0",
                    textAlign: "center",
                    color: "#9ca3af",
                    fontSize: 12,
                    background: isDragOverCanvas ? "#eef2ff" : "transparent",
                    transition: "all 0.15s",
                  }}
                >
                  Drop here to add at end
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom hint ────────────────────────────────────────────────────── */}
      <div
        style={{
          marginTop: 10,
          fontSize: 12,
          color: "#9ca3af",
          textAlign: "center",
        }}
      >
        Fields are saved to <strong>FormFieldConfig</strong> per store ·
        Registration form reads this config dynamically
      </div>
    </s-page>
  );
}
export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
