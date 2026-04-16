import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  useFetcher,
  useLoaderData,
} from "react-router";

import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "app/shopify.server";
import { DEFAULT_CONFIG } from "app/utils/form-config.shared";

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

type MetafieldTarget =   "customer" | "company_location" | "company" | "customer_locations" | "orders" | "products" | "product_variants";
type MetafieldDefinitionMap = Record<FieldType, Record<MetafieldTarget, string[]>>;

export interface StoredStepGroup {
  step: FormStep;
  fields: StoredField[];
}

export type StoredConfig = StoredStepGroup[];

interface LoaderData {
  config: FormConfig;
  storeMissing: boolean;
  savedAt: string | null;
  shopName: string;
  metafieldDefinitions: MetafieldDefinitionMap;
}



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


// ═══════════════════════════════════════════════════════════════════════════════
// SERIALIZE / DESERIALIZE
// ═══════════════════════════════════════════════════════════════════════════════

export function serializeConfig(config: FormConfig): StoredConfig {
  return config.steps.map((step, stepIdx): StoredStepGroup => {
    const stepFields = config.fields
      .filter((f) => f.stepIndex === stepIdx)
      .sort((a, b) => a.order - b.order);
    const { map: sectionMap } = groupBySection(stepFields);

    const storedFields = stepFields
      .map(
        (f): StoredField => {
          const sectionFields = f.section ? sectionMap[f.section] || [] : [];
          const sectionLabel =
            f.section && sectionFields.length > 0
              ? getSectionDisplayLabel(sectionFields, f.section)
              : f.sectionLabel;
          const sectionHeadingSettings =
            f.section && sectionFields.length > 0
              ? getSectionHeadingSettings(sectionFields, f.section)
              : null;

          return {
          paletteKey: f.paletteKey,
          key: f.key,
          label: f.label,
          ...(f.description ? { description: f.description } : {}),
          ...(f.defaultValue ? { defaultValue: f.defaultValue } : {}),
          ...(f.validationMessage ? { validationMessage: f.validationMessage } : {}),
          ...(f.hideTypedCharacters ? { hideTypedCharacters: f.hideTypedCharacters } : {}),
          ...(f.headingTag ? { headingTag: f.headingTag } : {}),
          ...(f.headingAlignment ? { headingAlignment: f.headingAlignment } : {}),
          ...(typeof f.headingWidth === "number" ? { headingWidth: f.headingWidth } : {}),
          ...(typeof f.paragraphFontSize === "number" ? { paragraphFontSize: f.paragraphFontSize } : {}),
          ...(f.linkUrl ? { linkUrl: f.linkUrl } : {}),
          ...(typeof f.linkOpenInNewTab === "boolean" ? { linkOpenInNewTab: f.linkOpenInNewTab } : {}),
          ...(f.linkAlignment ? { linkAlignment: f.linkAlignment } : {}),
          ...(sectionLabel ? { sectionLabel } : {}),
          ...(sectionHeadingSettings?.label ? { sectionHeadingLabel: sectionHeadingSettings.label } : {}),
          ...(sectionHeadingSettings?.headingTag ? { sectionHeadingTag: sectionHeadingSettings.headingTag } : {}),
          ...(sectionHeadingSettings?.alignment ? { sectionHeadingAlignment: sectionHeadingSettings.alignment } : {}),
          ...(typeof sectionHeadingSettings?.width === "number" ? { sectionHeadingWidth: sectionHeadingSettings.width } : {}),
          ...(typeof sectionHeadingSettings?.hidden === "boolean" ? { sectionHeadingHidden: sectionHeadingSettings.hidden } : {}),
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
          ...(f.metafieldTarget ? { metafieldTarget: f.metafieldTarget } : {}),
          ...(f.metafieldDefinition ? { metafieldDefinition: f.metafieldDefinition } : {}),
          ...(f.phoneDefaultCountry ? { phoneDefaultCountry: f.phoneDefaultCountry } : {}),
        };
      },
      );
    return { step, fields: storedFields };
  });
}

export function deserializeConfig(stored: StoredConfig): FormConfig {
  const DISPLAY_TYPES: FieldType[] = ["heading", "paragraph", "link", "divider"];
  const isBuiltInShippingPhoneField = (field: StoredField) =>
    field.paletteKey === "shipPhone" || field.key === "shipPhone";

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
          id: `_${f.key}_${stepIdx}_${f.order}`,
          paletteKey: resolveStoredPaletteKey(f),
          category: inferCategory(f),
          isDisplay: DISPLAY_TYPES.includes(f.type),
          key: f.key,
          label: f.label,
          description: f.description,
          defaultValue: f.defaultValue,
          validationMessage: f.validationMessage,
          hideTypedCharacters: f.hideTypedCharacters,
          headingTag: f.headingTag,
          headingAlignment: f.headingAlignment,
          headingWidth: f.headingWidth,
          paragraphFontSize: f.paragraphFontSize,
          linkUrl: f.linkUrl,
          linkOpenInNewTab: f.linkOpenInNewTab,
          linkAlignment: f.linkAlignment,
          sectionLabel: f.sectionLabel,
          sectionHeadingLabel: f.sectionHeadingLabel,
          sectionHeadingTag: f.sectionHeadingTag,
          sectionHeadingAlignment: f.sectionHeadingAlignment,
          sectionHeadingWidth: f.sectionHeadingWidth,
          sectionHeadingHidden: f.sectionHeadingHidden,
          type: f.type,
          order: f.order,
          stepIndex: stepIdx,
          width: f.width ?? "full",
          required: isBuiltInShippingPhoneField(f) ? false : f.required,
          section: f.section,
          options: f.options,
          placeholder: f.placeholder,
          content: f.content,
          metafieldTarget: f.metafieldTarget,
          metafieldDefinition: f.metafieldDefinition,
          phoneDefaultCountry: f.phoneDefaultCountry,
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

const STORED_DEFAULT: StoredConfig = serializeConfig(DEFAULT_CONFIG);

// ============================================================
// 🗂️  FORM CONFIG CACHE SETUP
// ============================================================

declare global {
  var __formConfigCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
}

const formConfigCache: Map<string, { data: any; timestamp: number }> =
  globalThis.__formConfigCache ??
  (globalThis.__formConfigCache = new Map());

const FORM_CONFIG_TTL = 10 * 60 * 1000; // 10 min

// ============================================================
// 🧹  CACHE HELPER
// ============================================================

export const clearFormConfigCache = (shop: string) => {
  const key = `formconfig-${shop}`;
  formConfigCache.delete(key);
  console.log("🧹 Form config cache cleared for:", key);
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOADER
// ═══════════════════════════════════════════════════════════════════════════════

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
  });

  if (!store) {
    return Response.json({
      config: DEFAULT_CONFIG,
      storeMissing: true,
      savedAt: null,
      shopName: "",
      metafieldDefinitions: buildInitialMetafieldDefinitions(),
    });
  }

  // ── CACHE CHECK ──────────────────────────────────────────
  const cacheKey = `formconfig-${shop}`;
  const cached = formConfigCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < FORM_CONFIG_TTL) {
    console.log(`⚡ Form config cache HIT → ${cacheKey}`);
    console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
    return Response.json(cached.data);
  }

  console.log("🐢 Form config cache MISS → querying DB + Shopify");

  // ── SLOW PATH ─────────────────────────────────────────────
  // Run DB + Shopify in parallel — they don't depend on each other
  const [formFieldConfig, metafieldDefinitions] = await Promise.all([
    prisma.formFieldConfig.findUnique({ where: { shopId: store.id } }),
    fetchMetafieldDefinitions(admin),
  ]);

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
            g.fields.every((f) => f.key && f.label && f.type !== undefined),
        )
      ) {
        config = deserializeConfig(stored);
      }
    } catch {
      config = DEFAULT_CONFIG;
    }
  }

  const result = {
    config,
    storeMissing: false,
    shopName: normalizeShopName(shop.split(".")[0]),
    savedAt: formFieldConfig?.updatedAt?.toISOString() ?? null,
    metafieldDefinitions,
  };

  // ✅ Store in cache
  formConfigCache.set(cacheKey, { data: result, timestamp: Date.now() })
  console.log(`🚀 API Time: ${Date.now() - startTime}ms`);

  return Response.json(result);
};

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION
// ═══════════════════════════════════════════════════════════════════════════════

function mapToRegistrationData(formData: Record<string, any>) {
  const REGISTRATION_COLUMNS = ["companyName", "email", "firstName", "lastName", "contactTitle", "isPrivacyPolicy"];
  const mainData: Record<string, any> = {};
  const customFields: Record<string, any> = {};
  let shipping: Record<string, any> = {};
  let billing: Record<string, any> = {};

  for (const key in formData) {
    const value = formData[key];
    if (REGISTRATION_COLUMNS.includes(key)) { mainData[key] = value; continue; }
    if (key.startsWith("ship")) { shipping[key] = value; continue; }
    if (key.startsWith("bill")) { billing[key] = value; continue; }
    if (key === "email" || key.startsWith("email")) { mainData.email = value; continue; }
    customFields[key] = value;
  }

  return { ...mainData, shipping, billing, customFields };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;                          // ← add this line

  const store = await prisma.store.findUnique({ where: { shopDomain: shop } });

  if (!store) {
    return Response.json({ success: false, intent: "unknown", error: "Store not found" }, { status: 404 });
  }

  const body = (await request.json()) as { intent: string; config?: FormConfig };
  const { intent, config } = body;

  if (intent === "saveConfig") {
    if (!config || !Array.isArray(config.steps) || !Array.isArray(config.fields)) {
      return Response.json({ success: false, intent, error: "Invalid config payload" }, { status: 400 });
    }
    const toStore: StoredConfig = serializeConfig(config);
    const saved = await prisma.formFieldConfig.upsert({
      where: { shopId: store.id },
      update: { fields: toStore as any },
      create: { shopId: store.id, fields: toStore as any },
    });

    // ✅ Config changed — bust cache so next load reflects new fields
    clearFormConfigCache(shop);

    return Response.json({
      success: true, intent,
      savedAt: saved.updatedAt.toISOString(),
      stepCount: toStore.length,
      fieldCount: toStore.reduce((sum, g) => sum + g.fields.length, 0),
    });
  }

  if (intent === "resetConfig") {
    const saved = await prisma.formFieldConfig.upsert({
      where: { shopId: store.id },
      update: { fields: STORED_DEFAULT as any },
      create: { shopId: store.id, fields: STORED_DEFAULT as any },
    });

    // ✅ Config reset — bust cache
    clearFormConfigCache(shop);

    return Response.json({ success: true, intent, config: DEFAULT_CONFIG, savedAt: saved.updatedAt.toISOString() });
  }

  if (intent === "submitRegistration") {
    // No DB write to formFieldConfig — no bust needed
    const formData = (body as any).data;
    const mapped = mapToRegistrationData(formData);
    return Response.json({ success: true, intent, mappedData: mapped });
  }

  return Response.json({ success: false, intent, error: `Unknown intent: ${intent}` }, { status: 400 });
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
      if (!seen.has(f.section)) { seen.add(f.section); order.push(f.section); }
      (map[f.section] = map[f.section] || []).push(f);
    } else {
      none.push(f);
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

function getHeadingTitleStyle(tag: HeadingTag, alignment: HeadingAlignment): React.CSSProperties {
  const styles: Record<HeadingTag, React.CSSProperties> = {
    h1: { fontSize: 18, fontWeight: 700, lineHeight: 1.25 },
    h2: { fontSize: 17, fontWeight: 700, lineHeight: 1.25 },
    h3: { fontSize: 16, fontWeight: 700, lineHeight: 1.25 },
    h4: { fontSize: 15, fontWeight: 700, lineHeight: 1.25 },
  };

  return {
    ...styles[tag],
    margin: 0,
    color: "#111827",
    textAlign: alignment,
  };
}

function getHeadingBlockLayout(alignment: HeadingAlignment, width: number): React.CSSProperties {
  const clampedWidth = Math.min(100, Math.max(25, width));

  return {
    width: `${clampedWidth}%`,
    margin:
      alignment === "center"
        ? "0 auto"
        : alignment === "right"
          ? "0 0 0 auto"
          : "0",
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeParagraphHtml(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) return trimmed;
  return `<p>${escapeHtml(trimmed).replace(/\n/g, "<br />")}</p>`;
}

function getPlainTextFromRichText(value: string) {
  return value
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
    .replace(/\s+/g, " ")
    .trim();
}

function hasParagraphContent(value: string) {
  return getPlainTextFromRichText(value).length > 0;
}

function generateKeyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isValidLinkUrl(value: string) {
  if (!value) return false;
  if (value.startsWith("/") || value.startsWith("#")) return true;
  return /^(https?:\/\/|mailto:|tel:)/i.test(value);
}

function ToolbarIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        border: "none",
        background: "transparent",
        borderRadius: 6,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: "#525252",
        fontSize: 16,
      }}
    >
      {children}
    </button>
  );
}

