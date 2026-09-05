import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";

// Exercise persisted generation instead of the runner's environment token.
process.env.OPENCHAT_AUTH_TOKEN = "";
const { CONFIG } = await import("../src/config.js");
const { getAuthToken, installAuth } = await import("../src/auth.js");
const token = getAuthToken();
assert.equal(token.length, 64);
assert.equal(fs.statSync(CONFIG.AUTH_TOKEN_PATH).mode & 0o777, 0o600);
const cli = spawnSync(process.execPath, ["--import=tsx", "src/token.ts"], { env: process.env, encoding: "utf8" });
assert.equal(cli.status, 0); assert.equal(cli.stdout.trim(), token);
const app = new Hono(); installAuth(app);
app.get("/api/private", c => c.json({ ok: true }));
for (let i = 0; i < 10; i++) {
  assert.equal((await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"token":"wrong"}' })).status, 401);
}
const limited = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
assert.equal((await app.request("/api/private", { headers: { Authorization: "Bearer " + token } })).status, 200);
console.log("PASS generated access key persistence, file permissions, CLI and login rate limit");
