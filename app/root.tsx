import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import polarisStylesUrl from "@shopify/polaris/build/esm/styles.css?url";
import SupportForm from "app/components/SupportForm";
import PageLoader from "app/components/PageLoader";

export const links = () => [{ rel: "stylesheet", href: polarisStylesUrl }];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
        <Meta />
        <Links />
      </head>
      <body>
        <PageLoader />
        <Outlet />
        <ScrollRestoration />
        <Scripts />
        <SupportForm />
      </body>
    </html>
  );
}
