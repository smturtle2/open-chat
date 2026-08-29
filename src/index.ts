import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { db } from "./db/database.js";
import { coordinator } from "./agent/coordinator.js";
import { eventBus } from "./agent/eventBus.js";
import { sniffImageMime } from "./agent/tools.js";
import { listSkills, syncBuiltinSkills } from "./agent/skills.js";
import { tools } from "./agent/tools.js";
import { chatWorkspaceDir, sessionRoot, sessionMode, uploadsAbsDir, uploadsRelDir, pruneWorkspaces, deleteChatWorkspace } from "./agent/sessionPaths.js";
import {
  createProvider,
  deleteProvider,
  getSettings,
  listModelGroups,
  listProviders,
  seedBootstrapProvider,
  testProvider,
  updateProvider,
  updateSettings,
  warmModelCache,
} from "./agent/providers.js";
import type { SessionRecord } from "./db/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = new Hono();

app.use("*", cors());

// API: Sessions
app.get("/api/sessions", (c) => {
  const sessions = db.listSessions();
  return c.json(sessions);
});

// API: Skills
app.get("/api/skills", (c) => {
  return c.json(listSkills().map(({ name, description }) => ({ name, description })));
});

// API: Unified model catalog across all enabled providers (grouped).
// Models come from each gateway's own /models endpoint (TTL-cached).
app.get("/api/models", async (c) => {
  const settings = getSettings();
  const groups = await listModelGroups();
  // The default is only actionable if its provider actually exposes the model.
  const defaultUsable = groups.some(
    (g) => g.provider_id === settings.default_provider && g.models.some((m) => m.id === settings.default_model)
  );
  return c.json({
    groups,
    default: defaultUsable ? { provider: settings.default_provider, model: settings.default_model } : null,
  });
});

// ---- Provider management ----------------------------------------------------

const maskKey = (key: string) => (key ? `…${key.slice(-4)}` : "");

app.get("/api/providers", (c) => {
  return c.json(
    listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      enabled: p.enabled,
      models: p.models,
      has_key: !!p.api_key,
      key_hint: maskKey(p.api_key),
    }))
  );
});

app.post("/api/providers", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const provider = createProvider(body);
    if (provider.api_key) warmModelCache(provider.id);
    return c.json(provider, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Invalid provider" }, 400);
  }
});

app.patch("/api/providers/:id", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const provider = updateProvider(c.req.param("id"), body);
    if (!provider) return c.json({ error: "Provider not found" }, 404);
    if (provider.api_key) warmModelCache(provider.id);
    return c.json(provider);
  } catch (err: any) {
    return c.json({ error: err.message || "Invalid provider" }, 400);
  }
});

app.delete("/api/providers/:id", (c) => {
  if (!deleteProvider(c.req.param("id"))) return c.json({ error: "Provider not found" }, 404);
  return c.json({ success: true });
});

app.post("/api/providers/:id/test", async (c) => {
  return c.json(await testProvider(c.req.param("id")));
});

// ---- App settings ------------------------------------------------------------

app.get("/api/settings", (c) => c.json(getSettings()));

app.put("/api/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(updateSettings(body));
});

// ---- Working directory validation (agent sessions) ---------------------------

app.get("/api/workdir/validate", (c) => {
  const raw = (c.req.query("path") || "").trim();
  if (!raw) return c.json({ ok: false, error: "경로를 입력해 주세요" });
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(raw));
  } catch {
    return c.json({ ok: false, error: "존재하지 않는 경로입니다" });
  }
  try {
    if (!fs.statSync(real).isDirectory()) return c.json({ ok: false, error: "디렉토리가 아닙니다" });
  } catch {
    return c.json({ ok: false, error: "접근할 수 없는 경로입니다" });
  }
  return c.json({ ok: true, real_path: real });
});

