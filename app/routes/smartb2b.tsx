import { renderToString } from "react-dom/server";
import { authenticate } from "../shopify.server";

// 1. Define your styles as a constant
const styles = {
  index: { padding: "50px 0" },
  container: { maxWidth: "800px", margin: "0 auto" },
  heading: { fontSize: "32px", marginBottom: "20px" },
  text: { fontSize: "18px", color: "#555", marginBottom: "30px" },
  list: { listStyle: "none", padding: 0 },
  listItem: { marginBottom: "15px" },
};

// 2. Your JSX Component (JavaScript version)
function FrontendLandingPage({ customerId, shop }) {
  return (
    <div style={styles.index}>
      <div id="shopify-company-app-root"></div>

      <link rel="stylesheet" href="https://b2-b-portal-front.vercel.app/embed.css"/>

      <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
      <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
      <script type="module" src="https://b2-b-portal-front.vercel.app/embed.js"></script>
      <script src="https://unpkg.com/@shopify/app-bridge-react/umd/index.umd.production.min.js"></script>

      <script
        dangerouslySetInnerHTML={{
          __html: `
            if (window.ShopifyCompanyApp && window.ShopifyCompanyApp.init) {
              window.ShopifyCompanyApp.init({
                containerId: 'shopify-company-app-root',
                proxyUrl: '/apps/b2b-portal-public/api/proxy',
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

// 3. The Loader that returns the Page for App Proxy
export const loader = async ({ request }) => {
 
  await authenticate.public.appProxy(request);
   const url = new URL(request.url);
        const customerId = url.searchParams.get('logged_in_customer_id');
        const shop = url.searchParams.get('shop');
      

  if (!customerId || !shop) {
    return new Response("Unauthorized", { status: 401 });
  }

  
 const htmlContent = renderToString(
  <FrontendLandingPage 
    customerId={customerId} 
    shop={shop} 
  />
);

  return new Response(htmlContent, {
    headers: {
      "Content-Type": "application/liquid",
    },
  });
};
