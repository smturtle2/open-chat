import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hono, Context } from "hono";
import { CONFIG } from "./config.js";

const COOKIE = "openchat_session";
const SESSION_SECONDS = 7 * 86400;
let cachedToken: string | undefined;

export function getAuthToken(): string {
  if (cachedToken) return cachedToken;
  if (CONFIG.AUTH_TOKEN) {
    if (CONFIG.AUTH_TOKEN.length < 16) throw new Error("OPENCHAT_AUTH_TOKEN must contain at least 16 characters");
    return cachedToken = CONFIG.AUTH_TOKEN;
  }
  fs.mkdirSync(path.dirname(CONFIG.AUTH_TOKEN_PATH), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(CONFIG.AUTH_TOKEN_PATH, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
  const token = fs.readFileSync(CONFIG.AUTH_TOKEN_PATH, "utf8").trim();
  if (token.length < 16) throw new Error("The stored OpenChat access token is invalid");
  fs.chmodSync(CONFIG.AUTH_TOKEN_PATH, 0o600);
  return cachedToken = token;
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signature(value: string, token: string): string {
  return crypto.createHmac("sha256", token).update(value).digest("base64url");
}

function authenticated(c: Context, token: string): boolean {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer ") && equal(authorization.slice(7), token)) return true;
  const cookie = (c.req.header("cookie") || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const [expiry, nonce, mac, extra] = cookie.split(".");
  if (extra || !expiry || !nonce || !mac || Number(expiry) <= Date.now()) return false;
  return equal(mac, signature(expiry + "." + nonce, token));
}

function cookieOptions(c: Context): string {
  const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
  return "; Path=/; HttpOnly; SameSite=Strict" + (secure ? "; Secure" : "");
}

export function installAuth(app: Hono, token = getAuthToken()): void {
  const attempts = new Map<string, { count: number; until: number }>();
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      let allowed = CONFIG.ALLOWED_ORIGINS.includes(origin);
      try { allowed ||= new URL(origin).host === new URL(c.req.url).host; } catch {}
      if (!allowed) return c.json({ error: "Origin is not allowed" }, 403);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Event-ID");
      return c.body(null, 204);
    }
    if (["/api/auth", "/api/auth/login", "/api/auth/logout"].includes(c.req.path)) return next();
    if (!authenticated(c, token)) return c.json({ error: "Authentication required" }, 401);
    await next();
  });

  app.get("/api/auth", (c) => c.json({ authenticated: authenticated(c, token) }));
  app.post("/api/auth/login", async (c) => {
    const remote = (c.env as any)?.incoming?.socket?.remoteAddress || "client";
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const attempt = attempts.get(remote) || { count: 0, until: now + 60_000 };
    if (attempt.count >= 10) {
      c.header("Retry-After", String(Math.ceil((attempt.until - now) / 1000)));
      return c.json({ error: "잠시 후 다시 시도해 주세요." }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (typeof body?.token !== "string" || !equal(body.token, token)) {
      attempt.count++;
      attempts.set(remote, attempt);
      return c.json({ error: "접속 키가 올바르지 않습니다." }, 401);
    }
    attempts.delete(remote);
    const value = String(now + SESSION_SECONDS * 1000) + "." + crypto.randomBytes(16).toString("hex");
    c.header("Set-Cookie", COOKIE + "=" + value + "." + signature(value, token) + "; Max-Age=" + SESSION_SECONDS + cookieOptions(c));
    return c.json({ authenticated: true });
  });
  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", COOKIE + "=; Max-Age=0" + cookieOptions(c));
    return c.json({ authenticated: false });
  });
}
