import { useMemo } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { updateStore } from "../services/store.server";

interface LoaderData {
  storeMissing: boolean;
  store?: {
    shopDomain: string;
    shopName: string;
    logo: string;
    submissionEmail: string;
    companyWelcomeEmailTemplate?: string;
    companyWelcomeEmailEnabled?: boolean;
  };
}

interface ActionResponse {
  success: boolean;
  message?: string;
  errors?: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json({ storeMissing: true } satisfies LoaderData, {
      status: 404,
    });
  }

  return Response.json(
    {
      storeMissing: false,
      store: {
        shopDomain: store.shopDomain,
        shopName: store.shopName || "",
        logo: store.logo || "",
        submissionEmail: store.submissionEmail || "",
        companyWelcomeEmailTemplate: store.companyWelcomeEmailTemplate || "",
        companyWelcomeEmailEnabled: store.companyWelcomeEmailEnabled !== false,
      },
    } satisfies LoaderData,
    { status: 200 },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { success: false, errors: ["Store not found"] } satisfies ActionResponse,
      { status: 404 },
    );
  }

  const formData = await request.formData();
  const logoRaw = (formData.get("logo") as string | null)?.trim() || "";
  const submissionEmailRaw =
    (formData.get("submissionEmail") as string | null)?.trim() || "";
  const companyWelcomeEmailTemplate =
    (formData.get("companyWelcomeEmailTemplate") as string | null)?.trim() || "";
  const companyWelcomeEmailEnabled =
    (formData.get("companyWelcomeEmailEnabled") as string | null) === "on";

  const submissionEmail = submissionEmailRaw || null;
  if (
    submissionEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submissionEmail)
  ) {
    return Response.json(
      { success: false, errors: ["Enter a valid email address."] },
      { status: 400 },
    );
  }

  const logo = logoRaw || null;

  await updateStore(store.id, {
    logo,
    submissionEmail,
    companyWelcomeEmailTemplate: companyWelcomeEmailTemplate || null,
    companyWelcomeEmailEnabled,
  });

  return Response.json(
    { success: true, message: "Settings saved" } satisfies ActionResponse,
    { status: 200 },
  );
};

export default function SettingsPage() {
  const { store, storeMissing } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResponse>();

  const isSaving = fetcher.state !== "idle";

  const feedback = useMemo(() => {
    if (!fetcher.data) return null;
    if (!fetcher.data.success && fetcher.data.errors?.length) {
      return {
        tone: "critical" as const,
        title: "Could not save settings",
        messages: fetcher.data.errors,
      };
    }
    if (fetcher.data.success && fetcher.data.message) {
      return {
        tone: "success" as const,
        title: fetcher.data.message,
        messages: [],
      };
    }
    return null;
  }, [fetcher.data]);

  if (storeMissing) {
    return (
      <s-page heading="Store settings">
        <s-section>
          <s-banner tone="critical" title="Store not found">
            <s-paragraph>
              The current shop is missing from the database. Please reinstall
              the app to continue.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Store settings">
      <s-section heading="Branding & notifications">
        {feedback && (
          <s-banner
            tone={feedback.tone}
            title={feedback.title}
            style={{ marginBottom: 12 }}
          >
            {feedback.messages.length > 0 && (
              <s-unordered-list>
                {feedback.messages.map((msg) => (
                  <s-list-item key={msg}>{msg}</s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-banner>
        )}

        <s-card>
          <fetcher.Form method="post" style={{ display: "grid", gap: 16 }}>

<div style={{ display: "grid", gap: 6 }}>
              <label htmlFor="name" style={{ fontWeight: 600, fontSize: 14 }}>
                Store name
              </label>
              <input
                id="shopName"
                name="shopName"
                type="text"
                defaultValue={store?.shopName}
                placeholder="Store name"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Store name shown across emails or customer views.
              </s-text>


            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <label htmlFor="logo" style={{ fontWeight: 600, fontSize: 14 }}>
                Logo URL
              </label>
              <input
                id="logo"
                name="logo"
                type="url"
                defaultValue={store?.logo}
                placeholder="https://your-cdn.com/logo.png"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Storefront logo URL shown across emails or customer views.
              </s-text>

              {store?.logo && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginTop: 8,
                  }}
                >
                  <div
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "1px solid #ebedef",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "#f6f6f7",
                    }}
                  >
                    <img
                      src={store.logo}
                      alt="Current logo"
                      style={{ maxWidth: "100%", maxHeight: "100%" }}
                    />
                  </div>
                  <s-text tone="subdued" variant="bodySm">
                    Preview of the stored logo.
                  </s-text>
                </div>
              )}
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="submissionEmail"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Registration notification email
              </label>
              <input
                id="submissionEmail"
                name="submissionEmail"
                type="email"
                defaultValue={store?.submissionEmail}
                placeholder="ops@yourstore.com"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#005bd3";
                  e.target.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Email address that receives new B2B registration submissions.
              </s-text>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="companyWelcomeEmailEnabled"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Company sync notifications
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="companyWelcomeEmailEnabled"
                  name="companyWelcomeEmailEnabled"
                  type="checkbox"
                  defaultChecked={store?.companyWelcomeEmailEnabled}
                  style={{ width: 18, height: 18, cursor: "pointer" }}
                />
                <label
                  htmlFor="companyWelcomeEmailEnabled"
                  style={{ cursor: "pointer" }}
                >
                  Send email notifications when companies are synced
                </label>
              </div>
              <s-text tone="subdued" variant="bodySm">
                Enable to receive email notifications whenever companies are synced from Shopify B2B.
              </s-text>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <label
                htmlFor="companyWelcomeEmailTemplate"
                style={{ fontWeight: 600, fontSize: 14 }}
              >
                Company welcome email notes
              </label>
              <textarea
                id="companyWelcomeEmailTemplate"
                name="companyWelcomeEmailTemplate"
                defaultValue={store?.companyWelcomeEmailTemplate || ""}
                placeholder="Add any custom notes or instructions for company welcome emails..."
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c9cccf",
                  fontSize: 14,
                  outline: "none",
                  fontFamily: "monospace",
                  minHeight: 120,
                  resize: "vertical",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "#005bd3";
                  e.currentTarget.style.boxShadow = "0 0 0 1px #005bd3";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "#c9cccf";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
              <s-text tone="subdued" variant="bodySm">
                Optional custom message to include in company welcome emails. Supports plain text.
              </s-text>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <s-button type="submit" variant="primary" {...(isSaving ? { loading: true } : {})}>
                Save settings
              </s-button>
            </div>
          </fetcher.Form>
        </s-card>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
