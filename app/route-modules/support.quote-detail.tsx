import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import {
  action as quoteAction,
  loader as quoteLoader,
  default as QuoteDetailPage,
} from "../routes/sales.portal.company.$companyId.quotes.$quoteId";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const prisma = (await import("app/db.server")).default;
  const quoteId = params.quoteId;
  if (!quoteId) {
    return redirect("/sales/portal");
  }

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId },
    select: { companyId: true },
  });

  if (!quote) {
    throw new Response("Quote not found", { status: 404 });
  }

  return quoteLoader({
    request,
    params: { ...params, companyId: quote.companyId, quoteId },
  } as LoaderFunctionArgs);
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const prisma = (await import("app/db.server")).default;
  const quoteId = params.quoteId;
  if (!quoteId) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId },
    select: { companyId: true },
  });

  if (!quote) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }

  return quoteAction({
    request,
    params: { ...params, companyId: quote.companyId, quoteId },
  } as ActionFunctionArgs);
};

export default QuoteDetailPage;
