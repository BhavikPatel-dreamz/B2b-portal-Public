import { useState, useRef, useCallback, useEffect } from "react";
import {
  useLoaderData,
  Link,
  Form,
  useNavigation,
  useActionData,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

function fmtMoney(amount: string | number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount) || 0);
}

function fmtDate(iso: string) {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function fmtDateTime(iso: string) {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

type Variant = {
  id: string;
  title?: string;
  sku?: string;
  price?: string | number;
  currencyCode?: string;
  inventoryQuantity?: number;
  inventoryPolicy?: "CONTINUE" | "DENY" | string;
  tracked?: boolean;
  availableForSale?: boolean;
};

type ShippingCountryOption = {
  value: string;
  label: string;
  provinces: Array<{ value: string; label: string }>;
};

type Product = {
  id: string;
  title: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  image?: string;
  variants: Variant[];
};

type AddProductForm = {
  productId: string;
  productTitle: string;
  sku: string;
  variantTitle: string;
  variantId: string;
  image: string;
  unitPrice: string;
  discount: string;
  quantity: number;
};

type NewProductRow = AddProductForm & { rowKey: string };

const defaultAddProductForm: AddProductForm = {
  productId: "",
  productTitle: "",
  sku: "",
  variantTitle: "Default variant",
  variantId: "",
  image: "",
  unitPrice: "0",
  discount: "0",
  quantity: 1,
};

const ACCENT = "#005bd3";
const ACCENT_DARK = "#003e94";

function getFlagForCountry(raw: string | undefined) {
  if (!raw) return "";
  const v = String(raw).toUpperCase().trim();
  if (["IN", "INDIA"].includes(v)) return "🇮🇳";
  if (["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(v)) return "🇺🇸";
  if (["GB", "UK", "UNITED KINGDOM", "UNITED KINGDOM OF GREAT BRITAIN"].includes(v)) return "🇬🇧";
  if (["AU", "AUSTRALIA"].includes(v)) return "🇦🇺";
  if (["CA", "CANADA"].includes(v)) return "🇨🇦";
  return "";
}

function isVariantInStock(variant?: Variant): boolean {
  if (!variant) return false;
  if (variant.availableForSale === false) return false;
  if (variant.tracked === false) return true;
  if (variant.inventoryQuantity === undefined || variant.inventoryQuantity === null)
    return true;
  if (variant.inventoryPolicy === "CONTINUE") return true;
  return variant.inventoryQuantity > 0;
}

function fmtPrice(amount: string | number | undefined, currencyCode = "USD") {
  const num = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${currencyCode} ${num.toFixed(2)}`;
  }
}

const modalPillStyle: React.CSSProperties = {
  display: "inline-block",
  background: "#f1f2f4",
  color: "#4b5563",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 11,
  fontWeight: 600,
};

const modalLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#6b7280",
  textTransform: "uppercase",
  letterSpacing: 0.3,
  marginBottom: 4,
};

const modalStepBtnStyle: React.CSSProperties = {
  width: 24,
  height: "100%",
  border: "none",
  background: "#f9fafb",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 700,
};

const modalFieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 13,
  color: "#374151",
  fontWeight: 700,
};

const modalFieldInputStyle: React.CSSProperties = {
  height: 38,
  border: "1px solid #c9cccf",
  borderRadius: 8,
  padding: "0 10px",
  font: "inherit",
  fontSize: 13,
};

interface AddProductModalProps {
  form?: any;
  setForm?: (updater: any) => void;
  onCancel: () => void;
  onConfirm?: () => void;
  productQuery: string;
  setProductQuery: (q: string) => void;
  productResults: Product[];
  fetchProducts: (q: string) => void;
  isFetchingProducts: boolean;
  onSelectVariant: (product: Product, variant: Variant, quantity: number) => void;
  defaultCurrencyCode?: string;
}

function AddProductModal({
  form,
  setForm,
  onCancel,
  onConfirm,
  productQuery,
  setProductQuery,
  productResults,
  fetchProducts,
  isFetchingProducts,
  onSelectVariant,
  defaultCurrencyCode = "USD",
}: AddProductModalProps) {
  const manualEntryEnabled = Boolean(form && setForm && onConfirm);
  const handleManualFieldChange = (field: string, value: string | number) => {
    if (!setForm) return;
    setForm((f: any) => ({ ...(f || {}), [field]: value }));
  };
  const [mode, setMode] = useState<"search" | "manual">("search");
  const [searchInput, setSearchInput] = useState(productQuery || "");
  const [selection, setSelection] = useState<Record<string, { variantId: string; qty: number }>>({});

  useEffect(() => {
    setSearchInput(productQuery || "");
  }, [productQuery]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setProductQuery(searchInput.trim() || "all");
  };

  const getSelection = useCallback(
    (product: Product) => {
      const existing = selection[product.id];
      const variantId = existing?.variantId || product.variants?.[0]?.id || "";
      const qty = existing?.qty || 1;
      return { variantId, qty };
    },
    [selection],
  );

  const setVariantId = (productId: string, variantId: string) => {
    setSelection((prev) => ({
      ...prev,
      [productId]: { variantId, qty: prev[productId]?.qty || 1 },
    }));
  };

  const setQty = (productId: string, qty: number) => {
    if (qty < 1) return;
    setSelection((prev) => ({
      ...prev,
      [productId]: { variantId: prev[productId]?.variantId || "", qty },
    }));
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: "min(760px, 100%)",
          maxHeight: "88vh",
          background: "#fff",
          borderRadius: 14,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid #e3e7ec",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
            Add Product
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              fontSize: 22,
              cursor: "pointer",
              color: "#5c5f62",
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        {/* Mode toggle */}
        {manualEntryEnabled && (
          <div style={{ display: "flex", gap: 8, padding: "14px 20px 0" }}>
            <button
              type="button"
              onClick={() => setMode("search")}
              style={{
                background: mode === "search" ? "#111827" : "#f9fafb",
                color: mode === "search" ? "#fff" : "#374151",
                border: "1px solid " + (mode === "search" ? "#111827" : "#d1d5db"),
                borderRadius: 999,
                padding: "7px 14px",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Search Catalog
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              style={{
                background: mode === "manual" ? "#111827" : "#f9fafb",
                color: mode === "manual" ? "#fff" : "#374151",
                border: "1px solid " + (mode === "manual" ? "#111827" : "#d1d5db"),
                borderRadius: 999,
                padding: "7px 14px",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Manual Entry
            </button>
          </div>
        )}

        {!manualEntryEnabled || mode === "search" ? (
          <>
            {/* Search bar */}
            <form
              onSubmit={handleSearchSubmit}
              style={{ display: "flex", gap: 10, padding: "14px 20px 0" }}
            >
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search products by title or SKU..."
                style={{
                  flex: 1,
                  height: 40,
                  border: "1px solid #c9cccf",
                  borderRadius: 8,
                  padding: "0 12px",
                  fontSize: 13,
                }}
              />
              <button
                type="submit"
                disabled={isFetchingProducts}
                style={{
                  height: 40,
                  padding: "0 18px",
                  background: "#111827",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: isFetchingProducts ? "not-allowed" : "pointer",
                  opacity: isFetchingProducts ? 0.7 : 1,
                }}
              >
                {isFetchingProducts ? "Searching..." : "Search"}
              </button>
            </form>

            {/* Results */}
            <div
              style={{
                overflowY: "auto",
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              {isFetchingProducts ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280", fontSize: 13 }}>
                  Loading products...
                </div>
              ) : productResults.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280", fontSize: 13 }}>
                  No products found. Try a different search term.
                </div>
              ) : (
                productResults.map((product) => {
                  const { variantId, qty } = getSelection(product);
                  const variant = product.variants.find((v) => v.id === variantId) || product.variants[0];
                  const inStock = isVariantInStock(variant);

                  return (
                    <div
                      key={product.id}
                      style={{
                        display: "flex",
                        gap: 14,
                        border: "1px solid #eceef1",
                        borderRadius: 12,
                        padding: 16,
                        alignItems: "center",
                        background: "#fff",
                      }}
                    >
                      {/* Image */}
                      <div
                        style={{
                          width: 64,
                          height: 64,
                          borderRadius: 10,
                          overflow: "hidden",
                          border: "1px solid #eceef1",
                          background: "#f9fafb",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {product.image ? (
                          <img src={product.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <span style={{ fontSize: 22 }}>📦</span>
                        )}
                      </div>

                      {/* Middle info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14.5, color: "#111827" }}>
                          {product.title}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                          {product.vendor && <span style={modalPillStyle}>{product.vendor}</span>}
                          {product.productType && <span style={modalPillStyle}>{product.productType}</span>}
                          {(product.tags || []).slice(0, 2).map((tag) => (
                            <span key={tag} style={modalPillStyle}>
                              {tag}
                            </span>
                          ))}
                        </div>

                        <div style={{ marginTop: 10 }}>
                          <div style={modalLabelStyle}>Variant</div>
                          {product.variants.length > 1 ? (
                            <select
                              value={variantId}
                              onChange={(e) => setVariantId(product.id, e.target.value)}
                              style={{
                                width: "100%",
                                maxWidth: 320,
                                height: 36,
                                border: "1px solid #d1d5db",
                                borderRadius: 7,
                                padding: "0 8px",
                                fontSize: 13,
                              }}
                            >
                              {product.variants.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.title || "Default variant"} · SKU {v.sku || "N/A"} ·{" "}
                                  {fmtPrice(v.price, v.currencyCode || defaultCurrencyCode)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div
                              style={{
                                height: 36,
                                display: "flex",
                                alignItems: "center",
                                color: "#374151",
                                background: "#f9fafb",
                                border: "1px solid #e5e7eb",
                                borderRadius: 7,
                                padding: "0 8px",
                                fontSize: 13,
                                maxWidth: 320,
                              }}
                            >
                              {variant?.title && variant.title !== "Default Title" ? variant.title : "Default variant"}
                            </div>
                          )}
                          <div style={{ marginTop: 4, fontSize: 12, color: "#6b7280" }}>
                            SKU: {variant?.sku || "N/A"}
                          </div>
                        </div>
                      </div>

                      {/* Right column: price + stepper + action */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-end",
                          gap: 10,
                          flexShrink: 0,
                        }}
                      >
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 12, color: ACCENT, fontWeight: 700 }}>Unit price</div>
                          <div style={{ fontSize: 17, fontWeight: 800, color: ACCENT }}>
                            {fmtPrice(variant?.price, variant?.currencyCode || defaultCurrencyCode)}
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              border: "1px solid #d1d5db",
                              borderRadius: 7,
                              overflow: "hidden",
                              height: 30,
                            }}
                          >
                            <button type="button" onClick={() => setQty(product.id, qty - 1)} style={modalStepBtnStyle}>
                              -
                            </button>
                            <input
                              type="number"
                              min={1}
                              value={qty}
                              onChange={(e) => setQty(product.id, parseInt(e.target.value) || 1)}
                              style={{
                                width: 34,
                                height: "100%",
                                border: "none",
                                textAlign: "center",
                                fontSize: 12,
                                fontWeight: 600,
                                outline: "none",
                              }}
                            />
                            <button type="button" onClick={() => setQty(product.id, qty + 1)} style={modalStepBtnStyle}>
                              +
                            </button>
                          </div>

                          <button
                            type="button"
                            disabled={!inStock}
                            onClick={() => variant && onSelectVariant(product, variant, qty)}
                            style={{
                              background: inStock
                                ? `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DARK})`
                                : "#f1f2f4",
                              color: inStock ? "#fff" : "#6b7280",
                              border: "none",
                              borderRadius: 999,
                              padding: "9px 18px",
                              fontWeight: 700,
                              fontSize: 13,
                              cursor: inStock ? "pointer" : "not-allowed",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {inStock ? "Add" : "Out of stock"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          /* Manual entry form */
          <div
            style={{
              padding: 20,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 14,
              }}
            >
              <label style={modalFieldLabelStyle}>
                Product title
                <input
                  value={form?.productTitle ?? ""}
                  onChange={(e) => handleManualFieldChange("productTitle", e.target.value)}
                  style={modalFieldInputStyle}
                />
              </label>
              <label style={modalFieldLabelStyle}>
                SKU
                <input
                  value={form?.sku ?? ""}
                  onChange={(e) => handleManualFieldChange("sku", e.target.value)}
                  style={modalFieldInputStyle}
                />
              </label>
              <label style={modalFieldLabelStyle}>
                Variant title
                <input
                  value={form?.variantTitle ?? ""}
                  onChange={(e) => handleManualFieldChange("variantTitle", e.target.value)}
                  style={modalFieldInputStyle}
                />
              </label>
              <label style={modalFieldLabelStyle}>
                Image URL
                <input
                  value={form?.image ?? ""}
                  onChange={(e) => handleManualFieldChange("image", e.target.value)}
                  style={modalFieldInputStyle}
                />
              </label>
              <label style={modalFieldLabelStyle}>
                Unit price
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form?.unitPrice ?? ""}
                  onChange={(e) => handleManualFieldChange("unitPrice", e.target.value)}
                  style={modalFieldInputStyle}
                />
              </label>
              <label style={modalFieldLabelStyle}>
                Discount
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form?.discount ?? ""}
                  onChange={(e) => handleManualFieldChange("discount", e.target.value)}
                  style={modalFieldInputStyle}
                />
              </label>
              <label style={modalFieldLabelStyle}>
                Quantity
                <input
                  type="number"
                  min="1"
                  value={form?.quantity ?? 1}
                  onChange={(e) =>
                    handleManualFieldChange("quantity", parseInt(e.target.value, 10) || 1)
                  }
                  style={modalFieldInputStyle}
                />
              </label>
            </div>
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            padding: "14px 20px",
            borderTop: "1px solid #e3e7ec",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: "#fff",
              color: "#374151",
              border: "1px solid #c9cccf",
              borderRadius: 8,
              padding: "10px 16px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          {manualEntryEnabled && mode === "manual" && (
            <button
              type="button"
              onClick={() => onConfirm?.()}
              disabled={!form?.productTitle?.trim()}
              style={{
                background: "#111827",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "10px 16px",
                fontWeight: 600,
                cursor: form?.productTitle?.trim() ? "pointer" : "not-allowed",
                opacity: form?.productTitle?.trim() ? 1 : 0.6,
              }}
            >
              Add to Quote
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b21a8",
  sent: "#0369a1",
  viewed: "#1d4ed8",
  approved: "#166534",
  rejected: "#991b1b",
  expired: "#92400e",
  converted: "#334155",
  cancelled: "#6b7280",
};

export default function AdminQuoteDetailPage() {
  const { quote, shopDomain, companyLocations, deliveryDetails, shippingCountryOptions } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const [showAllActivities, setShowAllActivities] = useState(false);
  const [showDiscountForm, setShowDiscountForm] = useState(false);
  const [discountValue, setDiscountValue] = useState(
    quote.discountType === "PERCENTAGE" ? String(quote.discountAmount) : String(quote.discountAmount),
  );
  const [discountType, setDiscountType] = useState(quote.discountType || "FIXED_AMOUNT");
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceData, setInvoiceData] = useState<any>(null);
  const [editCustomer, setEditCustomer] = useState(false);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [productQuery, setProductQuery] = useState("all");
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [isFetchingProducts, setIsFetchingProducts] = useState(false);
  const productsFetchControllerRef = useRef<AbortController | null>(null);
  const [addProductForm, setAddProductForm] = useState<AddProductForm>(defaultAddProductForm);
  const [newProductRows, setNewProductRows] = useState<NewProductRow[]>([]);

  const isSubmitting = navigation.state !== "idle";
  const submittingIntent = isSubmitting ? String(navigation.formData?.get("intent") || "") : "";

  const openAddProductModal = () => {
    setAddProductForm(defaultAddProductForm);
    setShowAddProductModal(true);
  };

  const fetchProducts = async (query = "all") => {
    setIsFetchingProducts(true);
    try {
      if (productsFetchControllerRef.current) {
        productsFetchControllerRef.current.abort();
        productsFetchControllerRef.current = null;
      }
      const controller = new AbortController();
      productsFetchControllerRef.current = controller;

      const normalizedQuery = String(query || "").trim() || "all";
      const url = `/api/admin-product-search?q=${encodeURIComponent(normalizedQuery)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        setProductResults([]);
        return;
      }
      const data = await res.json();
      setProductResults(data.products || []);
    } catch (error: any) {
      if (error && error.name === "AbortError") {
        // aborted - ignore
      } else {
        console.error("Failed to load product search results", error);
        setProductResults([]);
      }
    } finally {
      setIsFetchingProducts(false);
      productsFetchControllerRef.current = null;
    }
  };

  useEffect(() => {
    if (!showAddProductModal) return;
    fetchProducts(productQuery || "all");
    return () => {
      if (productsFetchControllerRef.current) {
        productsFetchControllerRef.current.abort();
        productsFetchControllerRef.current = null;
      }
    };
  }, [showAddProductModal, productQuery]);

  useEffect(() => {
    if (actionData?.success) {
      setNewProductRows([]);
    }
  }, [actionData]);

  const confirmAddProduct = () => {
    if (!addProductForm.productTitle.trim()) return;
    const rowKey = String(Date.now());
    setNewProductRows((rows) => [...rows, { ...addProductForm, rowKey }]);
    setShowAddProductModal(false);
  };

  const handleSelectProductVariant = (
    product: Product,
    variant: Variant,
    quantity: number = 1,
  ) => {
    const selected: AddProductForm = {
      productId: product?.id || "",
      productTitle: product.title || "",
      sku: variant?.sku || "",
      variantTitle: variant?.title || "Default variant",
      variantId: variant?.id || "",
      image: product.image || "",
      unitPrice: String(variant?.price ?? "0"),
      discount: "0",
      quantity,
    };
    const rowKey = String(Date.now());
    setNewProductRows((rows) => [...rows, { ...selected, rowKey }]);
    setShowAddProductModal(false);
  };

  const removePendingProduct = (rowKey: string) => {
    setNewProductRows((rows) => rows.filter((r) => r.rowKey !== rowKey));
  };

  // ── Delivery Details (sales-portal style add/edit) ─────────
  const savedDelivery = quote.invoiceData?.quoteEditMeta?.deliveryDetails || {};
  const legacyAddressLines = savedDelivery.address
    ? String(savedDelivery.address)
        .split(/\n+/)
        .map((line: string) => line.trim())
        .filter(Boolean)
    : [];
  const [selectedDeliveryLocationId, setSelectedDeliveryLocationId] = useState<string>("");
  const [deliveryLocationNameValue, setDeliveryLocationNameValue] = useState<string>(
    savedDelivery.locationName || deliveryDetails?.locationName || "",
  );
  const [deliveryPhoneValue, setDeliveryPhoneValue] = useState<string>(
    savedDelivery.phone || deliveryDetails?.phone || "",
  );
  const [deliveryAddress1Value, setDeliveryAddress1Value] = useState<string>(
    savedDelivery.address1 || legacyAddressLines[0] || "",
  );
  const [deliveryAddress2Value, setDeliveryAddress2Value] = useState<string>(
    savedDelivery.address2 || legacyAddressLines[1] || "",
  );
  const [deliveryCityValue, setDeliveryCityValue] = useState<string>(
    savedDelivery.city || legacyAddressLines[2] || "",
  );
  const [deliveryProvinceValue, setDeliveryProvinceValue] = useState<string>(
    savedDelivery.province || legacyAddressLines[3] || "",
  );
  const [deliveryZipValue, setDeliveryZipValue] = useState<string>(
    savedDelivery.zip || legacyAddressLines[4] || "",
  );
  const [deliveryCountryValue, setDeliveryCountryValue] = useState<string>(
    savedDelivery.country || legacyAddressLines[5] || "",
  );

  const [showLocationForm, setShowLocationForm] = useState(false);
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [editingLocationId, setEditingLocationId] = useState<string>("");
  const [locationSubmitting, setLocationSubmitting] = useState(false);
  const [locationFormError, setLocationFormError] = useState<string | null>(null);
  const [locationFormSuccess, setLocationFormSuccess] = useState<string | null>(null);
  const [locationFieldErrors, setLocationFieldErrors] = useState<Record<string, string>>({});

  const selectedLocation = (companyLocations || []).find(
    (loc: any) => loc.id === selectedDeliveryLocationId,
  );
  const locationBeingEdited = (companyLocations || []).find(
    (loc: any) => loc.id === editingLocationId,
  );

  const selectedDeliveryCountry = (shippingCountryOptions || []).find((country: ShippingCountryOption) => {
    const rawValue = (deliveryCountryValue || "").trim();
    return (
      country.value === rawValue ||
      country.label.toLowerCase() === rawValue.toLowerCase()
    );
  });
  const deliveryProvinceOptions = selectedDeliveryCountry?.provinces ?? [];

  useEffect(() => {
    if (!selectedDeliveryLocationId) return;
    const location = (companyLocations || []).find(
      (loc: any) => loc.id === selectedDeliveryLocationId,
    );
    if (!location) return;
    const shipping = location.shippingAddress || {};
    setDeliveryLocationNameValue(location.name || "");
    setDeliveryAddress1Value(shipping.address1 || "");
    setDeliveryAddress2Value(shipping.address2 || "");
    setDeliveryCityValue(shipping.city || "");
    setDeliveryProvinceValue(shipping.province || "");
    setDeliveryZipValue(shipping.zip || "");
    setDeliveryCountryValue(shipping.country || "US");
    setDeliveryPhoneValue(shipping.phone || location.phone || "");
  }, [selectedDeliveryLocationId, companyLocations]);

  const applyLocationToForm = (location: any) => {
    const shipping = location?.shippingAddress || {};
    setDeliveryLocationNameValue(location?.name || "");
    setDeliveryAddress1Value(shipping.address1 || "");
    setDeliveryAddress2Value(shipping.address2 || "");
    setDeliveryCityValue(shipping.city || "");
    setDeliveryProvinceValue(shipping.province || "");
    setDeliveryZipValue(shipping.zip || "");
    setDeliveryCountryValue(shipping.country || "US");
    setDeliveryPhoneValue(shipping.phone || location?.phone || "");
  };

  const resetLocationForm = (editing: boolean, targetLocation: any) => {
    setLocationFormError(null);
    setLocationFormSuccess(null);
    setLocationFieldErrors({});
    if (editing && targetLocation) {
      applyLocationToForm(targetLocation);
    } else if (!editing) {
      setSelectedDeliveryLocationId("");
      setEditingLocationId("");
      setDeliveryLocationNameValue("");
      setDeliveryAddress1Value("");
      setDeliveryAddress2Value("");
      setDeliveryCityValue("");
      setDeliveryProvinceValue("");
      setDeliveryZipValue("");
      setDeliveryCountryValue("US");
      setDeliveryPhoneValue("");
    }
  };

  const handleOpenLocationForm = (editing: boolean) => {
    const targetId = editing ? selectedDeliveryLocationId : "";
    const targetLocation = editing
      ? (companyLocations || []).find((loc: any) => loc.id === targetId)
      : null;
    setShowLocationForm(true);
    setIsEditingLocation(editing);
    setEditingLocationId(targetId);
    resetLocationForm(editing, targetLocation);
  };

  const handleCancelLocationForm = () => {
    setShowLocationForm(false);
    setLocationFormError(null);
    setLocationFormSuccess(null);
    setLocationFieldErrors({});
    if (locationBeingEdited) {
      applyLocationToForm(locationBeingEdited);
    }
    setEditingLocationId("");
  };

  const handleSaveLocation = async () => {
    setLocationSubmitting(true);
    setLocationFormError(null);
    setLocationFormSuccess(null);

    const fieldErrors: Record<string, string> = {};
    if (!deliveryLocationNameValue.trim()) fieldErrors.name = "Location name is required.";
    if (!deliveryAddress1Value.trim()) fieldErrors.address1 = "Street address is required.";
    if (!deliveryCityValue.trim()) fieldErrors.city = "City is required.";
    if (!deliveryCountryValue.trim()) fieldErrors.country = "Country is required.";
    if (!deliveryZipValue.trim()) fieldErrors.zip = "Postal code is required.";

    if (Object.keys(fieldErrors).length > 0) {
      setLocationFieldErrors(fieldErrors);
      setLocationFormError("Please complete the required location fields before saving.");
      setLocationSubmitting(false);
      return;
    }

    try {
      const body = new URLSearchParams();
      body.set("intent", "save_company_location");
      if (isEditingLocation && locationBeingEdited?.id) {
        body.set("deliveryLocationId", locationBeingEdited.id);
      }
      body.set("deliveryLocationName", deliveryLocationNameValue.trim());
      body.set("deliveryAddress1", deliveryAddress1Value.trim());
      body.set("deliveryAddress2", deliveryAddress2Value.trim());
      body.set("deliveryCity", deliveryCityValue.trim());
      body.set("deliveryProvince", deliveryProvinceValue.trim());
      body.set("deliveryZip", deliveryZipValue.trim());
      body.set("deliveryCountry", deliveryCountryValue.trim());
      body.set("deliveryPhone", deliveryPhoneValue.trim());

      const res = await fetch(window.location.pathname + window.location.search, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "same-origin",
        body,
      });
      const result = await res.json().catch(() => null);
      if (res.ok && result?.success) {
        const locationId = result.locationId || locationBeingEdited?.id;
        setLocationFormSuccess("Location saved successfully.");
        setShowLocationForm(false);
        if (locationId) {
          setSelectedDeliveryLocationId(locationId);
        }
        revalidator.revalidate();
      } else {
        if (result?.fieldErrors && typeof result.fieldErrors === "object") {
          setLocationFieldErrors(result.fieldErrors);
        }
        setLocationFormError(result?.error || "Unable to save location.");
      }
    } catch (error: any) {
      console.error(error);
      setLocationFormError(error?.message || "Unable to save location. Please try again.");
    } finally {
      setLocationSubmitting(false);
    }
  };

  const clearLocationFromForm = (field: "name" | "address1" | "address2" | "city" | "province" | "zip" | "country" | "phone", value: string) => {
    if (selectedDeliveryLocationId && !showLocationForm) {
      setSelectedDeliveryLocationId("");
    }
    switch (field) {
      case "name":
        setDeliveryLocationNameValue(value);
        break;
      case "address1":
        setDeliveryAddress1Value(value);
        break;
      case "address2":
        setDeliveryAddress2Value(value);
        break;
      case "city":
        setDeliveryCityValue(value);
        break;
      case "province":
        setDeliveryProvinceValue(value);
        break;
      case "zip":
        setDeliveryZipValue(value);
        break;
      case "country":
        setDeliveryCountryValue(value);
        setDeliveryProvinceValue("");
        break;
      case "phone":
        setDeliveryPhoneValue(value);
        break;
    }
  };

  useEffect(() => {
    if (actionData?.invoiceData) {
      setInvoiceData(actionData.invoiceData);
      setShowInvoiceModal(true);
    } else if (actionData?.success) {
      shopify.toast.show?.(actionData.message || "Done");
      setShowDiscountForm(false);
      revalidator.revalidate();
    } else if (actionData?.error) {
      shopify.toast.show?.(actionData.error, { isError: true });
    }
  }, [actionData]);

  const isDraft = quote.status === "draft";
  const canEdit = true;
  const canEditDiscount = true;
  const canConvert = ["approved", "sent", "viewed"].includes(quote.status);

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.hero}>
        <Link
          to="/app/quotes"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#2c6ecb",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
            margin: "15px 15px 5px",
          }}
        >
          <svg viewBox="0 0 20 20" style={{ width: "16px", height: "16px" }} fill="currentColor">
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          Back to Quotes
        </Link>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, padding: "0 15px 15px" }}>
          <div>
            <h2 style={styles.heroTitle}>
              {quote.shopifyDraftOrderName || quote.shopifyDraftOrderId || quote.quoteNumber}
              <span
                style={{
                  marginLeft: 12,
                  padding: "4px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  background: "#f4f6f8",
                  color: STATUS_COLORS[quote.status] || "#374151",
                  textTransform: "capitalize",
                }}
              >
                {quote.status}
              </span>
            </h2>
            <p style={styles.heroText}>{quote.title || "No title"}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canEdit && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="send_invoice" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#005bd3", color: "white" }}
                >
                  {submittingIntent === "send_invoice" ? "Sending..." : "Send Invoice"}
                </button>
              </Form>
            )}
            {!canEdit && quote.shopifyDraftOrderId && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="send_invoice" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#005bd3", color: "white" }}
                >
                  {submittingIntent === "send_invoice" ? "Updating..." : "Update Invoice"}
                </button>
              </Form>
            )}
            {canConvert && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="create_order_manual" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#166534", color: "white" }}
                >
                  {submittingIntent === "create_order_manual" ? "Creating..." : "Create Order (Manual)"}
                </button>
              </Form>
            )}
            {quote.shopifyDraftOrderId && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="preview_invoice" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0" }}
                >
                  {submittingIntent === "preview_invoice" ? "Loading..." : "Preview Invoice"}
                </button>
              </Form>
            )}
            {isDraft && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="cancel_quote" />
                <button
                  disabled={isSubmitting}
                  onClick={(e) => { if (!confirm("Cancel this quote?")) e.preventDefault(); }}
                  style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", color: "#b91b1b" }}
                >
                  Cancel
                </button>
              </Form>
            )}
            <Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value="delete_quote" />
              <button
                disabled={isSubmitting}
                onClick={(e) => { if (!confirm("Delete this quote permanently?")) e.preventDefault(); }}
                style={{ ...styles.btn, background: "#fff", border: "1px solid #fecaca", color: "#b91b1b" }}
              >
                Delete
              </button>
            </Form>
          </div>
        </div>
      </div>

      <div style={styles.content}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20, alignItems: "start" }}>
          {/* Main Column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0, overflow: "hidden" }}>
            {/* Customer Info */}
            <div style={styles.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <h3 style={{ ...styles.cardTitle, margin: 0 }}>Customer Information</h3>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setEditCustomer(!editCustomer)}
                    style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", fontSize: 13 }}
                  >
                    {editCustomer ? "Cancel" : "Edit Customer"}
                  </button>
                )}
              </div>
              {editCustomer && canEdit ? (
                <Form method="post" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <input type="hidden" name="intent" value="update_customer_details" />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
                    <div>
                      <label style={styles.label}>First Name</label>
                      <input
                        name="customerFirstName"
                        defaultValue={quote.customerFirstName || ""}
                        style={styles.inputFull}
                      />
                    </div>
                    <div>
                      <label style={styles.label}>Last Name</label>
                      <input
                        name="customerLastName"
                        defaultValue={quote.customerLastName || ""}
                        style={styles.inputFull}
                      />
                    </div>
                    <div style={{ gridColumn: "span 2" }}>
                      <label style={styles.label}>Email</label>
                      <input
                        name="customerEmail"
                        type="email"
                        defaultValue={quote.customerEmail || ""}
                        style={styles.inputFull}
                      />
                    </div>
                  </div>
                  <div>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      style={{ ...styles.btn, background: "#005bd3", color: "white" }}
                    >
                      {submittingIntent === "update_customer_details" ? "Saving..." : "Save Customer Details"}
                    </button>
                  </div>
                </Form>
              ) : (
                <div style={styles.infoGrid}>
                  <div>
                    <span style={styles.label}>Company</span>
                    <Link to={`/app/companies/${quote.companyId}`} style={styles.link}>{quote.companyName}</Link>
                  </div>
                  <div>
                    <span style={styles.label}>Customer</span>
                    <span>{quote.customerFirstName || ""} {quote.customerLastName || ""}</span>
                  </div>
                  <div>
                    <span style={styles.label}>Email</span>
                    <span>{quote.customerEmail}</span>
                  </div>
                  <div>
                    <span style={styles.label}>Sales Agent</span>
                    <span>{quote.salesAgentName}</span>
                  </div>
                  <div>
                    <span style={styles.label}>Created</span>
                    <span>{fmtDate(quote.createdAt)}</span>
                  </div>
                  <div>
                    <span style={styles.label}>Expires</span>
                    <span>{fmtDate(quote.expiresAt)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Delivery Details */}
            <div style={styles.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
                <h3 style={{ ...styles.cardTitle, margin: 0 }}>Delivery Details</h3>
                {!showLocationForm && canEdit && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => handleOpenLocationForm(false)}
                      style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", fontSize: 13 }}
                    >
                      Add location
                    </button>
                    {selectedLocation && (
                      <button
                        type="button"
                        onClick={() => handleOpenLocationForm(true)}
                        style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", fontSize: 13 }}
                      >
                        Edit location
                      </button>
                    )}
                  </div>
                )}
              </div>

              {showLocationForm && (
                <div style={{ marginBottom: 12 }}>
                  <span style={{ ...styles.label, fontSize: 13, fontWeight: 650, color: "#202223" }}>
                    {isEditingLocation ? "Edit company location" : "Add a Shopify company location"}
                  </span>
                  {locationFormError && (
                    <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6, background: "#fff4f4", border: "1px solid #ffd9d9", color: "#b01000", fontSize: 13 }}>
                      {locationFormError}
                    </div>
                  )}
                  {locationFormSuccess && (
                    <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6, background: "#f1f8f5", border: "1px solid #c0e0d4", color: "#006e52", fontSize: 13 }}>
                      {locationFormSuccess}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                <div>
                  <label style={styles.label}>Saved location</label>
                  <select
                    name="deliveryLocationId"
                    value={selectedDeliveryLocationId}
                    onChange={(e) => setSelectedDeliveryLocationId(e.target.value)}
                    style={styles.inputFull}
                    disabled={isSubmitting || showLocationForm}
                  >
                    <option value="">-- Use custom delivery details --</option>
                    {(companyLocations || []).map((location: any) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={styles.label}>Location name</label>
                  <input
                    name="deliveryLocationName"
                    value={deliveryLocationNameValue}
                    onChange={(e) => clearLocationFromForm("name", e.target.value)}
                    placeholder="e.g. Warehouse / Store name"
                    style={locationFieldErrors.name ? { ...styles.inputFull, borderColor: "#d72c0d" } : styles.inputFull}
                    disabled={isSubmitting}
                  />
                  {locationFieldErrors.name && (
                    <div style={{ color: "#b01000", fontSize: 12, marginTop: 4 }}>{locationFieldErrors.name}</div>
                  )}
                </div>
                <div>
                  <label style={styles.label}>Address line 1</label>
                  <input
                    name="deliveryAddress1"
                    value={deliveryAddress1Value}
                    onChange={(e) => clearLocationFromForm("address1", e.target.value)}
                    placeholder="Street address"
                    style={locationFieldErrors.address1 ? { ...styles.inputFull, borderColor: "#d72c0d" } : styles.inputFull}
                    disabled={isSubmitting}
                  />
                  {locationFieldErrors.address1 && (
                    <div style={{ color: "#b01000", fontSize: 12, marginTop: 4 }}>{locationFieldErrors.address1}</div>
                  )}
                </div>
                <div>
                  <label style={styles.label}>Address line 2</label>
                  <input
                    name="deliveryAddress2"
                    value={deliveryAddress2Value}
                    onChange={(e) => clearLocationFromForm("address2", e.target.value)}
                    placeholder="Apartment, suite, unit, etc."
                    style={styles.inputFull}
                    disabled={isSubmitting}
                  />
                </div>
                <div>
                  <label style={styles.label}>Country</label>
                  <select
                    name="deliveryCountry"
                    value={deliveryCountryValue}
                    onChange={(e) => clearLocationFromForm("country", e.target.value)}
                    style={locationFieldErrors.country ? { ...styles.inputFull, borderColor: "#d72c0d" } : styles.inputFull}
                    disabled={isSubmitting}
                  >
                    <option value="">Select country</option>
                    {(shippingCountryOptions || []).map((country: ShippingCountryOption) => (
                      <option key={country.value} value={country.value}>
                        {getFlagForCountry(country.value || country.label)}{" "}
                        {country.label}
                      </option>
                    ))}
                  </select>
                  {locationFieldErrors.country && (
                    <div style={{ color: "#b01000", fontSize: 12, marginTop: 4 }}>{locationFieldErrors.country}</div>
                  )}
                </div>
                <div>
                  <label style={styles.label}>State / Province</label>
                  {deliveryProvinceOptions.length > 0 ? (
                    <select
                      name="deliveryProvince"
                      value={deliveryProvinceValue}
                      onChange={(e) => clearLocationFromForm("province", e.target.value)}
                      style={styles.inputFull}
                      disabled={isSubmitting}
                    >
                      <option value="">Select state / province</option>
                      {deliveryProvinceOptions.map((province: any) => (
                        <option key={province.value} value={province.value}>
                          {province.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      name="deliveryProvince"
                      value={deliveryProvinceValue}
                      onChange={(e) => clearLocationFromForm("province", e.target.value)}
                      placeholder="State or province"
                      style={styles.inputFull}
                      disabled={isSubmitting}
                    />
                  )}
                </div>
                <div>
                  <label style={styles.label}>City</label>
                  <input
                    name="deliveryCity"
                    value={deliveryCityValue}
                    onChange={(e) => clearLocationFromForm("city", e.target.value)}
                    placeholder="City"
                    style={locationFieldErrors.city ? { ...styles.inputFull, borderColor: "#d72c0d" } : styles.inputFull}
                    disabled={isSubmitting}
                  />
                  {locationFieldErrors.city && (
                    <div style={{ color: "#b01000", fontSize: 12, marginTop: 4 }}>{locationFieldErrors.city}</div>
                  )}
                </div>
                <div>
                  <label style={styles.label}>Postal code</label>
                  <input
                    name="deliveryZip"
                    value={deliveryZipValue}
                    onChange={(e) => clearLocationFromForm("zip", e.target.value)}
                    placeholder="Zip / postal code"
                    style={locationFieldErrors.zip ? { ...styles.inputFull, borderColor: "#d72c0d" } : styles.inputFull}
                    disabled={isSubmitting}
                  />
                  {locationFieldErrors.zip && (
                    <div style={{ color: "#b01000", fontSize: 12, marginTop: 4 }}>{locationFieldErrors.zip}</div>
                  )}
                </div>
                <div>
                  <label style={styles.label}>Delivery Phone</label>
                  <input
                    name="deliveryPhone"
                    value={deliveryPhoneValue}
                    onChange={(e) => clearLocationFromForm("phone", e.target.value)}
                    style={styles.inputFull}
                    disabled={isSubmitting}
                  />
                </div>
              </div>

              {(companyLocations || []).length > 0 ? (
                <p style={{ margin: "10px 0 0", color: "#5c5f62", fontSize: 13 }}>
                  Select one of the saved company locations to auto-fill address and phone, or use {"\u201C"}Add location{"\u201D"} / {"\u201C"}Edit location{"\u201D"} above to manage saved locations.
                </p>
              ) : (
                <p style={{ margin: "10px 0 0", color: "#5c5f62", fontSize: 13 }}>
                  No saved company locations are available. Use {"\u201C"}Add location{"\u201D"} above to create one.
                </p>
              )}

              {showLocationForm && (
                <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button
                    type="button"
                    onClick={handleCancelLocationForm}
                    disabled={locationSubmitting}
                    style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveLocation}
                    disabled={locationSubmitting}
                    style={{ ...styles.btn, background: "#005bd3", color: "white" }}
                  >
                    {locationSubmitting ? "Saving..." : "Save location"}
                  </button>
                </div>
              )}

              {canEdit && (
                <Form method="post" style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
                  <input type="hidden" name="intent" value="update_delivery_details" />
                  <input type="hidden" name="deliveryLocationName" value={deliveryLocationNameValue} />
                  <input type="hidden" name="deliveryAddress1" value={deliveryAddress1Value} />
                  <input type="hidden" name="deliveryAddress2" value={deliveryAddress2Value} />
                  <input type="hidden" name="deliveryCity" value={deliveryCityValue} />
                  <input type="hidden" name="deliveryProvince" value={deliveryProvinceValue} />
                  <input type="hidden" name="deliveryZip" value={deliveryZipValue} />
                  <input type="hidden" name="deliveryCountry" value={deliveryCountryValue} />
                  <input type="hidden" name="deliveryPhone" value={deliveryPhoneValue} />
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    style={{ ...styles.btn, background: "#005bd3", color: "white" }}
                  >
                    {submittingIntent === "update_delivery_details" ? "Saving..." : "Save Delivery Details"}
                  </button>
                </Form>
              )}
            </div>

            {/* Line Items */}
            <div style={styles.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
                <h3 style={{ ...styles.cardTitle, margin: 0 }}>Line Items ({quote.items.length})</h3>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={openAddProductModal}
                      style={{ ...styles.btn, background: "#005bd3", color: "white", border: "1px solid transparent", fontSize: 13 }}
                    >
                      + Add Product
                    </button>
                  )}
                  {canEditDiscount && (
                    <button
                      type="button"
                      onClick={() => setShowDiscountForm(!showDiscountForm)}
                      style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", fontSize: 13 }}
                    >
                      {showDiscountForm ? "Hide Discount" : "Order Discount"}
                    </button>
                  )}
                </div>
              </div>

              {/* Pending products (awaiting save) */}
              {newProductRows.length > 0 && canEdit && (
                <div style={{ padding: 14, background: "#f8fbff", border: "1px solid #dde3ea", borderRadius: 10, marginBottom: 14 }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="add_products" />
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#374151", marginBottom: 10 }}>
                      New products ({newProductRows.length})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {newProductRows.map((row) => (
                        <div
                          key={row.rowKey}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            border: "1px solid #e3e7ec",
                            background: "#fff",
                            borderRadius: 8,
                            padding: "8px 10px",
                          }}
                        >
                          <input type="hidden" name="newProductRow" value={row.rowKey} />
                          <input type="hidden" name={`newProductId_${row.rowKey}`} value={row.productId || ""} />
                          <input type="hidden" name={`newProductTitle_${row.rowKey}`} value={row.productTitle} />
                          <input type="hidden" name={`newSku_${row.rowKey}`} value={row.sku} />
                          <input type="hidden" name={`newVariantTitle_${row.rowKey}`} value={row.variantTitle} />
                          <input type="hidden" name={`newVariantId_${row.rowKey}`} value={row.variantId} />
                          <input type="hidden" name={`newImage_${row.rowKey}`} value={row.image} />
                          <input type="hidden" name={`newUnitPrice_${row.rowKey}`} value={row.unitPrice} />
                          <input type="hidden" name={`newDiscount_${row.rowKey}`} value={row.discount} />
                          <input type="hidden" name={`newQuantity_${row.rowKey}`} value={row.quantity} />

                          {row.image && (
                            <img
                              src={row.image}
                              alt=""
                              style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover", flexShrink: 0 }}
                            />
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {row.productTitle}
                            </div>
                            <div style={{ fontSize: 12, color: "#5c5f62", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {row.variantTitle} · SKU {row.sku || "N/A"} · Qty {row.quantity}
                            </div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
                            {fmtMoney(row.unitPrice, quote.currencyCode)}
                          </div>
                          <button
                            type="button"
                            onClick={() => removePendingProduct(row.rowKey)}
                            style={{ ...styles.smallBtn, background: "#fff", border: "1px solid #fecaca", color: "#b91b1b", flexShrink: 0 }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        style={{ ...styles.btn, background: "#166534", color: "white" }}
                      >
                        {submittingIntent === "add_products" ? "Saving..." : "Add to Quote"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewProductRows([])}
                        style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", color: "#374151" }}
                      >
                        Clear
                      </button>
                    </div>
                  </Form>
                </div>
              )}

              {/* Order Discount Form */}
              {showDiscountForm && canEditDiscount && (
                <div style={styles.discountForm}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <Form method="post" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <input type="hidden" name="intent" value="apply_order_discount" />
                      <div>
                        <label style={styles.label}>Type</label>
                        <select
                          name="discountType"
                          value={discountType}
                          onChange={(e) => setDiscountType(e.target.value)}
                          style={styles.select}
                        >
                          <option value="FIXED_AMOUNT">Fixed Amount ({quote.currencyCode})</option>
                          <option value="PERCENTAGE">Percentage (%)</option>
                        </select>
                      </div>
                      <div>
                        <label style={styles.label}>Amount</label>
                        <input
                          name="discountAmount"
                          type="number"
                          step="0.01"
                          min="0"
                          value={discountValue}
                          onChange={(e) => setDiscountValue(e.target.value)}
                          style={styles.input}
                        />
                      </div>
                      <button type="submit" disabled={isSubmitting} style={{ ...styles.btn, background: "#005bd3", color: "white" }}>
                        Apply
                      </button>
                    </Form>
                    {Number(quote.discountTotal) > 0 && (
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="remove_order_discount" />
                        <button type="submit" disabled={isSubmitting} style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", color: "#b91b1b" }}>
                          Remove
                        </button>
                      </Form>
                    )}
                  </div>
                </div>
              )}

              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>Product</th>
                    <th style={styles.th}>SKU</th>
                    <th style={{ ...styles.th, textAlign: "center" }}>Qty</th>
                    <th style={{ ...styles.th, textAlign: "right" }}>Unit Price</th>
                    <th style={{ ...styles.th, textAlign: "right" }}>Total</th>
                    {canEdit && <th style={{ ...styles.th, textAlign: "center" }}>Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {quote.items.map((item: any) => (
                    <tr key={item.id} style={{ borderTop: "1px solid #eef1f4" }}>
                      <td style={{ ...styles.td, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                          {item.image && (
                            <img src={item.image} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.productTitle}</div>
                            {item.variantTitle && <div style={{ fontSize: 12, color: "#5c5f62", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.variantTitle}</div>}
                          </div>
                        </div>
                      </td>
                      <td style={styles.td}>{item.sku || "–"}</td>
                      <td style={{ ...styles.td, textAlign: "center" }}>
                        {item.quantity}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right" }}>
                        {fmtMoney(item.unitPrice, item.currencyCode)}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right", fontWeight: 600 }}>
                        {fmtMoney(item.totalPrice, item.currencyCode)}
                      </td>
                      {canEdit && (
                        <td style={{ ...styles.td, textAlign: "center" }}>
                          <Form method="post" style={{ display: "inline" }} onSubmit={(e) => { if (!confirm(`Remove "${item.productTitle}" from this quote?`)) e.preventDefault(); }}>
                            <input type="hidden" name="intent" value="delete_item" />
                            <input type="hidden" name="itemId" value={item.id} />
                            <button
                              type="submit"
                              disabled={isSubmitting}
                              style={{ ...styles.btn, background: "#fff", border: "1px solid #fecaca", color: "#b91b1b", fontSize: 12, padding: "5px 10px" }}
                            >
                              Remove
                            </button>
                          </Form>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Activity */}
            <div style={styles.card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={styles.cardTitle}>Activity</h3>
                {quote.activities?.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllActivities((v) => !v)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px 6px",
                      fontSize: 16,
                      color: "#2c6ecb",
                      lineHeight: 1,
                    }}
                    title={showAllActivities ? "Collapse" : "Expand"}
                  >
                    {showAllActivities ? "\u25B2" : "\u25BC"}
                  </button>
                )}
              </div>
              {showAllActivities && (
                quote.activities?.length ? (
                  <div
                    className="hide-scrollbar"
                    style={{
                      maxHeight: 440,
                      overflowY: "auto",
                      paddingRight: 4,
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                      {quote.activities.map((act: any, idx: number, arr: any[]) => (
                        <div
                          key={act.id}
                          style={{
                            display: "flex",
                            gap: 12,
                            padding: "10px 0",
                            borderBottom: idx < arr.length - 1 ? "1px solid #f3f4f6" : "none",
                          }}
                        >
                          <div
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: "#2c6ecb",
                              marginTop: 6,
                              flexShrink: 0,
                            }}
                          />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{act.action}</div>
                            {act.message && <div style={{ fontSize: 13, color: "#5c5f62", marginTop: 2 }}>{act.message}</div>}
                            <div style={{ fontSize: 12, color: "#8c9196", marginTop: 2 }}>{fmtDateTime(act.createdAt)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p style={{ color: "#5c5f62", margin: 0 }}>No activity yet.</p>
                )
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20, position: "sticky", top: 20 }}>
            {/* Order Summary */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Order Summary</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={styles.summaryRow}>
                  <span>Subtotal</span>
                  <span>{fmtMoney(quote.subtotal, quote.currencyCode)}</span>
                </div>
                {Number(quote.discountTotal) > 0 && (
                  <div style={{ ...styles.summaryRow, color: "#166534" }}>
                    <span>
                      Discount
                      {quote.discountType === "PERCENTAGE" && ` (${quote.discountAmount}%)`}
                    </span>
                    <span>-{fmtMoney(quote.discountTotal, quote.currencyCode)}</span>
                  </div>
                )}
                {Number(quote.taxAmount) > 0 && (
                  <div style={styles.summaryRow}>
                    <span>Tax ({Number(quote.taxRate).toFixed(1)}%)</span>
                    <span>{fmtMoney(quote.taxAmount, quote.currencyCode)}</span>
                  </div>
                )}
                {Number(quote.shippingAmount) > 0 && (
                  <div style={styles.summaryRow}>
                    <span>Shipping</span>
                    <span>{fmtMoney(quote.shippingAmount, quote.currencyCode)}</span>
                  </div>
                )}
                <div style={{ ...styles.summaryRow, borderTop: "2px solid #e5e7eb", paddingTop: 10, marginTop: 4, fontWeight: 700, fontSize: 16 }}>
                  <span>Total</span>
                  <span>{fmtMoney(quote.totalAmount, quote.currencyCode)}</span>
                </div>
              </div>
            </div>

            {/* Quick Info */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Details</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Quote #</span>
                  <span style={{ fontWeight: 600 }}>{quote.shopifyDraftOrderName || quote.shopifyDraftOrderId || quote.quoteNumber}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Status</span>
                  <span style={{ fontWeight: 600, color: STATUS_COLORS[quote.status], textTransform: "capitalize" }}>{quote.status}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Currency</span>
                  <span>{quote.currencyCode}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Items</span>
                  <span>{quote.items.length}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Created</span>
                  <span>{fmtDate(quote.createdAt)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Expires</span>
                  <span>{fmtDate(quote.expiresAt)}</span>
                </div>
                {quote.sentAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#5c5f62" }}>Sent</span>
                    <span>{fmtDate(quote.sentAt)}</span>
                  </div>
                )}
                {quote.convertedOrderId && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#5c5f62" }}>Order ID</span>
                    <span style={{ fontWeight: 600 }}>{quote.convertedOrderId.slice(0, 12)}...</span>
                  </div>
                )}
              </div>
            </div>

            {/* Customer Comments */}
            {quote.customerComments && (
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>Customer Comments</h3>
                <p style={{ margin: 0, fontSize: 13 }}>{quote.customerComments}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Invoice Preview Modal */}
      {showInvoiceModal && invoiceData && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.5)",
          }}
          onClick={() => { setShowInvoiceModal(false); setInvoiceData(null); }}
        >
          <div
            style={{
              position: "relative",
              width: "90vw",
              maxWidth: 800,
              maxHeight: "90vh",
              background: "#fff",
              borderRadius: 12,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #e3e7ec" }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Invoice Preview — {quote.shopifyDraftOrderName || quote.quoteNumber}</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => window.print()}
                  style={{ ...styles.btn, background: "#005bd3", color: "#fff", padding: "6px 12px", fontSize: 12 }}
                >
                  Print / Save PDF
                </button>
                <button
                  type="button"
                  onClick={() => { setShowInvoiceModal(false); setInvoiceData(null); }}
                  style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#5c5f62", padding: "0 4px", lineHeight: 1 }}
                >
                  &times;
                </button>
              </div>
            </div>
            <div style={{ padding: "24px 32px", overflowY: "auto", flex: 1 }}>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>INVOICE</h2>
                  <p style={{ margin: "4px 0 0", color: "#5c5f62", fontSize: 13 }}>{quote.shopifyDraftOrderName || quote.quoteNumber}</p>
                </div>
                <div style={{ textAlign: "right", fontSize: 13, color: "#5c5f62" }}>
                  <p style={{ margin: 0 }}><strong>Date:</strong> {invoiceData.createdAt ? new Date(invoiceData.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "–"}</p>
                  {invoiceData.invoiceSentAt && (
                    <p style={{ margin: "2px 0 0" }}><strong>Sent:</strong> {new Date(invoiceData.invoiceSentAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</p>
                  )}
                </div>
              </div>

              {/* Customer */}
              {invoiceData.customer && (
                <div style={{ marginBottom: 24, fontSize: 13 }}>
                  <strong>Bill To:</strong>
                  <p style={{ margin: "4px 0 0" }}>
                    {[invoiceData.customer.firstName, invoiceData.customer.lastName].filter(Boolean).join(" ")}
                  </p>
                  {invoiceData.customer.email && <p style={{ margin: "2px 0 0", color: "#5c5f62" }}>{invoiceData.customer.email}</p>}
                </div>
              )}

              {/* Line Items Table */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Product</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>SKU</th>
                    <th style={{ textAlign: "center", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Qty</th>
                    <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Unit Price</th>
                    <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(invoiceData.lineItems || []).map((item: any, idx: number) => (
                    <tr key={idx}>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>
                        {item.title}
                        {item.variantTitle && <span style={{ color: "#5c5f62" }}> — {item.variantTitle}</span>}
                      </td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", color: "#5c5f62" }}>{item.sku || "–"}</td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "center" }}>{item.quantity}</td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right" }}>
                        {fmtMoney(item.originalUnitPrice, invoiceData.currencyCode)}
                      </td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right", fontWeight: 600 }}>
                        {fmtMoney(item.discountedTotal, invoiceData.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <div style={{ width: 280, fontSize: 13 }}>
                  <div style={styles.summaryRow}><span>Subtotal</span><span>{fmtMoney(invoiceData.subtotal, invoiceData.currencyCode)}</span></div>
                  {Number(invoiceData.totalDiscounts) > 0 && (
                    <div style={styles.summaryRow}><span>Discount</span><span style={{ color: "#b91b1b" }}>-{fmtMoney(invoiceData.totalDiscounts, invoiceData.currencyCode)}</span></div>
                  )}
                  {Number(invoiceData.totalShipping) > 0 && (
                    <div style={styles.summaryRow}><span>Shipping</span><span>{fmtMoney(invoiceData.totalShipping, invoiceData.currencyCode)}</span></div>
                  )}
                  {Number(invoiceData.totalTax) > 0 && (
                    <div style={styles.summaryRow}><span>Tax</span><span>{fmtMoney(invoiceData.totalTax, invoiceData.currencyCode)}</span></div>
                  )}
                  <div style={{ ...styles.summaryRow, fontWeight: 700, fontSize: 15, borderTop: "2px solid #e3e7ec", marginTop: 8, paddingTop: 8 }}>
                    <span>Total</span>
                    <span>{fmtMoney(invoiceData.totalPrice, invoiceData.currencyCode)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Product Modal */}
      {showAddProductModal && (
        <AddProductModal
          form={addProductForm}
          setForm={setAddProductForm}
          onCancel={() => setShowAddProductModal(false)}
          onConfirm={confirmAddProduct}
          productQuery={productQuery}
          setProductQuery={setProductQuery}
          productResults={productResults}
          fetchProducts={fetchProducts}
          isFetchingProducts={isFetchingProducts}
          onSelectVariant={handleSelectProductVariant}
          defaultCurrencyCode={quote.currencyCode}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: 24,
    boxSizing: "border-box",
    fontFamily: '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  },
  hero: {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  },
  heroTitle: {
    fontSize: 22,
    lineHeight: 1.15,
    fontWeight: 650,
    color: "#202223",
    margin: "15px 15px 4px",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
  },
  heroText: {
    fontSize: 14,
    color: "#5c5f62",
    margin: "0 15px 0",
  },
  content: {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e3e7ec",
    borderRadius: 12,
    padding: 18,
    minWidth: 0,
    overflow: "hidden",
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 650,
    color: "#202223",
    margin: "0 0 14px",
  },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#5c5f62",
    marginBottom: 2,
  },
  link: { color: "#2c6ecb", textDecoration: "none", fontWeight: 600 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    fontSize: 12,
    fontWeight: 650,
    color: "#5c5f62",
    background: "#fbfbfc",
    borderBottom: "1px solid #e3e7ec",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "12px",
    verticalAlign: "middle",
    color: "#202223",
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "9px 16px",
    borderRadius: 8,
    border: "1px solid transparent",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  smallBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "5px 10px",
    borderRadius: 6,
    border: "1px solid transparent",
    fontWeight: 600,
    fontSize: 12,
    cursor: "pointer",
  },
  input: {
    height: 36,
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "0 10px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
  },
  inputFull: {
    width: "100%",
    height: 40,
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "0 11px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
    boxSizing: "border-box",
  },
  select: {
    height: 36,
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "0 8px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
  },
  textarea: {
    width: "100%",
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "8px 11px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
    resize: "vertical",
    boxSizing: "border-box",
  },
  discountForm: {
    padding: 14,
    background: "#f8fbff",
    border: "1px solid #dde3ea",
    borderRadius: 10,
    marginBottom: 14,
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 13,
    color: "#202223",
  },
};
