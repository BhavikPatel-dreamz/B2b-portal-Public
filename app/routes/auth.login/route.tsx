import { useEffect } from "react";
import { redirect, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const storeName = session.shop.split(".")[0];
  const redirectUrl = `https://admin.shopify.com/store/${storeName}/apps/b2b-portal-public-dev/app/home`;
  
  if (new URL(request.url).searchParams.get("shop")) {
    return redirect(redirectUrl);
  }
  
  return { redirectUrl };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const storeName = session.shop.split(".")[0];
  return redirect(
    `https://admin.shopify.com/store/${storeName}/apps/b2b-portal-public-dev/app/home`
  );
};

export default function Auth() {
  const { redirectUrl } = useLoaderData<typeof loader>() as { redirectUrl: string };

  useEffect(() => {
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  }, [redirectUrl]);

  return null;
}
