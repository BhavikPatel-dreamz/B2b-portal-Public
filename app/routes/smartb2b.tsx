import { renderToString } from "react-dom/server";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

 const styles = {
  index: { padding: "50px 0" },
  container: { maxWidth: "800px", margin: "0 auto" },
  heading: { fontSize: "32px", marginBottom: "20px" },
  text: { fontSize: "18px", color: "#555", marginBottom: "30px" },
  list: { listStyle: "none", padding: 0 },
  listItem: { marginBottom: "15px" },
};

function FrontendLandingPage({ customerId, shop }: { customerId: string; shop: string }) {
  return (
    <div style={styles.index}>
      <div id="shopify-company-app-root"></div>

      <link rel="stylesheet" href="https://smartb2b.dynamicdreamz.com/embed.css"/>

      <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
      <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
      <script type="module" src="https://smartb2b.dynamicdreamz.com/embed.js"></script>
      <script src="https://unpkg.com/@shopify/app-bridge-react/umd/index.umd.production.min.js"></script>

      <script
        dangerouslySetInnerHTML={{
          __html: `
            if (window.ShopifyCompanyApp && window.ShopifyCompanyApp.init) {
              window.ShopifyCompanyApp.init({
                containerId: 'shopify-company-app-root',
                proxyUrl: '/apps/b2b-portal-public-3/api/proxy',
                customerId: ${JSON.stringify(customerId)},
                shop: ${JSON.stringify(shop)}
              });
            } else {
              const container = document.getElementById('shopify-company-app-root');
              if (container) {
                container.innerHTML = '<p style="color: orange;">Initialization failed.</p>';
              }
            }
          `,
        }}
      />
    </div>
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop');
  const customerId = url.searchParams.get('logged_in_customer_id');

  if (!shop) {
    console.error("[smartb2b] Missing shop parameter in proxy request");
    return new Response("Missing shop parameter", { status: 400 });
  }

  if (!customerId) {
    console.log(`[smartb2b] No logged_in_customer_id for shop=${shop}, redirecting to login`);
    const loginUrl = `https://${shop}/account/login?return_to=${encodeURIComponent(url.href)}`;
    const redirectHtml = `<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(loginUrl)};</script></head><body></body></html>`;
    return new Response(redirectHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    await authenticate.public.appProxy(request);
  } catch (error) {
    console.error(`[smartb2b] App proxy authentication failed for shop=${shop}, customerId=${customerId}:`, error);
    const loginUrl = `https://${shop}/account/login?return_to=${encodeURIComponent(url.href)}`;
    const redirectHtml = `<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(loginUrl)};</script></head><body></body></html>`;
    return new Response(redirectHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const htmlContent = renderToString(
    <FrontendLandingPage
      customerId={customerId}
      shop={shop}
    />
  );

  return new Response(htmlContent, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
};