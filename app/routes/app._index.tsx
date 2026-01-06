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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );
  const responseJson = await response.json();

  const product = responseJson.data!.productCreate!.product!;
  const variantId = product.variants.edges[0]!.node!.id!;

  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );

  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson!.data!.productCreate!.product,
    variant:
      variantResponseJson!.data!.productVariantsBulkUpdate!.productVariants,
  };
};


export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.product?.id) {
      shopify.toast.show("Product created");
    }
  }, [fetcher.data?.product?.id, shopify]);

  const generateProduct = () => fetcher.submit({}, { method: "POST" });

  // Dummy data for dashboard
  const statsData = [
    { label: 'Total Revenue', value: '$45,231', change: '+12.5%', trend: 'up' },
    { label: 'Total Orders', value: '1,234', change: '+8.2%', trend: 'up' },
    { label: 'Products Sold', value: '3,456', change: '+15.3%', trend: 'up' },
    { label: 'Avg. Order Value', value: '$36.67', change: '+4.1%', trend: 'up' },
  ];

  const ordersData = [
    { id: '#1234', customer: 'John Doe', product: 'Wireless Headphones', amount: '$299.00', status: 'Fulfilled', date: '2025-01-05' },
    { id: '#1233', customer: 'Sarah Smith', product: 'Smart Watch Pro', amount: '$449.00', status: 'Processing', date: '2025-01-05' },
    { id: '#1232', customer: 'Mike Johnson', product: 'Laptop Stand', amount: '$79.00', status: 'Fulfilled', date: '2025-01-04' },
    { id: '#1231', customer: 'Emily Brown', product: 'USB-C Hub', amount: '$59.00', status: 'Pending', date: '2025-01-04' },
    { id: '#1230', customer: 'David Wilson', product: 'Mechanical Keyboard', amount: '$159.00', status: 'Fulfilled', date: '2025-01-03' },
    { id: '#1229', customer: 'Lisa Anderson', product: 'Monitor 27"', amount: '$399.00', status: 'Cancelled', date: '2025-01-03' },
  ];

  const recentActivity = [
    { action: 'New order received', user: 'John Doe', time: '2 minutes ago' },
    { action: 'Product stock updated', user: 'System', time: '15 minutes ago' },
    { action: 'Payment received', user: 'Sarah Smith', time: '1 hour ago' },
    { action: 'New customer registered', user: 'Mike Johnson', time: '2 hours ago' },
  ];

  const getStatusTone = (status) => {
    const tones = {
      'Fulfilled': 'success',
      'Processing': 'info',
      'Pending': 'warning',
      'Cancelled': 'critical',
    };
    return tones[status] || 'default';
  };

  return (
    <s-page heading="Dashboard">
      <s-button slot="primary-action" onClick={generateProduct} variant="primary">
        Generate Product
      </s-button>

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

      {/* Sidebar - Recent Activity */}
      <s-section slot="aside">
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading size="medium">Recent Activity</s-heading>
            
            <s-stack direction="block" gap="base">
              {recentActivity.map((activity, index) => (
                <s-box key={index} style={{ paddingBottom: '12px', borderBottom: index < recentActivity.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                  <s-stack direction="block" gap="extraTight">
                    <s-text weight="semibold">{activity.action}</s-text>
                    <s-text variant="bodySm" tone="subdued">{activity.user}</s-text>
                    <s-text variant="bodySm" tone="subdued">{activity.time}</s-text>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          </s-stack>
        </s-card>
      </s-section>

      {/* Sidebar - Quick Stats */}
      <s-section slot="aside">
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading size="medium">Today's Summary</s-heading>
            
            <s-stack direction="block" gap="base">
              <s-box>
                <s-stack direction="inline" alignment="space-between">
                  <s-text tone="subdued">New Orders</s-text>
                  <s-text weight="bold">24</s-text>
                </s-stack>
              </s-box>
              
              <s-box>
                <s-stack direction="inline" alignment="space-between">
                  <s-text tone="subdued">Revenue Today</s-text>
                  <s-text weight="bold">$2,847</s-text>
                </s-stack>
              </s-box>
              
              <s-box>
                <s-stack direction="inline" alignment="space-between">
                  <s-text tone="subdued">Pending Orders</s-text>
                  <s-text weight="bold">8</s-text>
                </s-stack>
              </s-box>
              
              <s-box>
                <s-stack direction="inline" alignment="space-between">
                  <s-text tone="subdued">Low Stock Items</s-text>
                  <s-text weight="bold" tone="critical">3</s-text>
                </s-stack>
              </s-box>
            </s-stack>
          </s-stack>
        </s-card>
      </s-section>

      {/* Sidebar - App Resources */}
      <s-section slot="aside">
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading size="medium">Resources</s-heading>
            
            <s-unordered-list>
              <s-list-item>
                <s-link
                  href="https://shopify.dev/docs/apps/getting-started/build-app-example"
                  target="_blank"
                >
                  Build an example app
                </s-link>
              </s-list-item>
              <s-list-item>
                <s-link
                  href="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
                  target="_blank"
                >
                  Explore with GraphiQL
                </s-link>
              </s-list-item>
              <s-list-item>
                <s-link
                  href="https://shopify.dev/docs/api/admin-graphql"
                  target="_blank"
                >
                  API Documentation
                </s-link>
              </s-list-item>
            </s-unordered-list>
          </s-stack>
        </s-card>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
