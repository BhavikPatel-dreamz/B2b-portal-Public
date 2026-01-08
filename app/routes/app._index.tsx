import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};




export default function Index() {

  // Dummy data for dashboard
  const statsData = [
    { label: 'Total Revenue', value: '$45,231', change: '+12.5%', trend: 'up' },
    { label: 'Total Orders', value: '1,234', change: '+8.2%', trend: 'up' },
    { label: 'Products Sold', value: '3,456', change: '+15.3%', trend: 'up' },
    { label: 'Avg. Order Value', value: '$36.67', change: '+4.1%', trend: 'up' },
  ];


  return (
    <s-page heading="Dashboard">
      {/* Stats Cards */}
      <s-section>
        <s-stack direction="inline" gap="base" wrap="wrap">
          {statsData.map((stat, index) => (
            <s-card key={index} style={{ flex: '1 1 calc(25% - 12px)', minWidth: '200px' }}>
              <s-stack direction="block" gap="small">
                <s-text variant="bodyMd" tone="subdued">{stat.label}</s-text>
                <s-text variant="heading2xl" weight="bold">{stat.value}</s-text>
                <s-badge tone="success">{stat.change}</s-badge>
              </s-stack>
            </s-card>
          ))}
        </s-stack>
      </s-section>




    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
