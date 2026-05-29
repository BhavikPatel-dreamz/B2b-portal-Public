import { authenticate } from "app/shopify.server";

type CustomerAccountSessionBase = {
  shop: string;
  sessionToken: Awaited<
    ReturnType<typeof authenticate.public.customerAccount>
  >["sessionToken"];
};

type CustomerAccountSessionWithCustomer = CustomerAccountSessionBase & {
  customerGid: string;
  customerId: string;
};

type CustomerAccountSessionWithoutCustomer = CustomerAccountSessionBase & {
  customerGid?: string;
  customerId?: string;
};

function getShopDomainFromDest(dest: string) {
  try {
    return new URL(dest).hostname;
  } catch {
    return dest.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function getCustomerGidFromSubject(subject: string) {
  return subject.startsWith("gid://")
    ? subject
    : `gid://shopify/Customer/${subject}`;
}

export async function authenticateCustomerAccountSession(
  request: Request,
): Promise<CustomerAccountSessionWithCustomer>;
export async function authenticateCustomerAccountSession(
  request: Request,
  options: { requireCustomer: true },
): Promise<CustomerAccountSessionWithCustomer>;
export async function authenticateCustomerAccountSession(
  request: Request,
  options: { requireCustomer: false },
): Promise<CustomerAccountSessionWithoutCustomer>;
export async function authenticateCustomerAccountSession(
  request: Request,
  options: { requireCustomer?: boolean } = {},
) {
  const { sessionToken } =
    await authenticate.public.customerAccount(request);
  const requireCustomer = options.requireCustomer ?? true;

  if (!sessionToken.dest) {
    throw new Response("Missing shop in session token", {
      status: 401,
      statusText: "Unauthorized",
    });
  }

  if (requireCustomer && !sessionToken.sub) {
    throw new Response("Missing customer in session token", {
      status: 401,
      statusText: "Unauthorized",
    });
  }

  const customerGid = sessionToken.sub
    ? getCustomerGidFromSubject(sessionToken.sub)
    : undefined;

  return {
    shop: getShopDomainFromDest(sessionToken.dest),
    customerGid,
    customerId: customerGid?.replace("gid://shopify/Customer/", ""),
    sessionToken,
  };
}
