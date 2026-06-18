import prisma from "app/db.server";

export type SalesSessionUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  shopId: string | null;
  salesCompanies: Array<{
    companyId: string;
    company: {
      id: string;
      name: string;
      shopifyCompanyId: string | null;
      contactEmail: string | null;
    };
  }>;
};

const COOKIE_NAME = "sales_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Parse the sales session token from the request cookie.
 */
export function getSessionTokenFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Build a Set-Cookie header value to persist the session token.
 */
export function buildSessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_DURATION_MS / 1000);
  const isProd = process.env.NODE_ENV === "production";
  return `${COOKIE_NAME}=${token}; Path=/sales; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isProd ? "; Secure" : ""}`;
}

/**
 * Build a Set-Cookie header that clears/expires the session cookie.
 */
export function buildClearSessionCookie(): string {
  const isProd = process.env.NODE_ENV === "production";
  return `${COOKIE_NAME}=; Path=/sales; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;
}

/**
 * Validate the sales session from a cookie-based token.
 * Returns the user with their assigned companies if valid.
 */
export async function validateSalesSession(sessionToken: string | null) {
  if (!sessionToken) {
    return { valid: false as const, error: "No session token provided" };
  }

  const session = await prisma.userSession.findUnique({
    where: { token: sessionToken },
    include: {
      user: {
        include: {
          salesCompanies: {
            include: {
              company: {
                select: {
                  id: true,
                  name: true,
                  shopifyCompanyId: true,
                  contactEmail: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session) {
    return { valid: false as const, error: "Session not found" };
  }

  if (new Date() > new Date(session.expiresAt)) {
    return { valid: false as const, error: "Session expired" };
  }

  if (session.user.role !== "SALES_USER") {
    return { valid: false as const, error: "Not a sales user" };
  }

  return { valid: true as const, user: session.user as SalesSessionUser };
}

/**
 * Check if a sales user has access to a specific company.
 */
export function hasCompanyAccess(user: SalesSessionUser, companyId: string): boolean {
  return user.salesCompanies.some((sc) => sc.companyId === companyId);
}

/**
 * Require a valid sales session. Redirects to /sales/login if invalid.
 * Returns the validated session user.
 */
export async function requireSalesSession(request: Request) {
  const token = getSessionTokenFromCookie(request);
  const result = await validateSalesSession(token);

  if (!result.valid) {
    throw new Response(null, {
      status: 302,
      headers: { Location: "/sales/login" },
    });
  }

  return { user: result.user, sessionToken: token! };
}

/**
 * Create a new session for a sales user and return the token.
 */
export async function createSalesSession(userId: string): Promise<string> {
  const sessionToken = crypto.randomUUID();
  await prisma.userSession.create({
    data: {
      token: sessionToken,
      userId,
      expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
    },
  });
  return sessionToken;
}