app.post("/api/sessions", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = "chat_" + Math.random().toString(36).substring(2, 11);
  const title = body.title || "New Chat";
  const model = body.model || getSettings().default_model || CONFIG.LLM_MODEL;
  const mode = body.mode === "agent" ? "agent" : "chat";

  let workdir: string | null = null;
  if (mode === "agent") {
    const raw = typeof body.workdir === "string" ? body.workdir.trim() : "";
    if (!raw) return c.json({ error: "에이전트 세션에는 작업 디렉토리(workdir)가 필요합니다" }, 400);
    try {
      workdir = fs.realpathSync(path.resolve(raw));
      if (!fs.statSync(workdir).isDirectory()) throw new Error("not a directory");
    } catch {
      return c.json({ error: `유효하지 않은 작업 디렉토리: ${raw}` }, 400);
    }
  }

  const session = db.createSession(id, title, model, { mode, workdir, provider: body.provider || null });
  return c.json({ ...session, last_event_id: 0 });
});

app.get("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = db.getSession(id);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const messages = db.getMessages(id).map((m) => ({
    ...m,
    attachments: db.getMessageAttachments(m.id),
  }));
  const isRunning = coordinator.isRunning(id);
  const lastEventId = db.getLastEventId(id);
  return c.json({ ...session, status: isRunning ? "running" : session.status, messages, last_event_id: lastEventId });
});

app.patch("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  if (body.title) {
    db.updateSessionTitle(id, body.title);
  }
  if (body.model) {
    db.updateSessionModel(id, body.model);
  }
  if (body.provider !== undefined) {
    db.updateSessionProvider(id, body.provider || null);
  }
  const session = db.getSession(id);
  return c.json(session || { success: true });
});

app.delete("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  coordinator.interrupt(id);
  db.deleteSession(id);
  deleteChatWorkspace(id);
  void tools.cleanupContainer(id);
  return c.json({ success: true });
});

// API: Files & Downloads in the session root (chat workspace or agent workdir)
app.get("/api/sessions/:id/files", (c) => {
  const id = c.req.param("id");
  const session = db.getSession(id);
  const rootDir = session ? sessionRoot(session) : chatWorkspaceDir(id);
  if (!fs.existsSync(rootDir)) return c.json({ files: [] });

  const getFilesRecursive = (dir: string, base: string = ""): Array<{ name: string; path: string; size: number }> => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const results: Array<{ name: string; path: string; size: number }> = [];
      for (const entry of entries) {
        // Hidden entries are skipped except our own .openchat uploads dir
        // (agent sessions keep attachments there).
        if (entry.name.startsWith(".")) {
          if (!(sessionMode(session!) === "agent" && base === "" && entry.name === ".openchat")) continue;
        }
        if (entry.name === ".venv" || entry.name === "__pycache__" || entry.name === "node_modules") continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...getFilesRecursive(full, rel));
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          results.push({ name: entry.name, path: rel, size: stat.size });
        }
      }
      return results;
    } catch {
      return [];
    }
  };

  return c.json({ files: getFilesRecursive(rootDir) });
});

// Full archived tool output (fold view for truncated observations in the UI)
app.get("/api/sessions/:id/outputs/:outputId", (c) => {
  const sessionId = c.req.param("id");
  const outputId = Number(c.req.param("outputId"));
  if (!Number.isInteger(outputId) || outputId <= 0) return c.json({ error: "invalid output id" }, 400);
  const rec = db.getToolOutput(sessionId, outputId);
  if (!rec) return c.json({ error: "not found" }, 404);
  return c.json(rec);
});

// Per-tool context breakdown from the usage ledger
app.get("/api/sessions/:id/usage", (c) => {
  return c.json(db.getToolUsage(c.req.param("id")));
});


app.get("/api/sessions/:id/files/:filename{.+}", (c) => {
  const id = c.req.param("id");
  const filename = c.req.param("filename");
  const session: SessionRecord | undefined = db.getSession(id);
  const rootDir = session ? sessionRoot(session) : chatWorkspaceDir(id);

  // Traversal + symlink-safe containment check: resolve real paths and
  // require the target to sit strictly inside the session root.
  let fullReal: string;
  let rootReal: string;
  try {
    fullReal = fs.realpathSync(path.resolve(rootDir, filename));
    rootReal = fs.realpathSync(rootDir);
  } catch {
    return c.text("File not found", 404);
  }
  const rel = path.relative(rootReal, fullReal);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return c.text("File not found", 404);
  }
  if (!fs.existsSync(fullReal) || !fs.statSync(fullReal).isFile()) {
    return c.text("File not found", 404);
  }

  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".zip": "application/zip",
  };

  const ext = path.extname(fullReal).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const fileData = fs.readFileSync(fullReal);

  // Header values are ByteString (Latin-1): non-ASCII filenames (한글 etc.)
  // must ride the RFC 5987 filename* parameter, with an ASCII fallback.
  const base = path.basename(fullReal);
  const asciiFallback = base.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  c.header("Content-Type", contentType);
  c.header(
    "Content-Disposition",
    `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(base)}`
  );
  return c.body(fileData);
});

