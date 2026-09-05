import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "../src/db/database.js";
import { harness } from "../src/agent/harness.js";
import { tools } from "../src/agent/tools.js";
import { createProvider, fetchUpstreamModels, testProvider } from "../src/agent/providers.js";
import { upstreamHeaders } from "../src/agent/upstreamHeaders.js";

const baseUrl = "https://opencode.ai/zen/go/v1";
const originalFetch = globalThis.fetch;
const originalExecute = tools.executeResult;
const sse = (...events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
function completed(url: string): Response {
  if (url.endsWith("/responses")) return sse({ type: "response.output_text.delta", delta: "Done" }, { type: "response.completed" });
  if (url.endsWith("/messages")) return sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } }, { type: "message_stop" });
  return sse({ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] });
}
function toolCall(url: string): Response {
  const args = JSON.stringify({ path: "." });
  if (url.endsWith("/responses")) return sse(
    { type: "response.output_item.added", output_index: 1, item: { id: "item", call_id: "call", type: "function_call", name: "list_files" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "item", delta: args },
    { type: "response.completed" },
  );
  if (url.endsWith("/messages")) return sse(
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call", name: "list_files" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: args } },
    { type: "message_stop" },
  );
  return sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call", type: "function", function: { name: "list_files", arguments: args } }] }, finish_reason: "tool_calls" }] });
}
function checkHeaders(init: RequestInit | undefined, sessionId: string) {
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("x-opencode-session"), sessionId);
  assert.match(headers.get("user-agent")!, /^OpenChat\/\d/);
  assert.equal(headers.get("authorization"), "Bearer fixture-key");
}

try {
  if (process.argv[2] === "--resume") {
    const sessionId = process.argv[3];
    assert.ok(db.getSession(sessionId), "conversation survives a fresh process");
    let calls = 0;
    globalThis.fetch = async (url, init) => { calls++; checkHeaders(init, sessionId); return completed(String(url)); };
    assert.equal(await harness.runAutonomousLoop(sessionId, "After restart"), "completed");
    assert.equal(calls, 1);
  } else {
    for (const url of ["https://api.anthropic.com/v1", "https://openrouter.ai/api/v1", "http://localhost:1234/v1", "https://opencode.ai.evil.invalid/v1", "https://example.invalid/opencode.ai/zen/go/v1"]) {
      const headers = upstreamHeaders(url, "", "private-conversation");
      assert.equal(headers["x-opencode-session"], undefined);
      assert.equal(headers.Authorization, undefined);
      assert.match(headers["User-Agent"], /^OpenChat\//);
    }
    assert.equal(upstreamHeaders("https://OPENCODE.AI/zen/v1", "", "legacy")["x-opencode-session"], "legacy");

    const provider = createProvider({ name: "OpenCode fixture", base_url: baseUrl, api_key: "fixture-key" });
    const catalogHeaders: string[] = [];
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/models$/);
      const headers = new Headers(init?.headers);
      assert.match(headers.get("user-agent")!, /^OpenChat\//);
      assert.match(headers.get("x-opencode-session")!, /^openchat-models-/);
      catalogHeaders.push(headers.get("x-opencode-session")!);
      return Response.json({ data: [{ id: "glm-5" }] });
    };
    await fetchUpstreamModels(baseUrl, "fixture-key");
    assert.equal((await testProvider(provider.id)).ok, true);
    assert.equal(new Set(catalogHeaders).size, 1);
    assert.equal(upstreamHeaders(baseUrl + "/", "")["x-opencode-session"], catalogHeaders[0]);
    console.log("PASS provider identification, stable catalog headers and exact OpenCode hostname boundary");

    const conversations = new Set<string>();
    for (const [model, route] of [["glm-5", "/chat/completions"], ["muse-spark-test", "/responses"], ["minimax-test", "/messages"]]) {
      const sessionId = randomUUID();
      conversations.add(sessionId);
      db.createSession(sessionId, "Header fixture", model, { provider: provider.id });
      let calls = 0;
      let executed = 0;
      tools.executeResult = async () => { executed++; return { ok: true, observation: "fixture.txt" }; };
      globalThis.fetch = async (url, init) => {
        checkHeaders(init, sessionId);
        assert.equal(String(url), baseUrl + route);
        calls++;
        if (calls === 1) return Response.json({ error: { message: "Retry fixture" } }, { status: 429 });
        return calls === 2 ? toolCall(String(url)) : completed(String(url));
      };
      assert.equal(await harness.runAutonomousLoop(sessionId, "First message"), "completed");
      assert.equal(calls, 3, "retry and tool follow-up must share the conversation header");
      assert.equal(executed, 1);
      assert.equal(await harness.runAutonomousLoop(sessionId, "Second message"), "completed");
      const lastUser = db.getMessages(sessionId).filter(m => m.role === "user").at(-1)!;
      db.truncateAfterMessage(sessionId, lastUser.id);
      assert.equal(await harness.runAssistantTurn(sessionId), "completed", "regeneration keeps the conversation header");
      const restarted = spawnSync(process.execPath, ["--import=tsx", fileURLToPath(import.meta.url), "--resume", sessionId], { encoding: "utf8", env: process.env, timeout: 30_000 });
      assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
      console.log(`PASS ${route}: stable session header across retry, tool turn, next message, regeneration and restart`);
    }
    assert.equal(conversations.size, 3, "different conversations have different IDs");
  }
} finally {
  globalThis.fetch = originalFetch;
  tools.executeResult = originalExecute;
}
