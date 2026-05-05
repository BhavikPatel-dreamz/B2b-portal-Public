import { useEffect } from "react";
import { redirect, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  try {
    const { session } = await authenticate.admin(request);
    const storeName = session.shop.split(".")[0];
    const redirectUrl = `https://admin.shopify.com/store/${storeName}/apps/b2b-portal-public-3/app/home`;
    
    if (shop) {
      return redirect(redirectUrl);
    }
    
    return { redirectUrl };
  } catch (error) {
    // If not authenticated, we just show the login form or handle the shop param
    if (shop) {
       return await login(request);
    }
    return { redirectUrl: null };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  try {
    const { session } = await authenticate.admin(request);
    const storeName = session.shop.split(".")[0];
    return redirect(
      `https://admin.shopify.com/store/${storeName}/apps/b2b-portal-public-3/app/home`
    );
  } catch (error) {
    return await login(request);
  }
};

export default function Auth() {
  const data = useLoaderData<typeof loader>();
  const redirectUrl = data && "redirectUrl" in data ? data.redirectUrl : null;

  useEffect(() => {
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  }, [redirectUrl]);

  return null;
}