function SidebarIcon({ kind }: { kind: "general" | "shipping" | "billing" | "custom" | "display" | "steps" }) {
  const common = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  if (kind === "general") {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
      </svg>
    );
  }

  if (kind === "shipping") {
    return (
      <svg {...common}>
        <path d="M2.5 8.5h10v7h-10z" />
        <path d="M12.5 11h4l2 2.5v2h-6z" />
        <circle cx="7" cy="18" r="1.7" />
        <circle cx="17" cy="18" r="1.7" />
      </svg>
    );
  }

  if (kind === "billing") {
    return (
      <svg {...common}>
        <rect x="3.5" y="6" width="13" height="11" rx="2" />
        <rect x="8.5" y="8.5" width="12" height="11" rx="2" />
      </svg>
    );
  }

  if (kind === "custom") {
    return (
      <svg {...common}>
        <rect x="4" y="5" width="16" height="15" rx="2.5" />
        <path d="M8 3.5v3" />
        <path d="M16 3.5v3" />
        <path d="M4 9.5h16" />
      </svg>
    );
  }

  if (kind === "display") {
    return (
      <svg {...common}>
        <path d="M4 18.5h6" />
        <path d="M4 13.5h7" />
        <path d="M13.5 6.5h6" />
        <path d="M16.5 4v12" />
        <path d="M4 6.5h6" />
        <path d="M6 4.5l-2 5h4z" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect x="4.5" y="6" width="15" height="12" rx="2" />
      <path d="M8 3.5v2.5" />
      <path d="M16 3.5v2.5" />
      <path d="M4.5 10h15" />
    </svg>
  );
}

const CUSTOM_FIELD_TYPE_LABELS: Partial<Record<FieldType, string>> = {
  text: "Single-line text",
  textarea: "Multi-line text",
  number: "Number",
  select: "Dropdown",
  radio: "Radio choices",
  checkbox: "Checkbox",
  "multi-check": "Multi-choice list",
  date: "Date",
  file: "File upload",
  email: "Email address",
  phone: "Phone number",
};

const METAFIELD_TARGET_OPTIONS: Array<{ value: MetafieldTarget; label: string }> = [
  { value: "company", label: "company" },
  { value: "customer", label: "customer" },
  { value: "company_location", label: "company_location" },
];

function getCustomFieldTypeLabel(type: FieldType) {
  return CUSTOM_FIELD_TYPE_LABELS[type] || "Custom field";
}

function getMetafieldSupportedTypeLabel(type: FieldType) {
  if (type === "phone" || type === "email" || type === "text") return "Single line text";
  return getCustomFieldTypeLabel(type);
}

const PHONE_COUNTRY_OPTIONS = [
  { value: "us", label: "United States (+1) 🇺🇸" },
  { value: "in", label: "India (+91) 🇮🇳" },
  { value: "gb", label: "United Kingdom (+44) 🇬🇧" },
  { value: "au", label: "Australia (+61) 🇦🇺" },
];

function buildInitialMetafieldDefinitions() {
  const definitions: MetafieldDefinitionMap = {} as MetafieldDefinitionMap;

  const fieldTypes: FieldType[] = [
    "text",
    "textarea",
    "number",
    "select",
    "radio",
    "checkbox",
    "multi-check",
    "date",
    "file",
    "email",
    "phone",
  ];

  fieldTypes.forEach((type) => {
    definitions[type] = {
      company: [],
      customer: [],
      company_location: [],
      customer_locations: [],
      orders: [],
      products: [],
      product_variants: [],
    };
  });

  return definitions;
}

function getFieldTypesForMetafieldType(typeName: string) {
  switch (typeName) {
    case "single_line_text_field":
      return ["text", "email", "phone", "select", "radio"] as FieldType[];
    case "multi_line_text_field":
      return ["textarea"] as FieldType[];
    case "number_integer":
    case "number_decimal":
      return ["number"] as FieldType[];
    case "boolean":
      return ["checkbox"] as FieldType[];
    case "date":
    case "date_time":
      return ["date"] as FieldType[];
    case "file_reference":
      return ["file"] as FieldType[];
    case "list.single_line_text_field":
      return ["multi-check"] as FieldType[];
    default:
      return [];
  }
}

async function fetchMetafieldDefinitions(admin: any) {
  const definitions = buildInitialMetafieldDefinitions();
  const targetsToFetch: Array<{ target: MetafieldTarget; ownerType: string }> = [
    { target: "company", ownerType: "COMPANY" },
    { target: "customer", ownerType: "CUSTOMER" },
    { target: "company_location", ownerType: "COMPANY_LOCATION" },
  ];

  const query = `
    query MetafieldDefinitions($ownerType: MetafieldOwnerType!) {
      metafieldDefinitions(first: 250, ownerType: $ownerType) {
        edges {
          node {
            namespace
            key
            type {
              name
            }
          }
        }
      }
    }
  `;

  await Promise.all(
    targetsToFetch.map(async ({ target, ownerType }) => {
      try {
        const response = await admin.graphql(query, {
          variables: { ownerType },
        });
        const data = await response.json();

        if (data.errors?.length) {
          console.error(`Failed to load ${target} metafield definitions:`, data.errors);
          return;
        }

        const nodes = data.data?.metafieldDefinitions?.edges?.map((edge: any) => edge.node) ?? [];

        for (const node of nodes) {
          const typeName = node?.type?.name;
          if (!typeName || !node?.namespace || !node?.key) continue;

          const fieldTypes = getFieldTypesForMetafieldType(typeName);
          if (fieldTypes.length === 0) continue;

          const definitionLabel = `${node.namespace}.${node.key}`;
          for (const fieldType of fieldTypes) {
            if (!definitions[fieldType][target].includes(definitionLabel)) {
              definitions[fieldType][target].push(definitionLabel);
            }
          }
        }

        for (const fieldType of Object.keys(definitions) as FieldType[]) {
          definitions[fieldType][target].sort((a, b) => a.localeCompare(b));
        }
      } catch (error) {
        console.error(`Error loading ${target} metafield definitions:`, error);
      }
    }),
  );

  return definitions;
}

function normalizeShopName(value: string) {
  return value.replace(/^https?:\/\//, "").replace(/^admin\.shopify\.com\/store\//, "").replace(/^store\//, "").split("/")[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS FIELD PREVIEW INPUT
// ═══════════════════════════════════════════════════════════════════════════════

const previewInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #aeb7c3",
  borderRadius: 9,
  fontSize: 14,
  color: "#9ca3af",
  background: "#fff",
  boxSizing: "border-box",
  minHeight: 32,
};

function FieldPreviewInput({ field }: { field: FieldDef }) {
  const previewValue = field.defaultValue || "";
  const maskedPreviewValue = field.hideTypedCharacters ? "•".repeat(Math.max(previewValue.length, 8)) : previewValue;

  switch (field.type) {
    case "divider":
      return <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "2px 0" }} />;
    case "heading":
      {
        const headingTag = field.headingTag || "h1";
        const headingAlignment = field.headingAlignment || "left";
        const headingWidth = field.headingWidth ?? 100;
        const headingStyle = getHeadingTitleStyle(headingTag, headingAlignment);
        const layoutStyle = getHeadingBlockLayout(headingAlignment, headingWidth);

        return (
          <div style={layoutStyle}>
            {headingTag === "h1" ? <h1 style={headingStyle}>{field.content || field.label}</h1> : null}
            {headingTag === "h2" ? <h2 style={headingStyle}>{field.content || field.label}</h2> : null}
            {headingTag === "h3" ? <h3 style={headingStyle}>{field.content || field.label}</h3> : null}
            {headingTag === "h4" ? <h4 style={headingStyle}>{field.content || field.label}</h4> : null}
          </div>
        );
      }
    case "paragraph":
      return (
        <div
          style={{ fontSize: field.paragraphFontSize ?? 14, color: "#6b7280", lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{
            __html: normalizeParagraphHtml(field.content || field.label),
          }}
        />
      );
    case "link":
      return (
        <div
          style={{
            textAlign: field.linkAlignment || "left",
          }}
        >
          <a
            href={field.linkUrl || "#"}
            target={field.linkOpenInNewTab ? "_blank" : undefined}
            rel={field.linkOpenInNewTab ? "noreferrer" : undefined}
            style={{ fontSize: 14, color: "#2c6ecb", pointerEvents: "none" }}
          >
            {field.content || field.label}
          </a>
        </div>
      );
    case "textarea":
      return <div style={{ ...previewInputStyle, minHeight: 50 }}>{maskedPreviewValue}</div>;
    case "checkbox":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
          <input type="checkbox" disabled style={{ width: 16, height: 16, cursor: "default" }} />
          <span style={{ fontSize: 15, color: "#374151" }}>{field.label}</span>
        </div>
      );
    case "country":
      return (
        <div style={{ ...previewInputStyle, display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 40 }}>
          <span>Select a country...</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      );
    case "state":
      return (
        <div style={{ ...previewInputStyle, display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 40 }}>
          <span>&nbsp;</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      );
    case "select":
      return (
        <div style={{ ...previewInputStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Select an option</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      );
    case "date":
      return <div style={{ ...previewInputStyle, color: previewValue ? "#6b7280" : "#c4c4c4" }}>{previewValue || "dd/mm/yyyy"}</div>;
    case "file":
      return <div style={{ ...previewInputStyle, fontSize: 14 }}>Choose file…</div>;
    case "radio":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "2px 0" }}>
          {["Option 1", "Option 2"].map((o) => (
            <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: "#6b7280" }}>
              <input type="radio" disabled style={{ width: 16, height: 16 }} /> {o}
            </label>
          ))}
        </div>
      );
    default:
      return <div style={{ ...previewInputStyle, color: previewValue ? "#6b7280" : "#9ca3af" }}>{maskedPreviewValue}</div>;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS FIELD ROW
// ✅ canDelete prop: hides trash icon for default fields
// ═══════════════════════════════════════════════════════════════════════════════

