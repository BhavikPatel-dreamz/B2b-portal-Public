type AdminGraphQLClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type GraphQLError = { message?: string; extensions?: Record<string, unknown> };

export class ShopifyOrderCreationError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly requestId?: string | null,
  ) {
    super(message);
    this.name = "ShopifyOrderCreationError";
  }
}

export async function shopifyOrderGraphql<T>({
  admin,
  operation,
  query,
  variables,
}: {
  admin: AdminGraphQLClient;
  operation: string;
  query: string;
  variables: Record<string, unknown>;
}): Promise<T> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await admin.graphql(query, { variables });
  } catch (error) {
    console.error("[shopify-order] transport failure", {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ShopifyOrderCreationError(
      `Shopify could not be reached while running ${operation}. Please try again.`,
      operation,
    );
  }

  const requestId = response.headers.get("x-request-id");
  let payload: { data?: T; errors?: GraphQLError[] };
  try {
    payload = await response.json();
  } catch {
    throw new ShopifyOrderCreationError(
      `Shopify returned an unreadable response for ${operation}.`,
      operation,
      requestId,
    );
  }

  console.info("[shopify-order] graphql response", {
    operation,
    ok: response.ok,
    status: response.status,
    requestId,
    durationMs: Date.now() - startedAt,
    errorCount: payload.errors?.length || 0,
  });

  if (!response.ok || payload.errors?.length) {
    const message =
      payload.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") || `Shopify returned HTTP ${response.status}`;
    console.error("[shopify-order] graphql failure", {
      operation,
      requestId,
      status: response.status,
      errors: payload.errors,
    });
    throw new ShopifyOrderCreationError(message, operation, requestId);
  }
  if (!payload.data) {
    throw new ShopifyOrderCreationError(
      `Shopify returned no data for ${operation}.`,
      operation,
      requestId,
    );
  }
  return payload.data;
}

function userErrorMessage(
  errors: Array<{ field?: string[] | null; message: string }>,
) {
  return errors
    .map(
      (error) =>
        `${error.field?.join(".") ? `${error.field.join(".")}: ` : ""}${error.message}`,
    )
    .join("; ");
}

export function assertNoShopifyUserErrors(
  operation: string,
  errors: Array<{ field?: string[] | null; message: string }> | undefined,
) {
  if (errors?.length) {
    console.error("[shopify-order] mutation user errors", {
      operation,
      errors,
    });
    throw new ShopifyOrderCreationError(userErrorMessage(errors), operation);
  }
}

async function retry<T>(operation: string, callback: () => Promise<T | null>) {
  const delays = [0, 250, 750, 1500];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
  }
  console.error("[shopify-order] verification failed", {
    operation,
    error:
      lastError instanceof Error
        ? lastError.message
        : String(lastError || "not found"),
  });
  throw new ShopifyOrderCreationError(
    `Shopify accepted ${operation}, but the result could not be verified. Check Shopify Admin before retrying.`,
    operation,
  );
}

export async function verifyShopifyDraftOrder(
  admin: AdminGraphQLClient,
  id: string,
) {
  return retry("draft order creation", async () => {
    const data = await shopifyOrderGraphql<{
      draftOrder: null | {
        id: string;
        name: string;
        status: string;
        createdAt: string;
        order: { id: string; name: string } | null;
      };
    }>({
      admin,
      operation: "VerifyDraftOrder",
      query: `#graphql
        query VerifyDraftOrder($id: ID!) {
          draftOrder(id: $id) {
            id name status createdAt
            order { id name }
          }
        }
      `,
      variables: { id },
    });
    return data.draftOrder;
  });
}

export async function verifyShopifyOrder(
  admin: AdminGraphQLClient,
  id: string,
) {
  return retry("order creation", async () => {
    const data = await shopifyOrderGraphql<{
      order: null | {
        id: string;
        name: string;
        createdAt: string;
        displayFinancialStatus: string | null;
        displayFulfillmentStatus: string;
        cancelledAt: string | null;
      };
    }>({
      admin,
      operation: "VerifyOrder",
      query: `#graphql
        query VerifyOrder($id: ID!) {
          order(id: $id) {
            id name createdAt displayFinancialStatus displayFulfillmentStatus
            cancelledAt
          }
        }
      `,
      variables: { id },
    });
    return data.order;
  });
}

export async function retryLocalOrderSync<T>(
  label: string,
  callback: () => Promise<T>,
) {
  let lastError: unknown;
  for (const delay of [0, 150, 500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      console.warn("[shopify-order] local sync attempt failed", {
        label,
        delay,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError;
}
