import { redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const storeName = session.shop.split(".")[0];
  return redirect(
    `https://admin.shopify.com/store/${storeName}/apps/b2b-portal-public-dev/app/home`
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const storeName = session.shop.split(".")[0];
  return redirect(
    `https://admin.shopify.com/store/${storeName}/apps/b2b-portal-public-dev/app/home`
  );
};

export default function Auth() {
  return null;
}
