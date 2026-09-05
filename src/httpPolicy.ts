import type { Hono } from "hono";
import { CONFIG } from "./config.js";

export function installHttpPolicy(app: Hono): void {
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      let allowed = CONFIG.ALLOWED_ORIGINS.includes(origin);
      try { allowed ||= new URL(origin).host === new URL(c.req.url).host; } catch {}
      if (!allowed) return c.json({ error: "Origin is not allowed" }, 403);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Event-ID");
      return c.body(null, 204);
    }
    await next();
  });
}
