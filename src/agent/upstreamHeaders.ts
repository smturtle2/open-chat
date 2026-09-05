import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** Shared identity for inference, catalog refreshes and provider checks. */
export function upstreamHeaders(baseUrl: string, apiKey: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": `OpenChat/${version}` };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const url = new URL(baseUrl);
  if (url.hostname === "opencode.ai") {
    // Inference uses the persisted conversation ID, never a run/request ID.
    // Catalog requests have no conversation; give them a separate stable ID.
    const catalogId = createHash("sha256").update(url.origin + url.pathname.replace(/\/+$/, "")).digest("hex").slice(0, 32);
    headers["x-opencode-session"] = sessionId || `openchat-models-${catalogId}`;
  }
  return headers;
}
