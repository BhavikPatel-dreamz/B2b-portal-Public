import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type SortField = "createdAt" | "totalAmount" | "status";
type SortDirection = "asc" | "desc";

function normalizeSortField(value: string | null): SortField {
  switch (value) {
    case "totalAmount":
      return "totalAmount";
    case "status":
      return "status";
    default:
      return "createdAt";
  }
}

function normalizeSortDirection(value: string | null): SortDirection {
  return value === "asc" ? "asc" : "desc";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const search = url.searchParams.get("search") || "";
  const status = url.searchParams.get("status") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";
  const sortField = normalizeSortField(url.searchParams.get("sortField"));
  const sortDirection = normalizeSortDirection(
    url.searchParams.get("sortDirection"),
  );
  const limit = 20;
  const skip = (page - 1) * limit;

  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!store) {
    return Response.json({
      quotes: [],
      totalCount: 0,
      currentPage: 1,
      totalPages: 0,
      searchQuery: "",
      statusFilter: "",
      dateFrom: "",
      dateTo: "",
      sortField: "createdAt" as SortField,
      sortDirection: "desc" as SortDirection,
      statusCounts: {} as Record<string, number>,
    });
  }

  const where: any = { shopId: store.id };

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { quoteNumber: { contains: search, mode: "insensitive" } },
      { customerEmail: { contains: search, mode: "insensitive" } },
      { customerFirstName: { contains: search, mode: "insensitive" } },
      { customerLastName: { contains: search, mode: "insensitive" } },
      { title: { contains: search, mode: "insensitive" } },
      { company: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const orderBy =
    sortField === "totalAmount"
      ? { totalAmount: sortDirection }
      : sortField === "status"
        ? { status: sortDirection }
        : { createdAt: sortDirection };

  const [totalCount, quotes, statusCounts] = await Promise.all([
    prisma.quote.count({ where }),
    prisma.quote.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        company: { select: { id: true, name: true } },
        salesAgent: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    }),
    prisma.quote.groupBy({
      by: ["status"],
      where: { shopId: store.id },
      _count: true,
    }),
  ]);

  const totalPages = Math.ceil(totalCount / limit);

  const statusMap: Record<string, number> = {};
  for (const entry of statusCounts) {
    statusMap[entry.status] = entry._count;
  }

  return Response.json({
    quotes: quotes.map((q) => ({
      id: q.id,
      quoteNumber: q.quoteNumber,
      title: q.title,
      status: q.status,
      totalAmount: q.totalAmount.toString(),
      currencyCode: q.currencyCode,
      customerEmail: q.customerEmail,
      customerFirstName: q.customerFirstName,
      customerLastName: q.customerLastName,
      companyName: q.company.name,
      companyId: q.company.id,
      salesAgentName: [q.salesAgent?.firstName, q.salesAgent?.lastName]
        .filter(Boolean)
        .join(" ") || q.salesAgent?.email || "–",
      createdAt: q.createdAt.toISOString(),
      expiresAt: q.expiresAt.toISOString(),
    })),
    totalCount,
    currentPage: page,
    totalPages,
    searchQuery: search,
    statusFilter: status,
    dateFrom,
    dateTo,
    sortField,
    sortDirection,
    statusCounts: statusMap,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!store) {
    return Response.json({ success: false, errors: ["Store not found"] }, { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const quoteId = String(formData.get("quoteId") || "");

  const quote = quoteId
    ? await prisma.quote.findFirst({
        where: { id: quoteId, shopId: store.id },
        include: { items: true },
      })
    : null;

  if (quoteId && !quote) {
    return Response.json({ success: false, errors: ["Quote not found"] }, { status: 404 });
  }

  try {
    if (intent === "cancel_quote") {
      await prisma.quote.update({
        where: { id: quoteId },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      return Response.json({ success: true, message: "Quote cancelled." });
    }

    if (intent === "delete_quote") {
      await prisma.quote.delete({ where: { id: quoteId } });
      return Response.json({ success: true, message: "Quote deleted." });
    }
  } catch (error) {
    return Response.json(
      { success: false, errors: [error instanceof Error ? error.message : "Action failed"] },
      { status: 400 },
    );
  }

  return Response.json({ success: false, errors: ["Unknown action"] }, { status: 400 });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export { default } from "./app.quotes.page";