// API: Attachments — save an upload into the session workspace (uploads/) and
// register it unclaimed; the next message POST claims it by id. Image kind is
// decided by magic bytes, not the extension.
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

app.post("/api/sessions/:id/attachments", async (c) => {
  const id = c.req.param("id");
  const session = db.getSession(id);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "multipart field 'file' is required" }, 400);
  if (file.size === 0) return c.json({ error: "Empty file" }, 400);
  if (file.size > ATTACHMENT_MAX_BYTES) return c.json({ error: "File too large (limit 20MB)" }, 413);

  const buf = Buffer.from(await file.arrayBuffer());
  const sniffedMime = sniffImageMime(buf);
  const kind: "image" | "file" = sniffedMime ? "image" : "file";

  const uploadsDir = uploadsAbsDir(session);
  fs.mkdirSync(uploadsDir, { recursive: true });

  const base = file.name.replace(/[^\w.\-\uAC00-\uD7A3]+/g, "_").slice(-80) || "upload";
  // Give misnamed images their canonical extension so downstream tooling
  // (browsers rendering thumbnails) sees a coherent type.
  let uniqueName = `${Date.now().toString(36)}_${base}`;
  if (kind === "image") {
    const canonicalExt = "." + sniffedMime!.split("/")[1].replace("jpeg", "jpg");
    if (!uniqueName.toLowerCase().endsWith(canonicalExt)) {
      const stripped = uniqueName.replace(/\.[a-zA-Z0-9]+$/, "");
      uniqueName = `${stripped}${canonicalExt}`;
    }
  }
  const absPath = path.join(uploadsDir, uniqueName);
  fs.writeFileSync(absPath, buf);

  const attId = "att_" + Math.random().toString(36).substring(2, 11);
  const relPath = `${uploadsRelDir(session)}/${uniqueName}`;
  db.createAttachment({
    id: attId,
    session_id: id,
    kind,
    name: file.name,
    mime: sniffedMime || file.type || "application/octet-stream",
    size: file.size,
    path: relPath,
  });
  return c.json({ id: attId, kind, name: file.name, path: relPath, size: file.size, mime: sniffedMime || file.type || "application/octet-stream" });
});

// API: Messages & Execution
 app.post("/api/sessions/:id/messages", async (c) => {
   const id = c.req.param("id");
   const session = db.getSession(id);
   if (!session) return c.json({ error: "Session not found" }, 404);

   const body = await c.req.json().catch(() => ({}));
   const prompt = (body.content || "").trim();
   if (!prompt) return c.json({ error: "Content is required" }, 400);

   const attachmentIds: string[] = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((x: any) => typeof x === "string").slice(0, 8) : [];

   // Slash skill hints ("/name instructions") are stored VERBATIM in the
   // transcript — the model resolves them itself via load_skill at turn time.
   // Nothing is stripped or injected here.

   const messages = db.getMessages(id);
   if (messages.length === 0 && session.title === "New Chat") {
     const autoTitle = prompt.slice(0, 30) + (prompt.length > 30 ? "..." : "");
     db.updateSessionTitle(id, autoTitle);
   }

   coordinator.submit(id, prompt, attachmentIds);
   return c.json({ status: "submitted" });
 });

// API: Edit Message and Re-run from that point (Message A -> B -> C: editing B updates B and regenerates B's answer)
app.post("/api/sessions/:id/messages/:messageId/edit", async (c) => {
  const id = c.req.param("id");
  const messageId = c.req.param("messageId");
  const session = db.getSession(id);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const newContent = (body.content || "").trim();
  if (!newContent) return c.json({ error: "Content is required" }, 400);

  // Coordinator waits for the old loop to drain before mutating history.
  coordinator.regenerateFrom(id, messageId, newContent);
  return c.json({ status: "submitted" });
});

