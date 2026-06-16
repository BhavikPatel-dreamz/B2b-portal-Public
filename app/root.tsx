import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import polarisStylesUrl from "@shopify/polaris/build/esm/styles.css?url";

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
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
        <script src="https://cdn.jotfor.ms/agent/embedjs/019ecfaeeeb57d26b7268d5a50ec2091d903/embed.js" defer></script>
      </body>
    </html>
  );
}
