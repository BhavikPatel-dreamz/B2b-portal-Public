import { redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return redirect("/app/home");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return redirect("/app/home");
};

export default function Auth() {
  return null;
}