function CanvasField({
  field,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
  canDelete,
  isActive,
  onActivate,
}: {
  field: FieldDef;
  onRemove: () => void;
  onDragStart: (e: DragEvent, f: FieldDef) => void;
  onDragOver: (e: DragEvent, f: FieldDef) => void;
  onDrop: (e: DragEvent, f: FieldDef) => void;
  isDragOver: boolean;
  canDelete: boolean; // ✅ NEW
  isActive: boolean;
  onActivate: () => void;
}) {
  const isDisplay = ["heading", "paragraph", "divider", "link"].includes(field.type);
  const isCheck = field.type === "checkbox";
  const [isHovered, setIsHovered] = useState(false);
  const showDeleteIcon = isHovered || isActive;

  return (
    <div
      draggable
      role="button"
      tabIndex={0}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => { e.stopPropagation(); onActivate(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onActivate();
        }
      }}
      onDragStart={(e) => onDragStart(e, field)}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOver(e, field); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(e, field); }}
      style={{
        padding: "4px 0",
        borderRadius: 10,
        border: isDragOver ? "2px dashed #c5ccd5" : isActive ? "2px solid #d4dae1" : "2px solid transparent",
        background: isDragOver ? "#f8f9fb" : isActive ? "#f8f9fb" : "transparent",
        cursor: "grab",
        transition: "all 0.12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {/* Drag grip */}
        <div style={{ color: "#bfc6cf", fontSize: 14, marginTop: 10, flexShrink: 0, lineHeight: 1, cursor: "grab" }}>
          <svg width="10" height="10" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2" cy="2" r="1.5" /><circle cx="8" cy="2" r="1.5" />
            <circle cx="2" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" />
            <circle cx="2" cy="14" r="1.5" /><circle cx="8" cy="14" r="1.5" />
          </svg>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {!isDisplay && !isCheck && (
            <div style={{ fontSize: 13, fontWeight: 600, color: "#223046", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              {field.label}
              {field.required && <span style={{ color: "#dc2626", marginLeft: 2 }}>*</span>}
            </div>
          )}
          {!isDisplay && !isCheck && field.description ? (
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
              {field.description}
            </div>
          ) : null}
          <FieldPreviewInput field={field} />
        </div>

        {/* Delete button area shows on hover for all fields */}
    {showDeleteIcon && canDelete ? (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onRemove();
    }}
            style={{
              border: "none", background: "none", cursor: "pointer",
              color: "#c91d2e", padding: "8px 2px", flexShrink: 0,
              borderRadius: 4, opacity: showDeleteIcon ? 1 : 0, transition: "opacity 0.12s",
              display: "flex", alignItems: "center",
              pointerEvents: showDeleteIcon ? "auto" : "none",
            }}
            title="Remove field"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        ) : (
          /* Placeholder spacer so layout doesn't shift */
          <div style={{ width: 18, flexShrink: 0 }} />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD ROWS
// ═══════════════════════════════════════════════════════════════════════════════

function FieldRows({
  fields,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  dragOverId,
  activeFieldId,
  onActivateField,
}: {
  fields: FieldDef[];
  onRemove: (id: string) => void;
  onDragStart: (e: DragEvent, f: FieldDef) => void;
  onDragOver: (e: DragEvent, f: FieldDef) => void;
  onDrop: (e: DragEvent, f: FieldDef) => void;
  dragOverId: string | null;
  activeFieldId: string | null;
  onActivateField: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {fields.map((field, index) => {
        const nextField = fields[index + 1];

        if (field.width === "half") {
          if (index > 0 && fields[index - 1]?.width === "half") return null;

          const pairWithNext = nextField?.width === "half";

          return (
            <div key={field.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
              <CanvasField
                field={field}
                onRemove={() => onRemove(field.id)}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                isDragOver={dragOverId === field.id}
                canDelete={!field.required}
                isActive={activeFieldId === field.id}
                onActivate={() => onActivateField(field.id)}
              />
              {pairWithNext ? (
                <CanvasField
                  field={nextField}
                  onRemove={() => onRemove(nextField.id)}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  isDragOver={dragOverId === nextField.id}
                  canDelete={!nextField.required}
                  isActive={activeFieldId === nextField.id}
                  onActivate={() => onActivateField(nextField.id)}
                />
              ) : (
                <div />
              )}
            </div>
          );
        }

        return (
          <CanvasField
            key={field.id}
            field={field}
            onRemove={() => onRemove(field.id)}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            isDragOver={dragOverId === field.id}
            canDelete={!field.required}
            isActive={activeFieldId === field.id}
            onActivate={() => onActivateField(field.id)}
          />
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION BLOCK
// ✅ canDeleteSection prop: hides section delete button when it contains default fields
// ═══════════════════════════════════════════════════════════════════════════════

function SectionBlock({
  section,
  fields,
  sectionLabel,
  headingTag,
  headingAlignment,
  headingWidth,
  showHeading,
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
  canDeleteSection, // ✅ NEW
  activeFieldId,
  onActivateField,
}: {
  section: string;
  fields: FieldDef[];
  sectionLabel: string;
  headingTag: HeadingTag;
  headingAlignment: HeadingAlignment;
  headingWidth: number;
  showHeading: boolean;
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
  canDeleteSection: boolean; // ✅ NEW
  activeFieldId: string | null;
  onActivateField: (id: string) => void;
}) {
  const headerWidth = Math.min(100, Math.max(25, headingWidth));
  const headerMargin =
    headingAlignment === "center"
      ? "0 auto"
      : headingAlignment === "right"
        ? "0 0 0 auto"
        : "0";
  const [isHovered, setIsHovered] = useState(false);
  const showSectionActions = isHovered || isActive;

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onSectionDragOver(e, section); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onSectionDrop(e, section); }}
      style={{
        marginBottom: 20,
        borderRadius: 0,
        background: "transparent",
        border: "none",
        boxShadow: "none",
        overflow: "visible",
      }}
    >
      {showHeading ? (
        <div
          role="button"
          tabIndex={0}
          draggable
          onClick={(e) => { e.stopPropagation(); onActivate(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onActivate();
            }
          }}
          onDragStart={(e) => { e.stopPropagation(); onSectionDragStart(e, section); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: `${headerWidth}%`,
            margin: headerMargin,
            padding: "0 0 14px",
            background: "transparent",
            border: isSectionDragOver
              ? "2px dashed #c5ccd5"
              : isActive
                ? "2px solid #d4dae1"
                : "2px solid transparent",
            borderRadius: 0,
            cursor: "grab",
            userSelect: "none",
            boxSizing: "border-box",
            transition: "border-color 0.15s",
          }}
        >
          <div style={{ color: "#bfc6cf", flexShrink: 0 }}>
            <svg width="10" height="10" viewBox="0 0 10 16" fill="currentColor">
              <circle cx="2" cy="2" r="1.5" /><circle cx="8" cy="2" r="1.5" />
              <circle cx="2" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" />
              <circle cx="2" cy="14" r="1.5" /><circle cx="8" cy="14" r="1.5" />
            </svg>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {headingTag === "h1" ? <h1 style={getHeadingTitleStyle("h1", headingAlignment)}>{sectionLabel}</h1> : null}
            {headingTag === "h2" ? <h2 style={getHeadingTitleStyle("h2", headingAlignment)}>{sectionLabel}</h2> : null}
            {headingTag === "h3" ? <h3 style={getHeadingTitleStyle("h3", headingAlignment)}>{sectionLabel}</h3> : null}
            {headingTag === "h4" ? <h4 style={getHeadingTitleStyle("h4", headingAlignment)}>{sectionLabel}</h4> : null}
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); onDuplicateSection(section); }}
            title="Copy section heading"
            style={{
              border: "none", background: "none", cursor: "pointer",
              color: "#7c8897", padding: "4px 5px", borderRadius: 5,
              display: "flex", alignItems: "center", transition: "background 0.12s, opacity 0.12s",
              opacity: showSectionActions ? 1 : 0,
              pointerEvents: showSectionActions ? "auto" : "none",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>

          {canDeleteSection ? (
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveSection(section); }}
              title="Remove section heading"
              style={{
                border: "none", background: "none", cursor: "pointer",
                color: "#c91d2e", padding: "4px 5px", borderRadius: 5,
                display: "flex", alignItems: "center", opacity: showSectionActions ? 0.7 : 0,
                transition: "background 0.12s, opacity 0.12s",
                pointerEvents: showSectionActions ? "auto" : "none",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#fef2f2"; e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.opacity = "0.7"; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" /><path d="M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          ) : (
            <div style={{ width: 25, flexShrink: 0 }} />
          )}
        </div>
      ) : null}

      {/* Fields */}
      <div style={{ padding: 0, marginTop: showHeading ? 2 : 0 }}>
        <FieldRows
          fields={fields}
          onRemove={onRemoveField}
          onDragStart={onFieldDragStart}
          onDragOver={onFieldDragOver}
          onDrop={onFieldDrop}
          dragOverId={fieldDragOverId}
          activeFieldId={activeFieldId}
          onActivateField={onActivateField}
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
    shopName,
    metafieldDefinitions: initialMetafieldDefinitions,
  } = useLoaderData<LoaderData>();
  const customDataAdminUrl = useMemo(() => {
    const normalizedShopName = normalizeShopName(shopName);
    if (!normalizedShopName) return "";
    return new URL(`/store/${normalizedShopName}/settings/custom_data`, "https://admin.shopify.com").toString();
  }, [shopName]);

  

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
  const [activeCategory, setActiveCategory] = useState<FieldCategory>("general");
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [editingSteps, setEditingSteps] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const paragraphEditorRef = useRef<HTMLDivElement>(null);
  const [fieldEditorDraft, setFieldEditorDraft] = useState<{
    content: string;
    linkUrl: string;
    linkOpenInNewTab: boolean;
    label: string;
    description: string;
    defaultValue: string;
    validationMessage: string;
    hideTypedCharacters: boolean;
    required: boolean;
    headingTag: HeadingTag;
    alignment: HeadingAlignment;
    width: number;
    paragraphFontSize: number;
    metafieldTarget: MetafieldTarget;
    metafieldDefinition: string;
    phoneDefaultCountry: string;
  }>({
    content: "",
    linkUrl: "",
    linkOpenInNewTab: true,
    label: "",
    description: "",
    defaultValue: "",
    validationMessage: "Must not be blank",
    hideTypedCharacters: false,
    required: false,
    headingTag: "h1",
    alignment: "left",
    width: 100,
    paragraphFontSize: 14,
    metafieldTarget: "company",
    metafieldDefinition: "",
    phoneDefaultCountry: "us",
  });
  const createMetafieldAdminUrl = useMemo(() => {
    const normalizedShopName = normalizeShopName(shopName);
    if (!normalizedShopName) return "";
    return new URL(
      `/store/${normalizedShopName}/settings/custom_data/${fieldEditorDraft.metafieldTarget}/metafields/create`,
      "https://admin.shopify.com",
    ).toString();
  }, [fieldEditorDraft.metafieldTarget, shopName]);
  const [fieldEditorErrors, setFieldEditorErrors] = useState<{ content?: string; label?: string; linkUrl?: string }>({});
  const [sectionEditorDraft, setSectionEditorDraft] = useState<{
    content: string;
    label: string;
    headingTag: HeadingTag;
    alignment: HeadingAlignment;
    width: number;
  }>({
    content: "",
    label: "",
    headingTag: "h1",
    alignment: "left",
    width: 100,
  });
  const [sectionEditorError, setSectionEditorError] = useState<{ content?: string; label?: string }>({});
  const [fieldDragOverId, setFieldDragOverId] = useState<string | null>(null);
  const [sectionDragOver, setSectionDragOver] = useState<string | null>(null);
  const [isDragOverCanvas, setIsDragOverCanvas] = useState(false);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [metafieldDefinitions, setMetafieldDefinitions] = useState(initialMetafieldDefinitions);
  const [paragraphEditorHasContent, setParagraphEditorHasContent] = useState(false);

  const dragPayloadRef = useRef<
    | { kind: "palette"; item: (typeof PALETTE.general)[0] }
    | { kind: "field"; field: FieldDef }
    | { kind: "section"; section: string }
    | null
  >(null);

  

  const isSaving = fetcher.state !== "idle";
  const pendingSubmitRef = useRef(false);

  // ── usedPaletteKeys: which paletteKeys are already placed anywhere in the form ──
  const usedPaletteKeys = useMemo(
    () => new Set(config.fields.map((f) => f.paletteKey)),
    [config.fields],
  );

  // ── Check if all palette items in the active category are already used ──
  const allCategoryFieldsUsed = useMemo(() => {
    const palette = PALETTE[activeCategory];
    return palette.every((item) => usedPaletteKeys.has(item.paletteKey));
  }, [activeCategory, usedPaletteKeys]);

  const getConfigWithPendingEditorChanges = useCallback(() => {
    let nextConfig = config;

    if (activeFieldId) {
      const editingField = config.fields.find((field) => field.id === activeFieldId);
      if (editingField) {
        const nextLabel = fieldEditorDraft.label.trim() || editingField.label;
        const nextContent =
          editingField.type === "paragraph"
            ? normalizeParagraphHtml(fieldEditorDraft.content)
            : fieldEditorDraft.content.trim();
        const nextLinkUrl = fieldEditorDraft.linkUrl.trim();
        
        // Auto-generate key from label for custom fields
        const isCustomField = editingField.paletteKey.startsWith("c_") || editingField.category === "custom";
        const nextKey = isCustomField ? generateKeyFromLabel(nextLabel) : editingField.key;

        nextConfig = {
          ...nextConfig,
          fields: nextConfig.fields.map((field) =>
            field.id === editingField.id
              ? {
                  ...field,
                  label: nextLabel,
                  key: nextKey,
                  description: fieldEditorDraft.description.trim() || undefined,
                  defaultValue: fieldEditorDraft.defaultValue,
                  validationMessage: fieldEditorDraft.validationMessage.trim() || undefined,
                  hideTypedCharacters: fieldEditorDraft.hideTypedCharacters,
                  required: fieldEditorDraft.required,
                  width: fieldEditorDraft.width >= 60 ? "full" : "half",
                  metafieldTarget: fieldEditorDraft.metafieldTarget,
                  metafieldDefinition: fieldEditorDraft.metafieldDefinition || undefined,
                  phoneDefaultCountry: fieldEditorDraft.phoneDefaultCountry,
                  ...(editingField.type === "heading"
                    ? {
                        content: nextContent,
                        headingTag: fieldEditorDraft.headingTag,
                        headingAlignment: fieldEditorDraft.alignment,
                        headingWidth: fieldEditorDraft.width,
                      }
                    : editingField.type === "paragraph"
                      ? {
                          content: nextContent,
                          paragraphFontSize: fieldEditorDraft.paragraphFontSize,
                        }
                      : editingField.type === "link"
                        ? {
                            content: nextContent,
                            linkUrl: nextLinkUrl,
                            linkOpenInNewTab: fieldEditorDraft.linkOpenInNewTab,
                            linkAlignment: fieldEditorDraft.alignment,
                          }
                        : {}),
                }
              : field,
          ),
        };
      }
    }

    if (activeSection) {
      const nextContent = sectionEditorDraft.content.trim();
      const nextLabel = sectionEditorDraft.label.trim();

      nextConfig = {
        ...nextConfig,
        fields: nextConfig.fields.map((field) =>
          field.section === activeSection && field.stepIndex === activeStepIndex
            ? {
                ...field,
                sectionLabel: nextContent || field.sectionLabel,
                sectionHeadingLabel: nextLabel || field.sectionHeadingLabel,
                sectionHeadingTag: sectionEditorDraft.headingTag,
                sectionHeadingAlignment: sectionEditorDraft.alignment,
                sectionHeadingWidth: sectionEditorDraft.width,
              }
            : field,
        ),
      };
    }

    return nextConfig;
  }, [
    activeFieldId,
    activeSection,
    activeStepIndex,
    config,
    fieldEditorDraft,
    sectionEditorDraft,
  ]);

  const handleSaveAndSubmit = useCallback(() => {
    const nextConfig = getConfigWithPendingEditorChanges();
    setConfig(nextConfig);
    fetcher.submit(
      JSON.stringify({ intent: "saveConfig", config: nextConfig }),
      { method: "post", encType: "application/json" },
    );
    pendingSubmitRef.current = true;
  }, [fetcher, getConfigWithPendingEditorChanges]);

  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.success && fetcher.data.intent === "saveConfig") {
      setSavedAt(fetcher.data.savedAt ?? null);
      setHasUnsaved(false);
      shopify.toast.show?.("Form saved successfully");

      if (pendingSubmitRef.current) {
        pendingSubmitRef.current = false;
        const formData: Record<string, any> = {};
        config.fields.forEach((field) => { formData[field.key] = `${field.key}`; });
        fetcher.submit(
          JSON.stringify({ intent: "submitRegistration", data: formData }),
          { method: "post", encType: "application/json" },
        );
      }
    } else if (fetcher.data.success && fetcher.data.intent === "submitRegistration") {
      shopify.toast.show?.("Registration mapped successfully 🎉");
    } else if (!fetcher.data.success) {
      pendingSubmitRef.current = false;
      shopify.toast.show?.(`Error: ${fetcher.data.error ?? "Unknown error"}`, { isError: true });
    }
  }, [fetcher.data, config, shopify]);

  useEffect(() => {
  if (config.fields.length === 0) {
    const shippingFields = PALETTE.shipping.map((item, i) => ({
      id: uid(),
      paletteKey: item.paletteKey,
      category: "shipping",
      type: item.type,
      label: item.label,
      key: `${item.key}_${uid()}`,
      section: item.section,
      required: item.required,
      width: item.width ?? "full",
      stepIndex: 0,
      order: i,
    }));

    setConfig((prev) => ({
      ...prev,
      fields: [...prev.fields, ...shippingFields],
    }));
  }
}, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const stepFields = useMemo(
    () => config.fields.filter((f) => f.stepIndex === activeStepIndex).sort((a, b) => a.order - b.order),
    [config.fields, activeStepIndex],
  );
  const activeField = useMemo(
    () => config.fields.find((field) => field.id === activeFieldId) ?? null,
    [activeFieldId, config.fields],
  );
  const canvasStepFields = useMemo(
    () =>
      stepFields.map((field) =>
        activeField && field.id === activeField.id
          ? {
              ...field,
              label: fieldEditorDraft.label,
              key: (field.paletteKey.startsWith("c_") || field.category === "custom") 
                ? generateKeyFromLabel(fieldEditorDraft.label)
                : field.key,
              description: fieldEditorDraft.description,
              defaultValue: fieldEditorDraft.defaultValue,
              validationMessage: fieldEditorDraft.validationMessage,
              hideTypedCharacters: fieldEditorDraft.hideTypedCharacters,
              required: fieldEditorDraft.required,
              width: fieldEditorDraft.width >= 60 ? "full" : "half",
              metafieldTarget: fieldEditorDraft.metafieldTarget,
              metafieldDefinition: fieldEditorDraft.metafieldDefinition || undefined,
              phoneDefaultCountry: fieldEditorDraft.phoneDefaultCountry,
              ...(activeField.type === "heading"
                ? {
                    content: fieldEditorDraft.content,
                    headingTag: fieldEditorDraft.headingTag,
                    headingAlignment: fieldEditorDraft.alignment,
                    headingWidth: fieldEditorDraft.width,
                  }
                : activeField.type === "paragraph"
                  ? {
                      content: fieldEditorDraft.content,
                      paragraphFontSize: fieldEditorDraft.paragraphFontSize,
                    }
                  : activeField.type === "link"
                    ? {
                        content: fieldEditorDraft.content,
                        linkUrl: fieldEditorDraft.linkUrl,
                        linkOpenInNewTab: fieldEditorDraft.linkOpenInNewTab,
                        linkAlignment: fieldEditorDraft.alignment,
                      }
                : {}),
            }
          : field,
      ),
    [activeField, fieldEditorDraft, stepFields],
  );

  const { map: sectionMap, order: sectionOrder, none: noSection } = useMemo(
    () => groupBySection(canvasStepFields),
    [canvasStepFields],
  );

  useEffect(() => {
    if (!activeField) {
      setFieldEditorErrors({});
      setParagraphEditorHasContent(false);
      return;
    }

    setFieldEditorDraft({
      label: activeField.label,
      content:
        activeField.type === "paragraph"
          ? normalizeParagraphHtml(activeField.content ?? activeField.label)
          : activeField.content ?? activeField.label,
      linkUrl: activeField.linkUrl ?? "",
      linkOpenInNewTab: activeField.linkOpenInNewTab ?? true,
      description: activeField.description ?? "",
      defaultValue: activeField.defaultValue ?? "",
      validationMessage: activeField.validationMessage ?? (activeField.type === "phone" ? "Please provide a valid phone number" : "Must not be blank"),
      hideTypedCharacters: activeField.hideTypedCharacters ?? false,
      required: activeField.required ?? false,
      headingTag: activeField.headingTag || "h1",
      alignment:
        activeField.type === "link"
          ? activeField.linkAlignment || "left"
          : activeField.headingAlignment || "left",
      width: activeField.type === "heading" ? activeField.headingWidth ?? 100 : activeField.width === "half" ? 50 : 100,
      paragraphFontSize: activeField.paragraphFontSize ?? 14,
      metafieldTarget: activeField.metafieldTarget || "company",
      metafieldDefinition: activeField.metafieldDefinition || "",
      phoneDefaultCountry: activeField.phoneDefaultCountry || "us",
    });
    setFieldEditorErrors({});
  }, [activeField]);

  useEffect(() => {
    if (activeField?.type !== "paragraph" || !paragraphEditorRef.current) return;
    const html = normalizeParagraphHtml(fieldEditorDraft.content);
    if (paragraphEditorRef.current.innerHTML !== html) {
      paragraphEditorRef.current.innerHTML = html;
    }
    setParagraphEditorHasContent(hasParagraphContent(html));
  }, [activeField?.id, activeField?.type, fieldEditorDraft.content]);

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    setHasUnsaved(true);
  }, [config]);

  // ── Save & Reset ───────────────────────────────────────────────────────────
  const save = useCallback(() => {
    const nextConfig = getConfigWithPendingEditorChanges();
    setConfig(nextConfig);
    fetcher.submit(JSON.stringify({ intent: "saveConfig", config: nextConfig }), { method: "post", encType: "application/json" });
  }, [fetcher, getConfigWithPendingEditorChanges]);

  const resetToDefault = useCallback(() => {
    if (!window.confirm("Reset form to default? All customizations will be lost.")) return;
    fetcher.submit(JSON.stringify({ intent: "resetConfig" }), { method: "post", encType: "application/json" });
  }, [fetcher]);

  const handleParagraphInput = useCallback(() => {
    if (!paragraphEditorRef.current) return;
    const nextContent = paragraphEditorRef.current.innerHTML;
    setFieldEditorDraft((prev) => ({ ...prev, content: nextContent }));
    setParagraphEditorHasContent(hasParagraphContent(nextContent));
    setFieldEditorErrors((prev) => ({ ...prev, content: undefined }));
  }, []);

  const formatParagraph = useCallback((command: string, value?: string) => {
    paragraphEditorRef.current?.focus();
    document.execCommand(command, false, value);
    handleParagraphInput();
  }, [handleParagraphInput]);

  const insertParagraphLink = useCallback(() => {
    const rawUrl = window.prompt("Enter a link URL", "https://");
    if (!rawUrl) return;
    const value = rawUrl.trim();
    if (!value) return;
    const normalizedUrl = /^(https?:\/\/|mailto:|tel:)/i.test(value) ? value : `https://${value}`;
    formatParagraph("createLink", normalizedUrl);
  }, [formatParagraph]);

  // ── Field management ───────────────────────────────────────────────────────
  const addField = useCallback(
    (paletteItem: (typeof PALETTE.general)[0], afterFieldId?: string) => {
      // ✅ For non-custom palette items: block adding if already used
      const isCustomOrDisplay = ["custom", "display"].includes(
        Object.entries(PALETTE).find(([, items]) =>
          items.some((i) => i.paletteKey === paletteItem.paletteKey)
        )?.[0] ?? ""
      );

      if (!isCustomOrDisplay && usedPaletteKeys.has(paletteItem.paletteKey)) return;

      setConfig((prev) => {
        const stepF = prev.fields.filter((f) => f.stepIndex === activeStepIndex).sort((a, b) => a.order - b.order);
        const targetField = afterFieldId ? stepF.find((f) => f.id === afterFieldId) : null;
        const inheritedSection = targetField?.section ?? activeSection ?? paletteItem.section;
        const newField: FieldDef = {
          id: uid(),
          paletteKey: paletteItem.paletteKey,
          category: activeCategory,
          type: paletteItem.type,
          label: paletteItem.label,
          key: activeCategory === "custom"
  ? `${generateKeyFromLabel(paletteItem.label)}_${uid()}`
  : `${paletteItem.key}_${uid()}`,
          section: inheritedSection,
          required: paletteItem.required,
          validationMessage: paletteItem.type === "phone" ? "Please provide a valid phone number" : undefined,
          isDisplay: paletteItem.isDisplay,
          width: paletteItem.width ?? "full",
          stepIndex: activeStepIndex,
          order: 0,
          metafieldTarget: activeCategory === "custom" ? "company" : undefined,
          metafieldDefinition: undefined,
          phoneDefaultCountry: paletteItem.type === "phone" ? "us" : undefined,
        };

        if (afterFieldId) {
          const idx = stepF.findIndex((f) => f.id === afterFieldId);
          stepF.splice(Math.max(idx + 1, 0), 0, newField);
        } else if (activeSection) {
          const lastSectionIndex = stepF.reduce(
            (lastIndex, field, index) => (field.section === activeSection ? index : lastIndex),
            -1,
          );

          if (lastSectionIndex >= 0) {
            stepF.splice(lastSectionIndex + 1, 0, newField);
          } else {
            newField.order = stepF.length;
            return { ...prev, fields: [...prev.fields, newField] };
          }
        } else {
          if (paletteItem.isDisplay) {
            return {
              ...prev,
              fields: [
                ...prev.fields.filter((f) => f.stepIndex !== activeStepIndex),
                newField,
                ...stepF.map((f, i) => ({ ...f, order: i + 1 })),
              ],
            };
          }

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
    [activeCategory, activeSection, activeStepIndex, usedPaletteKeys],
  );

  const removeField = useCallback((id: string) => {
    setConfig((prev) => {
      const field = prev.fields.find((f) => f.id === id);
      const si = field?.stepIndex ?? 0;
      const rest = prev.fields.filter((f) => f.id !== id);
      const reord = rest
        .filter((f) => f.stepIndex === si)
        .sort((a, b) => a.order - b.order)
        .map((f, i) => ({ ...f, order: i }));
      return { ...prev, fields: [...rest.filter((f) => f.stepIndex !== si), ...reord] };
    });
    setActiveFieldId((prev) => (prev === id ? null : prev));
  }, []);

  const updateSectionSettings = useCallback((
    section: string,
    settings: {
      content: string;
      label: string;
      headingTag: HeadingTag;
      alignment: HeadingAlignment;
      width: number;
      hidden?: boolean;
    },
  ) => {
    setConfig((prev) => ({
      ...prev,
      fields: prev.fields.map((field) =>
        field.stepIndex === activeStepIndex && field.section === section
          ? {
              ...field,
              sectionLabel: settings.content,
              sectionHeadingLabel: settings.label,
              sectionHeadingTag: settings.headingTag,
              sectionHeadingAlignment: settings.alignment,
              sectionHeadingWidth: settings.width,
              sectionHeadingHidden: settings.hidden ?? false,
            }
          : field,
      ),
    }));
  }, [activeStepIndex]);

  const closeFieldEditor = useCallback(() => {
    setActiveFieldId(null);
    setFieldEditorErrors({});
  }, []);

  const saveFieldEditor = useCallback(() => {
    if (!activeField) return;

    const nextLabel = fieldEditorDraft.label.trim();
    const nextContent =
      activeField.type === "paragraph"
        ? normalizeParagraphHtml(fieldEditorDraft.content)
        : fieldEditorDraft.content.trim();
    const nextLinkUrl = fieldEditorDraft.linkUrl.trim();
    const nextErrors: { content?: string; label?: string; linkUrl?: string } = {};

    if (!nextLabel) nextErrors.label = "Label is required.";
    if (activeField.type === "heading" && !nextContent) {
      nextErrors.content = "Content is required.";
    }
    if (activeField.type === "paragraph" && !hasParagraphContent(nextContent)) {
      nextErrors.content = "Content is required.";
    }
    if (activeField.type === "link" && !nextContent) {
      nextErrors.content = "Content is required.";
    }
    if (activeField.type === "link" && !nextLinkUrl) {
      nextErrors.linkUrl = "Link URL is required.";
    } else if (activeField.type === "link" && !isValidLinkUrl(nextLinkUrl)) {
      nextErrors.linkUrl = "Use https:// for external links.";
    }

    if (nextErrors.label || nextErrors.content || nextErrors.linkUrl) {
      setFieldEditorErrors(nextErrors);
      return;
    }

    setConfig((prev) => ({
      ...prev,
      fields: prev.fields.map((field) =>
        field.id === activeField.id
          ? {
              ...field,
              label: nextLabel,
              key: (activeField.paletteKey.startsWith("c_") || activeField.category === "custom")
            ? generateKeyFromLabel(nextLabel)  // ← derive key from label
            : field.key,        
              description: fieldEditorDraft.description.trim() || undefined,
              defaultValue: fieldEditorDraft.defaultValue,
              validationMessage: fieldEditorDraft.validationMessage.trim() || undefined,
              hideTypedCharacters: fieldEditorDraft.hideTypedCharacters,
              required: fieldEditorDraft.required,
              width: fieldEditorDraft.width >= 60 ? "full" : "half",
              metafieldTarget: fieldEditorDraft.metafieldTarget,
              metafieldDefinition: fieldEditorDraft.metafieldDefinition || undefined,
              phoneDefaultCountry: fieldEditorDraft.phoneDefaultCountry,
              ...(activeField.type === "heading"
                ? {
                    content: nextContent,
                    headingTag: fieldEditorDraft.headingTag,
                    headingAlignment: fieldEditorDraft.alignment,
                    headingWidth: fieldEditorDraft.width,
                  }
                : activeField.type === "paragraph"
                  ? {
                      content: nextContent,
                      paragraphFontSize: fieldEditorDraft.paragraphFontSize,
                    }
                  : activeField.type === "link"
                    ? {
                        content: nextContent,
                        linkUrl: nextLinkUrl,
                        linkOpenInNewTab: fieldEditorDraft.linkOpenInNewTab,
                        linkAlignment: fieldEditorDraft.alignment,
                      }
                : {}),
            }
          : field,
      ),
    }));
    setFieldEditorErrors({});
    setActiveFieldId(null);
  }, [activeField, fieldEditorDraft]);

  const closeSectionEditor = useCallback(() => {
    setActiveSection(null);
    setSectionEditorError({});
  }, []);

  const saveSectionEditor = useCallback(() => {
    if (!activeSection) return;

    const nextContent = sectionEditorDraft.content.trim();
    const nextLabel = sectionEditorDraft.label.trim();
    const nextErrors: { content?: string; label?: string } = {};

    if (!nextContent) nextErrors.content = "Content is required.";
    if (!nextLabel) nextErrors.label = "Label is required.";

    if (nextErrors.content || nextErrors.label) {
      setSectionEditorError(nextErrors);
      return;
    }

    updateSectionSettings(activeSection, {
      content: nextContent,
      label: nextLabel,
      headingTag: sectionEditorDraft.headingTag,
      alignment: sectionEditorDraft.alignment,
      width: sectionEditorDraft.width,
    });
    setSectionEditorError({});
    setActiveSection(null);
  }, [activeSection, sectionEditorDraft, updateSectionSettings]);

  const removeSection = useCallback(
    (section: string) => {
      const sectionFields = config.fields.filter(
        (f) => f.section === section && f.stepIndex === activeStepIndex,
      );

      const currentSectionLabel = getSectionDisplayLabel(sectionFields, section);
      if (!window.confirm(`Remove "${currentSectionLabel}" heading only?`)) return;
      setConfig((prev) => {
        return {
          ...prev,
          fields: prev.fields.map((field) =>
            field.section === section && field.stepIndex === activeStepIndex
              ? {
                  ...field,
                  sectionHeadingHidden: true,
                }
              : field,
          ),
        };
      });
      setActiveSection((prev) => (prev === section ? null : prev));
    },
    [activeStepIndex, config.fields],
  );

  const duplicateSection = useCallback(
    (section: string) => {
      setConfig((prev) => {
        const stepF = prev.fields.filter((f) => f.stepIndex === activeStepIndex).sort((a, b) => a.order - b.order);
        const sectionFields = stepF.filter((f) => f.section === section);
        if (sectionFields.length === 0) return prev;

        const duplicatedSectionLabel = getSectionDisplayLabel(sectionFields, section);
        const duplicatedSettings = getSectionHeadingSettings(sectionFields, section);
        const insertOrder = Math.min(...sectionFields.map((f) => f.order));
        const duplicateLabel = duplicatedSectionLabel
          ? duplicatedSectionLabel
          : `${duplicatedSectionLabel}`;

        const shiftedStepFields = stepF.map((f) =>
          f.order >= insertOrder
            ? { ...f, order: f.order + 1 }
            : f,
        );

        const copiedHeading: FieldDef = {
          id: uid(),
          paletteKey: `d_heading_copy_${uid()}`,
          category: "display",
          type: "heading",
          label: duplicateLabel,
          content: duplicateLabel,
          key: `display_heading_copy_${uid()}`,
          isDisplay: true,
          width: "full",
          section,
          stepIndex: activeStepIndex,
          order: insertOrder,
          headingTag: duplicatedSettings.headingTag,
          headingAlignment: duplicatedSettings.alignment,
          headingWidth: duplicatedSettings.width,
        };

        return {
          ...prev,
          fields: [
            ...prev.fields.filter((f) => f.stepIndex !== activeStepIndex),
            ...shiftedStepFields,
            copiedHeading,
          ].sort((a, b) => {
            if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
            return a.order - b.order;
          }),
        };
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
          const stepF = prev.fields.filter((f) => f.stepIndex === activeStepIndex).sort((a, b) => a.order - b.order);
          const si = stepF.findIndex((f) => f.id === srcId);
          const ti = stepF.findIndex((f) => f.id === targetField.id);
          if (si === -1 || ti === -1) return prev;
          const [moved] = stepF.splice(si, 1);
          stepF.splice(ti, 0, {
            ...moved,
            section: targetField.section,
          });
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

  const handleSectionDragStart = useCallback((e: DragEvent, section: string) => {
    dragPayloadRef.current = { kind: "section", section };
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleSectionDragOver = useCallback((_e: DragEvent, section: string) => {
    if (dragPayloadRef.current?.kind === "section" && dragPayloadRef.current.section !== section) {
      setSectionDragOver(section);
    }
  }, []);

  const handleSectionDrop = useCallback(
    (_e: DragEvent, targetSection: string) => {
      const payload = dragPayloadRef.current;
      setSectionDragOver(null);
      if (!payload || payload.kind !== "section" || payload.section === targetSection) return;

      const srcSection = payload.section;
      setConfig((prev) => {
        const stepF = prev.fields.filter((f) => f.stepIndex === activeStepIndex).sort((a, b) => a.order - b.order);
        const seen = new Set<string>();
        const secOrder: string[] = [];
        for (const f of stepF) {
          const s = f.section || "__none__";
          if (!seen.has(s)) { seen.add(s); secOrder.push(s); }
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
          for (const f of bySection[sec] || []) reordered.push({ ...f, order: order++ });
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
      steps: [...prev.steps, { id: uid(), label: `Step ${prev.steps.length + 1}` }],
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
        .map((f) => ({ ...f, stepIndex: f.stepIndex > idx ? f.stepIndex - 1 : f.stepIndex })),
    }));
    if (activeStepIndex >= config.steps.length - 1) setActiveStepIndex(Math.max(0, activeStepIndex - 1));
  };

  const updateStepLabel = (idx: number, label: string) =>
    setConfig((prev) => ({
      ...prev,
      steps: prev.steps.map((s, i) => (i === idx ? { ...s, label } : s)),
    }));

  const palette = PALETTE[activeCategory];
  const selectedSectionFields =
    activeSection
      ? stepFields.filter((field) => field.section === activeSection)
      : [];
  const selectedSectionSettings = useMemo(
    () => (activeSection ? getSectionHeadingSettings(selectedSectionFields, activeSection) : null),
    [activeSection, selectedSectionFields],
  );
  const isCustomFieldEditor = activeField?.category === "custom";
  const isPhoneCustomField = activeField?.category === "custom" && activeField.type === "phone";
  const activeCustomFieldTypeLabel = activeField ? getCustomFieldTypeLabel(activeField.type) : "Custom field";
  const activeMetafieldSupportedTypeLabel = activeField ? getMetafieldSupportedTypeLabel(activeField.type) : "Single line text";
  const hasEditingSidebarOpen = Boolean(editingSteps || activeField || activeSection);
  const showFieldCategorySidebar = !hasEditingSidebarOpen;
  const sidebarPanelWidth = hasEditingSidebarOpen ? 366 : 214;
  const currentMetafieldDefinitions =
    activeField && isCustomFieldEditor
      ? metafieldDefinitions[activeField.type]?.[fieldEditorDraft.metafieldTarget] || []
      : [];

  const createMetafieldDefinition = useCallback(() => {
    if (!activeField || !isCustomFieldEditor) return;

    const nextDefinition = `${fieldEditorDraft.label.trim() || activeCustomFieldTypeLabel} definition`;
    setMetafieldDefinitions((prev) => {
      const current = prev[activeField.type]?.[fieldEditorDraft.metafieldTarget] || [];
      if (current.includes(nextDefinition)) return prev;

      return {
        ...prev,
        [activeField.type]: {
          ...prev[activeField.type],
          [fieldEditorDraft.metafieldTarget]: [...current, nextDefinition],
        },
      };
    });
    setFieldEditorDraft((prev) => ({ ...prev, metafieldDefinition: nextDefinition }));
  }, [activeCustomFieldTypeLabel, activeField, fieldEditorDraft.label, fieldEditorDraft.metafieldTarget, isCustomFieldEditor]);

  const viewAllMetafieldDefinitions = useCallback(() => {
    if (!activeField || !isCustomFieldEditor) return;

    if (currentMetafieldDefinitions.length === 0) {
      window.alert(`No ${activeCustomFieldTypeLabel.toLowerCase()} metafield definitions found for this target yet.`);
      return;
    }

    window.alert(currentMetafieldDefinitions.join("\n"));
  }, [activeCustomFieldTypeLabel, activeField, currentMetafieldDefinitions, isCustomFieldEditor]);

  useEffect(() => {
    if (!activeSection) {
      setSectionEditorError({});
      return;
    }

    setSectionEditorDraft({
      content: selectedSectionSettings?.content ?? "",
      label: selectedSectionSettings?.label ?? "",
      headingTag: selectedSectionSettings?.headingTag ?? "h1",
      alignment: selectedSectionSettings?.alignment ?? "left",
      width: selectedSectionSettings?.width ?? 100,
    });
    setSectionEditorError({});
  }, [
    activeSection,
    selectedSectionSettings?.content,
    selectedSectionSettings?.label,
    selectedSectionSettings?.headingTag,
    selectedSectionSettings?.alignment,
    selectedSectionSettings?.width,
  ]);

  const removeFieldIfAllowed = useCallback((id: string) => {
  const field = config.fields.find((f) => f.id === id);
  if (field?.required) return; // Block deletion of required fields
  removeField(id);
}, [config.fields, removeField]);

  // ═════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════════

  if (storeMissing) {
    return (
      <s-page heading="B2B/Wholesale registration form">
        <s-section>
          <s-banner tone="critical">
            <p>Store not found. Please reinstall the app.</p>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="B2B/Wholesale registration form">
      <div
        style={{
          display: "flex",
          border: "1px solid #dde2e8",
          borderRadius: 12,
          overflow: "hidden",
          minHeight: 720,
          background: "#fff",
          boxShadow: "0 10px 26px rgba(15, 23, 42, 0.05)",
        }}
      >
        {showFieldCategorySidebar ? (
          <div style={{ width: 128, borderRight: "1px solid #e5e7eb", background: "#fff", flexShrink: 0 }}>
            <div style={{ padding: "8px 0" }}>
              <div style={{ padding: "0 12px 10px", fontSize: 12, fontWeight: 700, color: "#111827" }}>
                Fields
              </div>
              {(["general", "shipping", "billing", "custom"] as FieldCategory[]).map((cat) => (
                <button
                  key={cat}
                  onClick={() => { setActiveCategory(cat); setEditingSteps(false); setActiveSection(null); setActiveFieldId(null); }}
                  style={{
                    width: "calc(100% - 16px)", textAlign: "left", padding: "8px 10px", border: "none",
                    margin: "0 8px 4px",
                    borderRadius: 10,
                    background: activeCategory === cat && !editingSteps ? "#d7d7d7" : "transparent",
                    fontWeight: activeCategory === cat && !editingSteps ? 600 : 500,
                    fontSize: 13, color: "#1f2937", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8,
                    transition: "background 0.12s, border-color 0.12s",
                  }}
                >
                  <span style={{ width: 15, height: 15, display: "inline-flex", justifyContent: "center", alignItems: "center", color: "#4b5563" }}>
                    <SidebarIcon kind={cat} />
                  </span>
                  {CATEGORY_INFO[cat].label}
                </button>
              ))}

              <div style={{ padding: "10px 12px 8px", fontSize: 12, fontWeight: 700, color: "#111827", marginTop: 4 }}>
                Other
              </div>
              <button
                onClick={() => { setActiveCategory("display"); setEditingSteps(false); setActiveSection(null); setActiveFieldId(null); }}
                style={{
                  width: "calc(100% - 16px)", textAlign: "left", padding: "8px 10px", border: "none",
                  margin: "0 8px 4px",
                  borderRadius: 10,
                  background: activeCategory === "display" && !editingSteps ? "#d7d7d7" : "transparent",
                  fontWeight: activeCategory === "display" && !editingSteps ? 600 : 500,
                  fontSize: 13, color: "#1f2937", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                <span style={{ width: 15, height: 15, display: "inline-flex", justifyContent: "center", alignItems: "center", color: "#4b5563" }}><SidebarIcon kind="display" /></span>Display
              </button>
              <button
                onClick={() => { setEditingSteps(true); setActiveSection(null); setActiveFieldId(null); }}
                style={{
                  width: "calc(100% - 16px)", textAlign: "left", padding: "8px 10px", border: "none",
                  margin: "0 8px 4px",
                  borderRadius: 10,
                  background: editingSteps ? "#d7d7d7" : "transparent",
                  fontWeight: editingSteps ? 600 : 500,
                  fontSize: 13, color: "#1f2937", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                <span style={{ width: 15, height: 15, display: "inline-flex", justifyContent: "center", alignItems: "center", color: "#4b5563" }}><SidebarIcon kind="steps" /></span>Form steps
              </button>
            </div>
          </div>
        ) : null}

        <div
          style={{
            width: sidebarPanelWidth, borderRight: "1px solid #e5e7eb", background: "#fff",
            padding: "14px 16px", flexShrink: 0, overflowY: "auto",
          }}
        >
          {editingSteps ? (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Edit form steps</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => setEditingSteps(false)}
                    style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", color: "#6b7280" }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setEditingSteps(false)}
                    style={{ border: "none", background: "#1f2937", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", color: "#fff", fontWeight: 600 }}
                  >
                    Done
                  </button>
                </div>
              </div>
              <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 14, lineHeight: 1.5 }}>
                Create a multi-step form by adding form steps. Assign fields to steps by dragging them to the desired form step tab.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {config.steps.map((step, idx) => (
                  <div key={step.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: "#9ca3af", fontSize: 12, cursor: "grab" }}>⠿</span>
                    <input
                      value={step.label}
                      onChange={(e) => updateStepLabel(idx, e.target.value)}
                      style={{ flex: 1, padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13 }}
                    />
                    {idx > 0 && (
                      <button
                        onClick={() => removeStep(idx)}
                        style={{ border: "none", background: "none", cursor: "pointer", color: "#dc2626", padding: "4px", borderRadius: 4 }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                  marginTop: 12, display: "flex", alignItems: "center", gap: 6,
                  background: "#1f2937", color: "#fff", border: "none", borderRadius: 7,
                  padding: "7px 12px", cursor: "pointer", fontSize: 13, fontWeight: 600,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add new form step
              </button>
              <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 12, lineHeight: 1.5 }}>
                A step with fields cannot be deleted until the fields have been removed from it.
              </p>
            </div>
          ) : activeField ? (
            <div>
              {!isCustomFieldEditor ? (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {activeField.type === "heading"
                      ? "Edit heading field"
                      : activeField.type === "paragraph"
                        ? "Edit paragraph field"
                        : activeField.type === "link"
                          ? "Edit link field"
                        : `Edit ${activeField.label.toLowerCase()} field`}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={closeFieldEditor}
                      style={{ border: "none", background: "transparent", borderRadius: 6, padding: "4px 6px", fontSize: 12, cursor: "pointer", color: "#2563eb", fontWeight: 600 }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveFieldEditor}
                      style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 8, padding: "5px 14px", fontSize: 12, cursor: "pointer", color: "#111827", fontWeight: 600 }}
                    >
                      Done 
                    </button>
                  </div>
                </div>
              ) : null}

              {activeField.type === "heading" ? (
                <div style={{ display: "grid", gap: 18 }}>
                  <div style={{ paddingBottom: 18, borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Customization</div>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Content
                    </div>
                    <input
                      value={fieldEditorDraft.content}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, content: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, content: undefined }));
                      }}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.content ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                    {fieldEditorErrors.content ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.content}
                      </div>
                    ) : null}

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginTop: 16, marginBottom: 6 }}>
                      Label
                    </div>
                    <input
                      value={fieldEditorDraft.label}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, label: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, label: undefined }));
                      }}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.label ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                    {fieldEditorErrors.label ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.label}
                      </div>
                    ) : null}
                    <p style={{ fontSize: 12, color: "#6b7280", marginTop: 10, lineHeight: 1.5 }}>
                      This label is used when setting up Rules but is not visible to customers on your storefront.
                    </p>
                  </div>

                  <div style={{ display: "grid", gap: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>Appearance</div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                        Column width
                      </div>
                      <input
                        type="range"
                        min={25}
                        max={100}
                        step={1}
                        value={fieldEditorDraft.width}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, width: Number(e.target.value) }))
                        }
                        style={{ width: "100%" }}
                      />
                    </div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                        Heading tag
                      </div>
                      <select
                        value={fieldEditorDraft.headingTag}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({
                            ...prev,
                            headingTag: e.target.value as HeadingTag,
                          }))
                        }
                        style={{
                          width: "100%",
                          padding: "9px 12px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          fontSize: 13,
                          boxSizing: "border-box",
                          background: "#fff",
                        }}
                      >
                        <option value="h1">H1</option>
                        <option value="h2">H2</option>
                        <option value="h3">H3</option>
                        <option value="h4">H4</option>
                      </select>
                    </div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
                        Alignment
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        {(["left", "center", "right"] as HeadingAlignment[]).map((alignment) => {
                          const selected = fieldEditorDraft.alignment === alignment;
                          return (
                            <button
                              key={alignment}
                              onClick={() =>
                                setFieldEditorDraft((prev) => ({ ...prev, alignment }))
                              }
                              style={{
                                border: "1px solid #d1d5db",
                                background: selected ? "#e5e7eb" : "#fff",
                                borderRadius: 8,
                                padding: "5px 12px",
                                fontSize: 12,
                                cursor: "pointer",
                                color: "#111827",
                                fontWeight: selected ? 600 : 500,
                                textTransform: "capitalize",
                              }}
                            >
                              {alignment}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ) : activeField.type === "paragraph" ? (
                <div style={{ display: "grid", gap: 18 }}>
                  <div style={{ paddingBottom: 18, borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Customization</div>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Label
                    </div>
                    <input
                      value={fieldEditorDraft.label}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, label: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, label: undefined }));
                      }}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.label ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                    {fieldEditorErrors.label ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.label}
                      </div>
                    ) : null}

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginTop: 16, marginBottom: 6 }}>
                      Content
                    </div>
                    <div
                      style={{
                        border: `1px solid ${fieldEditorErrors.content ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        overflow: "hidden",
                        background: "#fff",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          flexWrap: "wrap",
                          padding: "8px 10px",
                          background: "#f6f6f7",
                          borderBottom: "1px solid #e5e7eb",
                        }}
                      >
                        <ToolbarIconButton title="Bold" onClick={() => formatParagraph("bold")}>
                          <strong>B</strong>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Italic" onClick={() => formatParagraph("italic")}>
                          <em>I</em>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Underline" onClick={() => formatParagraph("underline")}>
                          <u>U</u>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Insert link" onClick={insertParagraphLink}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10 13a5 5 0 0 0 7.54.54l2.92-2.92a5 5 0 0 0-7.07-7.07L11.3 5.63" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-2.92 2.92a5 5 0 0 0 7.07 7.07l2.83-2.83" />
                          </svg>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Bullet list" onClick={() => formatParagraph("insertUnorderedList")}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" />
                            <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
                            <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
                            <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
                          </svg>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Numbered list" onClick={() => formatParagraph("insertOrderedList")}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10 6h10" /><path d="M10 12h10" /><path d="M10 18h10" />
                            <path d="M4 7V4l-1 1" /><path d="M4 10h2" />
                            <path d="M3 14c0-1 1-2 2-2s2 1 2 2c0 2-3 2-3 4h3" />
                            <path d="M3 18h3v3H3" />
                          </svg>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Align left" onClick={() => formatParagraph("justifyLeft")}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18" /><path d="M3 10h12" /><path d="M3 14h18" /><path d="M3 18h12" />
                          </svg>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Align center" onClick={() => formatParagraph("justifyCenter")}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18" /><path d="M6 10h12" /><path d="M3 14h18" /><path d="M6 18h12" />
                          </svg>
                        </ToolbarIconButton>
                        <ToolbarIconButton title="Align right" onClick={() => formatParagraph("justifyRight")}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18" /><path d="M9 10h12" /><path d="M3 14h18" /><path d="M9 18h12" />
                          </svg>
                        </ToolbarIconButton>
                      </div>

                      <div style={{ position: "relative" }}>
                        {!paragraphEditorHasContent ? (
                          <div
                            style={{
                              position: "absolute",
                              top: 14,
                              left: 12,
                              right: 12,
                              color: "#9ca3af",
                              fontSize: fieldEditorDraft.paragraphFontSize,
                              lineHeight: 1.6,
                              pointerEvents: "none",
                            }}
                          >
                            Add paragraph content
                          </div>
                        ) : null}
                        <div
                          ref={paragraphEditorRef}
                          contentEditable
                          suppressContentEditableWarning
                          onInput={handleParagraphInput}
                          onFocus={(e) => {
                            e.currentTarget.style.outline = "none";
                          }}
                          style={{
                            minHeight: 120,
                            padding: "12px",
                            fontSize: fieldEditorDraft.paragraphFontSize,
                            lineHeight: 1.6,
                            color: "#111827",
                            wordBreak: "break-word",
                          }}
                        />
                      </div>
                    </div>
                    {fieldEditorErrors.content ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.content}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: "grid", gap: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>Appearance</div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                        Column width
                      </div>
                      <input
                        type="range"
                        min={25}
                        max={100}
                        step={1}
                        value={fieldEditorDraft.width}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, width: Number(e.target.value) }))
                        }
                        style={{ width: "100%" }}
                      />
                    </div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                        Font size
                      </div>
                      <input
                        type="range"
                        min={12}
                        max={24}
                        step={1}
                        value={fieldEditorDraft.paragraphFontSize}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, paragraphFontSize: Number(e.target.value) }))
                        }
                        style={{ width: "100%" }}
                      />
                    </div>
                  </div>
                </div>
              ) : activeField.type === "link" ? (
                <div style={{ display: "grid", gap: 18 }}>
                  <div style={{ paddingBottom: 18, borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Customization</div>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Label
                    </div>
                    <input
                      value={fieldEditorDraft.label}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, label: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, label: undefined }));
                      }}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.label ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                    {fieldEditorErrors.label ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.label}
                      </div>
                    ) : null}
                    <p style={{ fontSize: 12, color: "#6b7280", marginTop: 10, lineHeight: 1.5 }}>
                      This label is used when setting up Rules but is not visible to customers on your storefront.
                    </p>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginTop: 16, marginBottom: 6 }}>
                      Content
                    </div>
                    <input
                      value={fieldEditorDraft.content}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, content: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, content: undefined }));
                      }}
                      placeholder="Link text"
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.content ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                    {fieldEditorErrors.content ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.content}
                      </div>
                    ) : null}

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginTop: 16, marginBottom: 6 }}>
                      Link url
                    </div>
                    <input
                      value={fieldEditorDraft.linkUrl}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, linkUrl: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, linkUrl: undefined }));
                      }}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.linkUrl ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                    {fieldEditorErrors.linkUrl ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.linkUrl}
                      </div>
                    ) : null}
                    <p style={{ fontSize: 12, color: "#6b7280", marginTop: 10, lineHeight: 1.5 }}>
                      https:// is required for external links
                    </p>

                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#111827", cursor: "pointer", marginTop: 16 }}>
                      <input
                        type="checkbox"
                        checked={fieldEditorDraft.linkOpenInNewTab}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, linkOpenInNewTab: e.target.checked }))
                        }
                      />
                      Open in new tab
                    </label>
                  </div>

                  <div style={{ display: "grid", gap: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>Appearance</div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                        Column width
                      </div>
                      <input
                        type="range"
                        min={25}
                        max={100}
                        step={1}
                        value={fieldEditorDraft.width}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, width: Number(e.target.value) }))
                        }
                        style={{ width: "100%" }}
                      />
                    </div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
                        Alignment
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        {(["left", "center", "right"] as HeadingAlignment[]).map((alignment) => {
                          const selected = fieldEditorDraft.alignment === alignment;
                          return (
                            <button
                              key={alignment}
                              onClick={() =>
                                setFieldEditorDraft((prev) => ({ ...prev, alignment }))
                              }
                              style={{
                                border: "1px solid #d1d5db",
                                background: selected ? "#e5e7eb" : "#fff",
                                borderRadius: 8,
                                padding: "5px 12px",
                                fontSize: 12,
                                cursor: "pointer",
                                color: "#111827",
                                fontWeight: selected ? 600 : 500,
                                textTransform: "capitalize",
                              }}
                            >
                              {alignment}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ) : isCustomFieldEditor ? (
                <div style={{ display: "grid", gap: 0, margin: "0 -20px -20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 16px 14px", borderBottom: "1px solid #e5e7eb" }}>
                    <span style={{ fontWeight: 700, fontSize: 18, color: "#111827" }}>{`Add ${activeCustomFieldTypeLabel.toLowerCase()} field`}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={closeFieldEditor}
                        style={{ border: "none", background: "transparent", borderRadius: 6, padding: "4px 6px", fontSize: 12, cursor: "pointer", color: "#2563eb", fontWeight: 600 }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveFieldEditor}
                        style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 8, padding: "5px 14px", fontSize: 12, cursor: "pointer", color: "#111827", fontWeight: 600 }}
                      >
                        Done
                      </button>
                    </div>
                  </div>

                  <div style={{ padding: "16px", borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Metafield</div>
                    <div style={{ background: "#f9fafb", border: "1px solid #f3f4f6", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
                      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>Supported type</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#111827" }}>
                        <span style={{ fontSize: 22, lineHeight: 1 }}>A</span>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{activeMetafieldSupportedTypeLabel}</span>
                      </div>
                    </div>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Target
                    </div>
                    <select
                      value={fieldEditorDraft.metafieldTarget}
                      onChange={(e) =>
                        setFieldEditorDraft((prev) => ({
                          ...prev,
                          metafieldTarget: e.target.value as MetafieldTarget,
                          metafieldDefinition: "",
                        }))
                      }
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                        background: "#fff",
                        marginBottom: 16,
                      }}
                    >
                      {METAFIELD_TARGET_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af" }}>Definition</div>
                      <button
                        type="button"
                        onClick={viewAllMetafieldDefinitions}
                        style={{ border: "none", background: "transparent", color: "#2563eb", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}
                      >
                        View all
                      </button>
                    </div>
                    <select
                      value={fieldEditorDraft.metafieldDefinition}
                      disabled={currentMetafieldDefinitions.length === 0}
                      onChange={(e) =>
                        setFieldEditorDraft((prev) => ({ ...prev, metafieldDefinition: e.target.value }))
                      }
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                        background: currentMetafieldDefinitions.length === 0 ? "#f3f4f6" : "#fff",
                        color: currentMetafieldDefinitions.length === 0 ? "#9ca3af" : "#111827",
                      }}
                    >
                      <option value="">{currentMetafieldDefinitions.length === 0 ? "Select a metafield definition..." : "Select a definition..."}</option>
                      {currentMetafieldDefinitions.map((definition) => (
                        <option key={definition} value={definition}>{definition}</option>
                      ))}
                    </select>
                    <p style={{ fontSize: 12, color: "#6b7280", margin: "12px 0 14px" }}>
                      {currentMetafieldDefinitions.length === 0
                        ? `No ${activeMetafieldSupportedTypeLabel.toLowerCase()} metafield definitions found.`
                        : `${currentMetafieldDefinitions.length} definition${currentMetafieldDefinitions.length > 1 ? "s" : ""} available for this target.`}
                    </p>
                    <button
                      onClick={() => {
                        if (!createMetafieldAdminUrl) return;
                        window.open(createMetafieldAdminUrl, "_top");
                      }}
                      style={{
                        width: "100%",
                        background: "#fff",
                        color: "#111827",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        padding: "8px 12px",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 500,
                      }}
                    >
                      Create a metafield definition
                    </button>
                  </div>

                  <div style={{ padding: "16px", borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Customization</div>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Label
                    </div>
                    <input
                      value={fieldEditorDraft.label}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, label: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, label: undefined }));
                      }}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.label ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                        marginBottom: 16,
                      }}
                    />
                    {fieldEditorErrors.label ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: -10, marginBottom: 10 }}>
                        {fieldEditorErrors.label}
                      </div>
                    ) : null}

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Description
                    </div>
                    <input
                      value={fieldEditorDraft.description}
                      onChange={(e) =>
                        setFieldEditorDraft((prev) => ({ ...prev, description: e.target.value }))
                      }
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                        marginBottom: 16,
                      }}
                    />

                    {isPhoneCustomField ? (
                      <>
                        <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                          Default country calling code
                        </div>
                        <select
                          value={fieldEditorDraft.phoneDefaultCountry}
                          onChange={(e) =>
                            setFieldEditorDraft((prev) => ({ ...prev, phoneDefaultCountry: e.target.value }))
                          }
                          style={{
                            width: "100%",
                            padding: "9px 12px",
                            border: "1px solid #d1d5db",
                            borderRadius: 8,
                            fontSize: 13,
                            boxSizing: "border-box",
                            background: "#fff",
                          }}
                        >
                          {PHONE_COUNTRY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <>
                        <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                          Default value
                        </div>
                        <input
                          value={fieldEditorDraft.defaultValue}
                          onChange={(e) =>
                            setFieldEditorDraft((prev) => ({ ...prev, defaultValue: e.target.value }))
                          }
                          style={{
                            width: "100%",
                            padding: "9px 12px",
                            border: "1px solid #d1d5db",
                            borderRadius: 8,
                            fontSize: 13,
                            boxSizing: "border-box",
                          }}
                        />
                      </>
                    )}
                  </div>

                  <div style={{ padding: "16px", borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Appearance</div>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                      Column width
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={100}
                      step={50}
                      value={fieldEditorDraft.width >= 60 ? 100 : 50}
                      onChange={(e) =>
                        setFieldEditorDraft((prev) => ({ ...prev, width: Number(e.target.value) }))
                      }
                      style={{ width: "100%", marginBottom: 14 }}
                    />

                    {!isPhoneCustomField ? (
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#111827", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={fieldEditorDraft.hideTypedCharacters}
                          onChange={(e) =>
                            setFieldEditorDraft((prev) => ({ ...prev, hideTypedCharacters: e.target.checked }))
                          }
                        />
                        Hide typed characters
                      </label>
                    ) : null}
                  </div>

                  <div style={{ padding: "16px" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Validation</div>

                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#111827", cursor: "pointer", marginBottom: 16 }}>
                      <input
                        type="checkbox"
                        checked={fieldEditorDraft.required}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, required: e.target.checked }))
                        }
                      />
                      Required
                    </label>

                    {isPhoneCustomField ? (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ width: "100%", padding: "9px 12px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, boxSizing: "border-box", marginBottom: 8, background: "#f9fafb", color: "#9ca3af" }}>
                          Must be valid
                        </div>
                        <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                          Error message
                        </div>
                        <input
                          value={fieldEditorDraft.validationMessage}
                          onChange={(e) =>
                            setFieldEditorDraft((prev) => ({ ...prev, validationMessage: e.target.value }))
                          }
                          placeholder="Please provide a valid phone number"
                          style={{
                            width: "100%",
                            padding: "9px 12px",
                            border: "1px solid #d1d5db",
                            borderRadius: 8,
                            fontSize: 13,
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                          Error message
                        </div>
                        <input
                          value={fieldEditorDraft.validationMessage}
                          onChange={(e) =>
                            setFieldEditorDraft((prev) => ({ ...prev, validationMessage: e.target.value }))
                          }
                          style={{
                            width: "100%",
                            padding: "9px 12px",
                            border: "1px solid #d1d5db",
                            borderRadius: 8,
                            fontSize: 13,
                            boxSizing: "border-box",
                            marginBottom: 16,
                          }}
                        />
                      </>
                    )}

                    <button
                      onClick={() =>
                        setFieldEditorDraft((prev) => ({
                          ...prev,
                          required: true,
                          validationMessage: prev.validationMessage || (isPhoneCustomField ? "Please provide a valid phone number" : "Must not be blank"),
                        }))
                      }
                      style={{
                        width: "100%",
                        background: "#1f2937",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        padding: "8px 12px",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      Add validation rule
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 20 }}>
                  <div style={{ paddingBottom: 20, borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Customization</div>

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Label
                    </div>
                    <input
                      value={fieldEditorDraft.label}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFieldEditorDraft((prev) => ({ ...prev, label: value }));
                        setFieldEditorErrors((prev) => ({ ...prev, label: undefined }));
                      }}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: `1px solid ${fieldEditorErrors.label ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                    {fieldEditorErrors.label ? (
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                        {fieldEditorErrors.label}
                      </div>
                    ) : null}

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginTop: 16, marginBottom: 6 }}>
                      Description
                    </div>
                    <input
                      value={fieldEditorDraft.description}
                      onChange={(e) =>
                        setFieldEditorDraft((prev) => ({ ...prev, description: e.target.value }))
                      }
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />

                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginTop: 16, marginBottom: 6 }}>
                      Default value
                    </div>
                    <input
                      value={fieldEditorDraft.defaultValue}
                      onChange={(e) =>
                        setFieldEditorDraft((prev) => ({ ...prev, defaultValue: e.target.value }))
                      }
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                  </div>

                  <div style={{ display: "grid", gap: 16, paddingBottom: 20, borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>Appearance</div>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                        Column width
                      </div>
                      <input
                        type="range"
                        min={50}
                        max={100}
                        step={50}
                        value={fieldEditorDraft.width >= 60 ? 100 : 50}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, width: Number(e.target.value) }))
                        }
                        style={{ width: "100%" }}
                      />
                    </div>

                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#111827", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={fieldEditorDraft.hideTypedCharacters}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, hideTypedCharacters: e.target.checked }))
                        }
                      />
                      Hide typed characters
                    </label>
                  </div>

                  <div style={{ display: "grid", gap: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>Validation</div>

                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#111827", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={fieldEditorDraft.required}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, required: e.target.checked }))
                        }
                      />
                      Required
                    </label>

                    <div>
                      <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                        Error message
                      </div>
                      <input
                        value={fieldEditorDraft.validationMessage}
                        onChange={(e) =>
                          setFieldEditorDraft((prev) => ({ ...prev, validationMessage: e.target.value }))
                        }
                        style={{
                          width: "100%",
                          padding: "9px 12px",
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          fontSize: 13,
                          boxSizing: "border-box",
                        }}
                      />
                    </div>

                    <button
                      onClick={() =>
                        setFieldEditorDraft((prev) => ({
                          ...prev,
                          required: true,
                          validationMessage: prev.validationMessage || "Must not be blank",
                        }))
                      }
                      style={{
                        width: "100%",
                        background: "#1f2937",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        padding: "8px 12px",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      Add validation rule
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : activeSection ? (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Edit section heading</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={closeSectionEditor}
                    style={{ border: "none", background: "transparent", borderRadius: 6, padding: "4px 6px", fontSize: 12, cursor: "pointer", color: "#2563eb", fontWeight: 600 }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveSectionEditor}
                    style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 8, padding: "5px 14px", fontSize: 12, cursor: "pointer", color: "#111827", fontWeight: 600 }}
                  >
                    Done
                  </button>
                </div>
              </div>
              <div style={{ display: "grid", gap: 20 }}>
                <div style={{ paddingBottom: 20, borderBottom: "1px solid #e5e7eb" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 14 }}>Customization</div>

                  <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                    Content
                  </div>
                  <input
                    value={sectionEditorDraft.content}
                    onChange={(e) => {
                      const value = e.target.value;
                      setSectionEditorDraft((prev) => ({ ...prev, content: value }));
                      setSectionEditorError((prev) => ({ ...prev, content: undefined }));
                    }}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      border: `1px solid ${sectionEditorError.content ? "#dc2626" : "#d1d5db"}`,
                      borderRadius: 8,
                      fontSize: 13,
                      boxSizing: "border-box",
                    }}
                  />
                  {sectionEditorError.content ? (
                    <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                      {sectionEditorError.content}
                    </div>
                  ) : null}

                  <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginTop: 16, marginBottom: 6 }}>
                    Label
                  </div>
                  <input
                    value={sectionEditorDraft.label}
                    onChange={(e) => {
                      const value = e.target.value;
                      setSectionEditorDraft((prev) => ({ ...prev, label: value }));
                      setSectionEditorError((prev) => ({ ...prev, label: undefined }));
                    }}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      border: `1px solid ${sectionEditorError.label ? "#dc2626" : "#d1d5db"}`,
                      borderRadius: 8,
                      fontSize: 13,
                      boxSizing: "border-box",
                    }}
                  />
                  {sectionEditorError.label ? (
                    <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>
                      {sectionEditorError.label}
                    </div>
                  ) : null}
                  <p style={{ fontSize: 12, color: "#6b7280", marginTop: 10, lineHeight: 1.5 }}>
                    This label is used when setting up Rules but is not visible to customers on your storefront.
                  </p>
                </div>

                <div style={{ display: "grid", gap: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>Appearance</div>

                  <div>
                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                      Column width
                    </div>
                    <input
                      type="range"
                      min={25}
                      max={100}
                      step={1}
                      value={sectionEditorDraft.width}
                      onChange={(e) =>
                        setSectionEditorDraft((prev) => ({ ...prev, width: Number(e.target.value) }))
                      }
                      style={{ width: "100%" }}
                    />
                  </div>

                  <div>
                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                      Heading tag
                    </div>
                    <select
                      value={sectionEditorDraft.headingTag}
                      onChange={(e) =>
                        setSectionEditorDraft((prev) => ({
                          ...prev,
                          headingTag: e.target.value as HeadingTag,
                        }))
                      }
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        boxSizing: "border-box",
                        background: "#fff",
                      }}
                    >
                      <option value="h1">H1</option>
                      <option value="h2">H2</option>
                      <option value="h3">H3</option>
                      <option value="h4">H4</option>
                    </select>
                  </div>

                  <div>
                    <div style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
                      Alignment
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["left", "center", "right"] as HeadingAlignment[]).map((alignment) => {
                        const selected = sectionEditorDraft.alignment === alignment;
                        return (
                          <button
                            key={alignment}
                            onClick={() =>
                              setSectionEditorDraft((prev) => ({ ...prev, alignment }))
                            }
                            style={{
                              border: "1px solid #d1d5db",
                              background: selected ? "#e5e7eb" : "#fff",
                              borderRadius: 8,
                              padding: "5px 12px",
                              fontSize: 12,
                              cursor: "pointer",
                              color: "#111827",
                              fontWeight: selected ? 600 : 500,
                              textTransform: "capitalize",
                            }}
                          >
                            {alignment}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 15, fontWeight: 700, color: "#223046", marginBottom: 22, lineHeight: 1.55 }}>
                {CATEGORY_INFO[activeCategory].description}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {palette.map((item) => {
                  // ✅ For general/shipping/billing: disable if already used anywhere
                  const isCustomOrDisplay = activeCategory === "custom" || activeCategory === "display";
                  const alreadyUsed = !isCustomOrDisplay && usedPaletteKeys.has(item.paletteKey);

                  return (
                    <div
                      key={item.paletteKey}
                      draggable={!alreadyUsed}
                      onDragStart={!alreadyUsed ? (e) => handlePaletteDragStart(e as any, item) : undefined}
                      onClick={!alreadyUsed ? () => addField(item) : undefined}
                      title={alreadyUsed ? "This field is already in the form" : undefined}
                      style={{
                        padding: "8px 13px",
                        background: alreadyUsed ? "#f9fafb" : "#fff",
                        border: `1px solid ${alreadyUsed ? "#d8dde4" : "#cfd6de"}`,
                        borderRadius: 9,
                        cursor: alreadyUsed ? "not-allowed" : "grab",
                        fontSize: 13,
                        fontWeight: 500,
                        color: alreadyUsed ? "#9ca3af" : "#223046",
                        opacity: alreadyUsed ? 0.6 : 1,
                        userSelect: "none",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        pointerEvents: alreadyUsed ? "none" : "auto",
                        transition: "border-color 0.12s, box-shadow 0.12s, background 0.12s",
                      }}
                      onMouseEnter={!alreadyUsed ? (e) => {
                        const el = e.currentTarget as HTMLDivElement;
                        el.style.borderColor = "#bfc6cf";
                        el.style.background = "#fbfbfc";
                        el.style.boxShadow = "0 2px 8px rgba(15, 23, 42, 0.06)";
                      } : undefined}
                      onMouseLeave={!alreadyUsed ? (e) => {
                        const el = e.currentTarget as HTMLDivElement;
                        el.style.borderColor = "#cfd6de";
                        el.style.background = "#fff";
                        el.style.boxShadow = "none";
                      } : undefined}
                    >
                      <span style={{ color: alreadyUsed ? "#d1d5db" : "#bcc3cd", fontSize: 11 }}>⠿</span>
                      <span style={{ flex: 1 }}>{item.label}</span>
                    </div>
                  );
                })}
              </div>
              {["general", "shipping", "billing"].includes(activeCategory) && (
                <button
                  onClick={() => palette.forEach((item) => addField(item))}
                  disabled={allCategoryFieldsUsed}
                  style={{
                    marginTop: 14, width: "100%", background: allCategoryFieldsUsed ? "#9ca3af" : "#1f2937", color: "#fff",
                    border: "none", borderRadius: 7, padding: "9px 0", cursor: allCategoryFieldsUsed ? "not-allowed" : "pointer",
                    fontSize: 13, fontWeight: 600, transition: "background 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!allCategoryFieldsUsed) e.currentTarget.style.background = "#374151"; }}
                  onMouseLeave={(e) => { if (!allCategoryFieldsUsed) e.currentTarget.style.background = "#1f2937"; }}
                >
                  + {allCategoryFieldsUsed ? "All fields added" : `Add all ${CATEGORY_INFO[activeCategory].label.toLowerCase()}`}
                </button>
              )}
            </div>
          )}
        </div>

        <div
          role="button"
          tabIndex={0}
          style={{ flex: 1, background: "#f5f5f5", padding: "14px 16px", minWidth: 0 }}
          onClick={() => { setActiveSection(null); setActiveFieldId(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActiveSection(null);
              setActiveFieldId(null);
            }
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 12,
              flexWrap: "wrap",
              border: "1px solid #d7dde4",
              borderRadius: 14,
              background: "#fff",
              padding: "12px 14px",
            }}
          >
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {config.steps.map((step, idx) => (
                <button
                  key={step.id}
                  onClick={(e) => { e.stopPropagation(); setActiveStepIndex(idx); setEditingSteps(false); setActiveSection(null); setActiveFieldId(null); }}
                  style={{
                    padding: "7px 15px", border: "none",
                    borderRadius: 10,
                    background: activeStepIndex === idx ? "#d8d8d8" : "transparent",
                    color: "#4b5563",
                    fontWeight: activeStepIndex === idx ? 600 : 500,
                    fontSize: 13, cursor: "pointer", transition: "background 0.12s, color 0.12s",
                  }}
                >
                  {step.label}
                </button>
              ))}
            </div>
            <s-button variant="primary" onClick={handleSaveAndSubmit} loading={isSaving}>
              Save & Submit
            </s-button>
          </div>

          <div
            style={{ background: "#f3f4f6", borderRadius: "0 8px 8px 8px", padding: "14px 0", minHeight: 400 }}
            onDragOver={(e) => { e.preventDefault(); setIsDragOverCanvas(true); }}
            onDragLeave={() => { setIsDragOverCanvas(false); setSectionDragOver(null); }}
            onDrop={handleCanvasZoneDrop}
          >
            {stepFields.length === 0 ? (
              <div
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  minHeight: 240, border: `2px dashed ${isDragOverCanvas ? "#6366f1" : "#d1d5db"}`,
                  borderRadius: 10, background: isDragOverCanvas ? "#eef2ff" : "#fff",
                  color: "#9ca3af", fontSize: 14, gap: 10, transition: "all 0.15s",
                }}
              >
                <div style={{ fontSize: 32 }}>📋</div>
                <div style={{ fontWeight: 500 }}>Drop fields here</div>
                <div style={{ fontSize: 12 }}>or click a field in the palette to add it</div>
              </div>
            ) : (
              <div style={{ background: "#fff", borderRadius: 0, padding: "30px 22px 24px", height: "calc(100vh - 280px)", minHeight: 580, overflowY: "auto", borderLeft: "1px solid #eceff3" }}>
                {noSection.length > 0 && (
                  <div style={{ background: "#fff", borderRadius: 10, padding: 0, marginBottom: 12, border: "2px solid transparent" }}>
                    <FieldRows
                      fields={noSection}
                      onRemove={removeFieldIfAllowed}
                      onDragStart={handleFieldDragStart}
                      onDragOver={handleFieldDragOver}
                      onDrop={handleFieldDrop}
                      dragOverId={fieldDragOverId}
                      activeFieldId={activeFieldId}
                      onActivateField={(id) => { setActiveFieldId(id); setActiveSection(null); }}
                    />
                  </div>
                )}

                {sectionOrder.map((section) => (
                  <SectionBlock
                    key={section}
                    showHeading={
                      activeSection === section
                        ? !sectionEditorDraft.content.trim() ? !(getSectionHeadingSettings(sectionMap[section] || [], section).hidden) : true
                        : !getSectionHeadingSettings(sectionMap[section] || [], section).hidden
                    }
                    section={section}
                    sectionLabel={
                      activeSection === section
                        ? sectionEditorDraft.content || getSectionDisplayLabel(sectionMap[section] || [], section)
                        : getSectionDisplayLabel(sectionMap[section] || [], section)
                    }
                    headingTag={
                      activeSection === section
                        ? sectionEditorDraft.headingTag
                        : getSectionHeadingSettings(sectionMap[section] || [], section).headingTag
                    }
                    headingAlignment={
                      activeSection === section
                        ? sectionEditorDraft.alignment
                        : getSectionHeadingSettings(sectionMap[section] || [], section).alignment
                    }
                    headingWidth={
                      activeSection === section
                        ? sectionEditorDraft.width
                        : getSectionHeadingSettings(sectionMap[section] || [], section).width
                    }
                    fields={sectionMap[section] || []}
                    isActive={activeSection === section}
                    onActivate={() => { setActiveSection(section); setActiveFieldId(null); }}
                    onRemoveField={removeFieldIfAllowed}
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
                    canDeleteSection={true}
                    activeFieldId={activeFieldId}
                    onActivateField={(id) => { setActiveFieldId(id); setActiveSection(null); }}
                  />
                ))}

                <div
                  style={{
                    marginTop: 14, border: `2px dashed ${isDragOverCanvas ? "#c5ccd5" : "#d1d5db"}`,
                    borderRadius: 8, padding: "14px 0", textAlign: "center",
                    color: "#9ca3af", fontSize: 12,
                    background: isDragOverCanvas ? "#f8f9fb" : "transparent", transition: "all 0.15s",
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
     
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
