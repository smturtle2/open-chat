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
import { sniffImageMime } from "./agent/tools.js";
import { listSkills, syncBuiltinSkills } from "./agent/skills.js";
import { tools } from "./agent/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = new Hono();

app.use("*", cors());

// API: Sessions
app.get("/api/sessions", (c) => {
  const sessions = db.listSessions();
  return c.json(sessions);
});

// API: Models from gateway (plus the platform default model)
app.get("/api/skills", (c) => {
  return c.json(listSkills().map(({ name, description }) => ({ name, description })));
});

app.get("/api/models", async (c) => {
  try {
    const res = await fetch(`${CONFIG.LLM_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${CONFIG.LLM_API_KEY}` },
    });
    if (!res.ok) return c.json({ data: [], default: CONFIG.LLM_MODEL });
    const data = await res.json();
    return c.json({ ...data, default: CONFIG.LLM_MODEL });
  } catch {
    return c.json({ data: [], default: CONFIG.LLM_MODEL });
  }
});

app.post("/api/sessions", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = "chat_" + Math.random().toString(36).substring(2, 11);
  const title = body.title || "New Chat";
  const model = body.model || CONFIG.LLM_MODEL;
  const session = db.createSession(id, title, model);
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
  const session = db.getSession(id);
  return c.json(session || { success: true });
});

app.delete("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  coordinator.interrupt(id);
  db.deleteSession(id);
  void tools.cleanupContainer(id);
  return c.json({ success: true });
});

// API: Files & Downloads in Sandbox Workspace
app.get("/api/sessions/:id/files", (c) => {
  const id = c.req.param("id");
  const workspaceDir = path.join(CONFIG.WORKSPACES_ROOT, id);
  if (!fs.existsSync(workspaceDir)) return c.json({ files: [] });

  const getFilesRecursive = (dir: string, base: string = ""): Array<{ name: string; path: string; size: number }> => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const results: Array<{ name: string; path: string; size: number }> = [];
      for (const entry of entries) {
        if (entry.name === ".venv" || entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
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

  return c.json({ files: getFilesRecursive(workspaceDir) });
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
  const workspaceDir = path.join(CONFIG.WORKSPACES_ROOT, id);

  // Traversal + symlink-safe containment check: resolve real paths and
  // require the target to sit strictly inside the session workspace.
  let fullReal: string;
  let wsReal: string;
  try {
    fullReal = fs.realpathSync(path.resolve(workspaceDir, filename));
    wsReal = fs.realpathSync(workspaceDir);
  } catch {
    return c.text("File not found", 404);
  }
  const rel = path.relative(wsReal, fullReal);
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

  c.header("Content-Type", contentType);
  c.header("Content-Disposition", `inline; filename="${path.basename(fullReal)}"`);
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

  const uploadsDir = path.join(CONFIG.WORKSPACES_ROOT, id, "uploads");
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
  const relPath = `uploads/${uniqueName}`;
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
  const afterParam = c.req.query("after");
  const lastEventId = afterParam ? parseInt(afterParam, 10) : 0;

  return streamSSE(c, async (stream) => {
    let currentId = isNaN(lastEventId) ? 0 : lastEventId;
    let isActive = true;
    // Poll fast while the session is actively streaming; back off when idle
    // to keep per-connection DB load near zero.
    let sleepMs = 100;

    stream.onAbort(() => {
      isActive = false;
    });

    while (isActive) {
      const events = db.getEvents(id, currentId);
      for (const event of events) {
        if (!isActive) break;
        await stream.writeSSE({
          event: event.type,
          data: event.payload,
          id: String(event.id),
        });
        currentId = event.id!;
      }
      sleepMs = events.length > 0 ? 100 : Math.min(sleepMs * 2, 1000);
      await stream.sleep(sleepMs);
    }
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
console.log(`[OpenChat] Starting server on http://localhost:${port}`);
if (!CONFIG.LLM_API_KEY) {
  console.error("[OpenChat] LLM_API_KEY is not set — chat requests will fail. Configure it in /root/openchat/.env");
}
void tools.cleanupAllContainers();
db.pruneToolOutputs();
setInterval(() => db.pruneToolOutputs(), 24 * 3600_000).unref();
serve({
  fetch: app.fetch,
  port,
});