// API: Regenerate from specific message ID (Message A -> B -> C: regenerating B keeps B intact and regenerates B's answer)
app.post("/api/sessions/:id/messages/:messageId/regenerate", async (c) => {
  const id = c.req.param("id");
  const messageId = c.req.param("messageId");
  const session = db.getSession(id);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const targetMsg = db.getMessages(id).find((m) => m.id === messageId);
  if (!targetMsg || targetMsg.role !== "user") {
    return c.json({ error: "Target user message not found" }, 404);
  }

  coordinator.regenerateFrom(id, messageId, null);
  return c.json({ status: "submitted" });
});

// API: Interrupt task
app.post("/api/sessions/:id/stop", (c) => {
  const id = c.req.param("id");
  coordinator.interrupt(id);
  db.updateSessionStatus(id, "idle");
  return c.json({ status: "interrupted" });
});

// SSE: Real-Time Event Stream
app.get("/api/sessions/:id/events", (c) => {
  const id = c.req.param("id");
  const lastEventHeader = c.req.header("last-event-id");
  const afterParam = c.req.query("after");
  const rawId = lastEventHeader || afterParam;
  const lastEventId = rawId ? parseInt(rawId, 10) : 0;

  return streamSSE(c, async (stream) => {
    let currentId = isNaN(lastEventId) ? 0 : lastEventId;
    let isActive = true;

    // Serialize all SSE writes through a promise chain to prevent chunk interleaving
    let writeChain: Promise<void> = Promise.resolve();
    const enqueueWrite = (data: { event: string; data: string; id?: string }) => {
      if (!isActive) return;
      writeChain = writeChain
        .then(async () => {
          if (!isActive) return;
          await stream.writeSSE(data);
        })
        .catch(() => {});
    };

    // 1. Subscribe to real-time events first so no events during initial DB fetch are lost
    const liveQueue: any[] = [];
    let historyDone = false;

    const unsubscribe = eventBus.subscribe(id, (event) => {
      if (!isActive) return;
      if (!historyDone) {
        liveQueue.push(event);
      } else if (event.id && event.id > currentId) {
        currentId = event.id;
        enqueueWrite({
          event: event.type,
          data: event.payload,
          id: String(event.id),
        });
      }
    });

    // 2. Flush unread historical events on connect/reconnect
    const initialEvents = db.getEvents(id, currentId);
    for (const event of initialEvents) {
      if (event.id && event.id > currentId) {
        currentId = event.id;
      }
      enqueueWrite({
        event: event.type,
        data: event.payload,
        id: String(event.id),
      });
    }

    // 3. Process buffered live events that arrived during history fetching
    historyDone = true;
    for (const event of liveQueue) {
      if (event.id && event.id > currentId) {
        currentId = event.id;
        enqueueWrite({
          event: event.type,
          data: event.payload,
          id: String(event.id),
        });
      }
    }
    liveQueue.length = 0;

    // 4. Keep-alive ping (every 25s) to keep connections alive across proxies
    const pingTimer = setInterval(() => {
      enqueueWrite({ event: "ping", data: "{}" });
    }, 25000);

    const cleanup = () => {
      if (!isActive) return;
      isActive = false;
      unsubscribe();
      clearInterval(pingTimer);
    };

    stream.onAbort(cleanup);

    // Hold connection open until client disconnects
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        cleanup();
        resolve();
      });
    });
  });
});

// Static frontend serving
const clientDist = path.join(__dirname, "../client/dist");
if (fs.existsSync(clientDist)) {
  app.use("/*", serveStatic({ root: "./client/dist" }));
  app.get("*", serveStatic({ path: "./client/dist/index.html" }));
}

// Start HTTP Server
const port = CONFIG.PORT;
syncBuiltinSkills();
seedBootstrapProvider();
console.log(`[OpenChat] Starting server on http://localhost:${port}`);
if (!CONFIG.LLM_API_KEY && listProviders().every((p) => !p.api_key)) {
  console.error("[OpenChat] No provider API key configured — chat requests will fail. Add a provider in Settings.");
}
void tools.cleanupAllContainers();
db.pruneToolOutputs();
pruneWorkspaces();
setInterval(() => {
  db.pruneToolOutputs();
  pruneWorkspaces();
}, 24 * 3600_000).unref();
serve({
  fetch: app.fetch,
  port,
});
