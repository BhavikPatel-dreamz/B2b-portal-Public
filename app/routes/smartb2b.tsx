import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

function getHtmlContent(customerId: string, shop: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
  <title>Smart B2B</title>
  <link rel="stylesheet" href="https://smartb2b.dynamicdreamz.com/embed.css" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; -webkit-text-size-adjust: 100%; }
    body {
      background-color: #B8BABB;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }
    #shopify-company-app-root {
      width: 100%;
      min-height: 100vh;
    }
  </style>
</head>
<body>
  <div id="shopify-company-app-root"></div>

  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script type="module" src="https://smartb2b.dynamicdreamz.com/embed.js"></script>
  <script src="https://unpkg.com/@shopify/app-bridge-react/umd/index.umd.production.min.js"></script>

  <script>
    document.addEventListener("DOMContentLoaded", function() {
      if (window.ShopifyCompanyApp && window.ShopifyCompanyApp.init) {
        window.ShopifyCompanyApp.init({
          containerId: 'shopify-company-app-root',
          proxyUrl: '/apps/b2b-portal-public-3/api/proxy',
          customerId: ${JSON.stringify(customerId)},
          shop: ${JSON.stringify(shop)}
        });
      } else {
        var container = document.getElementById('shopify-company-app-root');
        if (container) {
          container.innerHTML = '<p style="color: orange; padding: 20px;">Initialization failed.</p>';
        }
      }
    });
  </script>
</body>
</html>`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

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

  const htmlContent = getHtmlContent(customerId, shop);

  return new Response(htmlContent, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
};
