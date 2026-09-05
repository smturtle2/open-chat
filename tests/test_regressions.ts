import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app } from "../src/app.js";
import { CONFIG } from "../src/config.js";
import { db } from "../src/db/database.js";
import { harness, ToolCircuitBreaker } from "../src/agent/harness.js";
import { SessionCoordinator } from "../src/agent/coordinator.js";
import { ToolCallAssembler } from "../src/agent/toolCalls.js";
import { scheduleTools } from "../src/agent/toolScheduler.js";
import { buildHistory } from "../src/agent/context.js";
import { parseStreamData } from "../src/agent/protocols.js";
import { createProvider, listModelGroups, resolveEndpoint, isProviderUsable } from "../src/agent/providers.js";
import { chatWorkspaceDir, pruneWorkspaces, purgeWorkspaceTrash, workspaceState } from "../src/agent/sessionPaths.js";
import { runHostProc, formatExec, cleanupAllContainers } from "../src/agent/exec.js";
import { tools } from "../src/agent/tools.js";
import { parseSingleToolArguments } from "../src/agent/jsonUtils.js";

const request = (url: string, init: RequestInit = {}) => app.request(url, init);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ data: [{ id: "local-test", context_length: 32000 }] });
try {
  for (const route of ["/api/sessions", "/api/providers", "/api/models"]) {
    assert.equal((await app.request(route)).status, 200, route);
  }
  assert.equal((await request("/api/providers", { headers: { Origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await request("/api/auth")).status, 404);
  assert.equal((await request("/api/auth/login", { method: "POST" })).status, 404);
  assert.ok(!fs.existsSync(path.join(process.env.OPENCHAT_HOME!, "auth-token")));
  const provider = createProvider({ name: "secret-provider", base_url: "http://localhost:9999/v1", api_key: "must-never-leak" });
  const patched = await request(`/api/providers/${provider.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "renamed" }) });
  assert.equal(patched.status, 200);
  assert.ok(!(await patched.text()).includes("must-never-leak"));
  assert.equal(db.getProvider(provider.id)?.api_key, "must-never-leak");
  const local = createProvider({ name: "local-provider", base_url: "http://127.0.0.1:9999/v1" });
  const groups = await listModelGroups();
  assert.ok(groups.some(g => g.provider_id === local.id && g.models[0]?.id === "local-test"));
  assert.equal(resolveEndpoint({ provider: local.id, model: "local-test" }).contextWindow, 32000);
  assert.equal(isProviderUsable({ ...local, base_url: "https://localhost.evil.invalid" }), false);
  assert.equal(isProviderUsable({ ...local, base_url: "https://127.evil.invalid" }), false);
  for (const route of ["files", "files/x.html", "events"]) assert.equal((await request(`/api/sessions/unknown/${route}`)).status, 404);
  assert.ok(!fs.existsSync(path.join(CONFIG.WORKSPACES_ROOT, "unknown")));
  console.log("PASS direct API access, origin checks, provider masking, local catalog and unknown-session confinement");

  const session = db.createSession("regression", "regression");
  const root = chatWorkspaceDir(session.id);
  fs.writeFileSync(path.join(root, "preview.html"), "<script>fetch('/api/providers')</script>");
  const file = await request(`/api/sessions/${session.id}/files/preview.html`);
  assert.equal(file.status, 200); assert.match(file.headers.get("content-security-policy")!, /^sandbox /);
  db.createRun("snapshot-run", session.id);
  db.setRunStatus("snapshot-run", "running");
  db.appendEvent(session.id, "thought_delta", { delta: "reasoning" }, "snapshot-run");
  db.appendEvent(session.id, "content_delta", { delta: "partial" }, "snapshot-run");
  db.appendEvent(session.id, "tool_executing", { id: "t", name: "read_file", args: { path: "x" } }, "snapshot-run");
  const snapshot = await (await request(`/api/sessions/${session.id}`)).json();
  assert.equal(snapshot.run.content, "partial"); assert.equal(snapshot.run.thought, "reasoning"); assert.equal(snapshot.run.tools[0].id, "t");
  pruneWorkspaces(0);
  assert.ok(fs.existsSync(root), "active workspace survives zero retention");
  db.finishRun(session.id, "snapshot-run", "completed");
  pruneWorkspaces(0);
  assert.equal(workspaceState(db.getSession(session.id)!), "archived");
  assert.equal(fs.readFileSync(path.join(chatWorkspaceDir(session.id), "preview.html"), "utf8"), "<script>fetch('/api/providers')</script>");
  pruneWorkspaces(0);
  assert.ok(purgeWorkspaceTrash(Date.now() + 8 * 86400_000) > 0);
  assert.equal(workspaceState(db.getSession(session.id)!), "missing");
  console.log("PASS streaming snapshot, active workspace retention, archive restore and grace-period purge");

  const recs: any[] = [{ role: "user", content: "ORIGINAL REQUEST" }];
  for (let i = 0; i < 110; i++) recs.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "x".repeat(600) }) } }] }, { role: "tool", tool_call_id: `c${i}`, name: "bash", content: "result", tool_status: { ok: true } });
  const history = buildHistory(recs, { budgetTokens: 1000, maxRecords: 200 });
  assert.equal(history.messages[0].content, "ORIGINAL REQUEST"); assert.ok(history.messages.length <= 200); assert.ok(history.stats.tokensKept <= 1000);
  const ids = new Set(history.messages.flatMap(m => m.tool_calls?.map((t: any) => t.id) || []));
  for (const m of history.messages) if (m.role === "tool") assert.ok(ids.has(m.tool_call_id));
  assert.ok(buildHistory(recs, { maxRecords: 200 }).messages.some(m => m.content === "ORIGINAL REQUEST"));
  console.log("PASS total context budget, task pinning beyond 200 records and tool pairing");

  for (const protocol of ["anthropic-messages", "openai-responses"] as const) {
    const assembler = new ToolCallAssembler();
    const chunks = protocol === "anthropic-messages" ? [
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tc-1", name: "bash", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd":"echo ok"}' } },
    ] : [
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "item-1", call_id: "tc-1", name: "bash", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "item-1", delta: '{"cmd":"echo ok"}' },
    ];
    for (const chunk of chunks) { const event = parseStreamData(protocol, JSON.stringify(chunk)); for (const tc of event?.toolCalls || (event?.toolCall ? [event.toolCall] : [])) assembler.add(tc); }
    assert.deepEqual(assembler.values(), [{ id: "tc-1", name: "bash", arguments: '{"cmd":"echo ok"}' }]);
  }
  const order: string[] = [];
  let reads = 0, maxReads = 0;
  const calls = ["read_file", "list_files", "write_file", "read_file"].map(name => ({ function: { name } }));
  const scheduled = await scheduleTools(calls, async call => {
    const name = call.function.name; order.push("start:" + name);
    if (name === "write_file") assert.equal(reads, 0);
    else { maxReads = Math.max(maxReads, ++reads); await delay(5); reads--; }
    order.push("end:" + name); return name;
  });
  assert.equal(maxReads, 2); assert.deepEqual(scheduled, calls.map(c => c.function.name));
  assert.ok(order.indexOf("end:write_file") < order.lastIndexOf("start:read_file"));
  console.log("PASS nonzero tool indexes for both protocols and read/write scheduling barriers");
  assert.deepEqual(parseSingleToolArguments('{cmd: "echo ok",}'), { cmd: "echo ok" });
  assert.deepEqual(parseSingleToolArguments('{"cmd":"first"}{"cmd":"second"}'), { raw: '{"cmd":"first"}{"cmd":"second"}' });
  assert.deepEqual(parseSingleToolArguments('null'), { raw: 'null' });

  const proc = await runHostProc(["bash", "-c", "exit 1"], CONFIG.WORKSPACES_ROOT, { timeoutMs: 1000, label: "test" });
  const breaker = new ToolCircuitBreaker();
  for (let i = 0; i < 5; i++) breaker.intercept("bash", { cmd: "exit 1" }, formatExec(proc));
  assert.ok(breaker.shouldAbort("bash", { cmd: "exit 1" }));
  const interleaved = new ToolCircuitBreaker();
  for (let i = 0; i < 5; i++) { interleaved.intercept("read_file", { path: "x" }, "ok"); interleaved.intercept("bash", { cmd: "exit 1" }, formatExec(proc)); }
  assert.ok(interleaved.shouldAbort("bash", { cmd: "exit 1" }));
  const controller = new AbortController();
  const marker = path.join(CONFIG.WORKSPACES_ROOT, "must-not-exist");
  const running = runHostProc(["bash", "-c", 'sleep 0.3; touch "$1"', "test", marker], CONFIG.WORKSPACES_ROOT, { timeoutMs: 5000, signal: controller.signal, label: "abort" });
  await delay(40); controller.abort(); assert.equal((await running).interrupted, true);
  await delay(350); assert.ok(!fs.existsSync(marker));
  const invalid = await tools.executeResult("bash", { cmd: 123 }, { sessionId: session.id, mode: "agent", cwd: CONFIG.WORKSPACES_ROOT });
  assert.equal(invalid.ok, false);
  const originalContainer = (tools as any).requireContainer;
  (tools as any).requireContainer = async () => { throw new Error("Docker unavailable"); };
  try {
    const blocked = await tools.executeResult("bash", { cmd: "touch must-not-exist" }, { sessionId: session.id, mode: "chat", cwd: CONFIG.WORKSPACES_ROOT });
    assert.equal(blocked.ok, false); assert.ok(!fs.existsSync(marker));
  } finally { (tools as any).requireContainer = originalContainer; }
  console.log("PASS real exit status breaker, process-tree cancellation and invalid arguments");

  const modelFetch = globalThis.fetch;
  const malformed = db.createSession("malformed", "malformed", "local-test", { provider: local.id });
  db.addMessage({ id: "malformed-user", session_id: malformed.id, role: "user", content: "test" });
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"bad-call","function":{"arguments":"{\\"cmd\\":\\"echo forbidden\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
  try {
    assert.equal(await harness.runAssistantTurn(malformed.id), "failed");
    assert.equal(db.getMessages(malformed.id).length, 1, "malformed calls must not poison persisted history");
    assert.equal(db.getSession(malformed.id)?.status, "idle");
  } finally { globalThis.fetch = modelFetch; }
  console.log("PASS unnamed tool call is rejected without executing or persisting it");

  const dockerBin = path.join(CONFIG.WORKSPACES_ROOT, "fake-bin");
  fs.mkdirSync(dockerBin);
  fs.writeFileSync(path.join(dockerBin, "docker"), '#!/bin/sh\nif [ "$1" = "ps" ]; then\n  printf "oc_sb_regression\\noc_sb_other_instance\\n"\nelse\n  printf "%s\\n" "$@" > "$OPENCHAT_WORKSPACE_ROOT/removed-containers"\nfi\n', { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = dockerBin + path.delimiter + originalPath;
  try { await cleanupAllContainers([session.id]); } finally { process.env.PATH = originalPath; }
  assert.equal(fs.readFileSync(path.join(CONFIG.WORKSPACES_ROOT, "removed-containers"), "utf8"), "rm\n-f\noc_sb_regression\n");
  console.log("PASS startup container cleanup is confined to sessions in this database");

  const originalRun = harness.runAutonomousLoop;
  const events: string[] = [];
  let concurrent = 0;
  harness.runAutonomousLoop = async (_id, prompt, signal) => {
    assert.equal(++concurrent, 1, "runs must never overlap"); events.push("start:" + prompt);
    if (!signal?.aborted) await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
    await delay(25); events.push("cleaned:" + prompt); concurrent--;
    return "interrupted";
  };
  try {
    const coordinator = new SessionCoordinator();
    coordinator.submit(session.id, "first"); await delay(5);
    coordinator.interrupt(session.id);
    coordinator.submit(session.id, "second");
    await delay(60);
    assert.deepEqual(events.slice(0, 3), ["start:first", "cleaned:first", "start:second"]);
    const third = coordinator.submit(session.id, "third");
    coordinator.submit(session.id, "fourth");
    await coordinator.interruptAndWait(session.id);
    assert.ok(!events.includes("start:third"));
    assert.equal((db as any).prepare("SELECT status FROM runs WHERE id = ?").get(third).status, "interrupted");
    assert.equal(db.getSession(session.id)?.status, "idle");
    assert.equal(coordinator.isRunning(session.id), false);
  } finally { harness.runAutonomousLoop = originalRun; }
  db.createRun("crashed", session.id); db.recoverInterruptedRuns();
  assert.equal(db.getRunSnapshot(session.id)?.status, "interrupted");
  console.log("PASS Stop→submit cleanup serialization, superseded queued runs and restart recovery");
} finally { globalThis.fetch = originalFetch; }
