// Shim to supply missing exports from @react-router/node
import { createReadableStreamFromReadable } from "@react-router/node/dist/index.mjs";

export { createReadableStreamFromReadable };

// Lightweight json helper matching React Router signature
export function json(data: unknown, init?: number | ResponseInit) {
  const responseInit = typeof init === "number" ? { status: init } : init;
  return Response.json(data, responseInit);
}
