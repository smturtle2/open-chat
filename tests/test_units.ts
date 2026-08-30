// Unit tests for the settings/provider/filesys/prompt layers.
// Run: npx tsx tests/test_units.ts  (uses a throwaway SQLite DB)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// Isolated DB + isolated roots must be configured before importing the app
// modules (config is read at import time).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-units-"));
process.env.OPENCHAT_DB_PATH = path.join(tmp, "test.db");
process.env.OPENCHAT_WORKSPACE_ROOT = path.join(tmp, "workspace");
process.env.OPENCHAT_SKILLS_DIR = path.join(tmp, "skills");
delete process.env.LLM_API_KEY;

const { seedBootstrapProvider, createProvider, updateProvider, deleteProvider, resolveEndpoint, getSettings, updateSettings, PROVIDER_PRESETS, fetchUpstreamModels, listModelGroups } = await import("../src/agent/providers.js");
const database = await import("../src/db/database.js");
const db = database.db;
const { fsOp, viewImage } = await import("../src/agent/filesys.js");
const { buildSystemPrompt } = await import("../src/agent/prompt.js");

fs.mkdirSync(path.join(process.env.OPENCHAT_SKILLS_DIR!, "my-skill"), { recursive: true });
fs.writeFileSync(path.join(process.env.OPENCHAT_SKILLS_DIR!, "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\nbody");
fs.mkdirSync(path.join(tmp, "proj"), { recursive: true });
fs.writeFileSync(path.join(tmp, "proj", "hello.txt"), "alpha beta gamma");
fs.writeFileSync(path.join(tmp, "proj", "big.txt"), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");

// Tiny OpenAI-compatible /models upstream for catalog-fetch testing.
async function startMockGateway(): Promise<{ url: string; close: () => void }> {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [
      { id: "mock/large", name: "Mock Large" },
      { id: "mock/small" },
    ] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}/v1`, close: () => server.close() };
}

async function main() {
  // ---- providers: bootstrap seeding --------------------------------------
  seedBootstrapProvider();
  const seeded = database.db.getProvider("opencode");
  check("bootstrap provider seeded", !!seeded && seeded.enabled);
  check("bootstrap default set", getSettings().default_provider === "opencode");

  // ---- CRUD --------------------------------------------------------------
  const gateway = await startMockGateway();
  const created = createProvider({
    name: "Custom GW",
    base_url: `${gateway.url}/`,
    api_key: "sk-custom",
    enabled: true,
  });
  check("provider slugified + trailing slash trimmed", created.id === "custom-gw" && created.base_url.endsWith("/v1"));

  check("invalid base_url rejected", (() => {
    try { createProvider({ name: "X", base_url: "ftp://nope", api_key: "k" }); return false; }
    catch { return true; }
  })());

  // ---- models fetched from the gateway -------------------------------------
  const models = await fetchUpstreamModels(created.base_url, created.api_key);
  check("upstream catalog parsed", models.length === 2 && models[0].name === "Mock Large" && !models[1].name);

  const groups = await listModelGroups();
  const gwGroup = groups.find((g) => g.provider_id === created.id);
  check("model group auto-populated", !!gwGroup && gwGroup.models.length === 2);
  gateway.close();

  // ---- resolution precedence ---------------------------------------------
  updateProvider("opencode", { api_key: "sk-env" }); // keyed enabled provider
  updateSettings({ default_provider: "opencode", default_model: "muse-x" });

  const direct = resolveEndpoint({ provider: "opencode", model: "muse-y" });
  check("session override wins", direct.model === "muse-y" && direct.apiKey === "sk-env");

  updateSettings({});
  const viaDefaults = resolveEndpoint({ provider: null, model: null });
  check("defaults used as fallback", viaDefaults.providerId === "opencode" && viaDefaults.model === "muse-x");

  const disabled = updateProvider("opencode", { enabled: false })!;
  const skipDisabled = resolveEndpoint({ provider: "opencode", model: "muse-x" });
  check("disabled provider skipped", skipDisabled.providerId !== "opencode");
  updateProvider("opencode", { enabled: disabled.enabled });

  deleteProvider(created.id);
  check("delete removes provider", !db.getProvider(created.id));
  check("presets: opencode-go + openrouter only",
    PROVIDER_PRESETS.length === 2 &&
    PROVIDER_PRESETS[0].name === "OpenCode Go" &&
    PROVIDER_PRESETS.some((p) => p.id === "openrouter"));

  // ---- filesys -------------------------------------------------------------
  const root = path.join(tmp, "proj");
  const read = await fsOp(root, { op: "read", path: "hello.txt" });
  check("read relative", read.includes("alpha beta gamma"), read);

  const paged = await fsOp(root, { op: "read", path: "big.txt", offset: 1, limit: 5 });
  check("read paging note", paged.includes("lines 1-5 of 20") && paged.includes("offset=6"), paged);
  const nextPage = await fsOp(root, { op: "read", path: "big.txt", offset: 6, limit: 5 });
  check("read next page", nextPage.includes("line 6") && !nextPage.includes("line 1\n"), nextPage);

  const blocked = await fsOp(root, { op: "read", path: "/etc/passwd" });
  check("absolute escape blocked", blocked.startsWith("Error:"), blocked);

  const traversal = await fsOp(root, { op: "read", path: "../../etc/passwd" });
  check("traversal blocked", traversal.startsWith("Error:"), traversal);

  const skillRead = await fsOp(root, { op: "read", path: "/opt/skills/my-skill/SKILL.md" });
  check("skills prefix maps to SKILLS_DIR", skillRead.includes("body"), skillRead);

  const wsRead = await fsOp(root, { op: "read", path: "/workspace/hello.txt" });
  check("workspace prefix maps to rootDir", wsRead.includes("alpha beta gamma"), wsRead);

  const wsWrite = await fsOp(root, { op: "write", path: "/workspace/sub/dir/ws_new.txt", content: "ws_made" });
  check("workspace write creates file in rootDir", wsWrite.includes('File "sub/dir/ws_new.txt"'));

  const write = await fsOp(root, { op: "write", path: "sub/dir/new.txt", content: "made" });
  check("write creates dirs", write.includes('File "sub/dir/new.txt"'));

  const patch1 = await fsOp(root, { op: "patch", path: "hello.txt", target: "beta", replacement: "BETA" });
  check("patch once", patch1.includes("patched successfully"));
  const patch2 = await fsOp(root, { op: "patch", path: "hello.txt", target: "a", replacement: "X" });
  check("patch ambiguous refused", patch2.toLowerCase().includes("matched") || patch2.toLowerCase().includes("not found"), patch2);

  const imgErr = await viewImage(root, "missing.png");
  check("view_image missing error", String(imgErr).includes("not found"));

  // ---- prompt ---------------------------------------------------------------
  const chatPrompt = buildSystemPrompt({ mode: "chat", rootDir: "/ws" }).content;
  const agentPrompt = buildSystemPrompt({ mode: "agent", rootDir: "/home/u/proj" }).content;
  check("general-purpose identity", chatPrompt.includes("general-purpose AI assistant"));
  check("coding-agent identity removed", !chatPrompt.includes("software engineering agent"));
  check("chat env mentions sandbox", chatPrompt.includes("/workspace"));
  check("agent env shows workdir + caution", agentPrompt.includes("/home/u/proj") && agentPrompt.includes("real directory"));
  check("skills section listed when installed", chatPrompt.includes("# Skills:") && chatPrompt.includes("my-skill"));
  check("history/tools sections kept", chatPrompt.includes("# History convention:") && chatPrompt.includes("`bash`"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();



