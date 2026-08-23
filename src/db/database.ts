import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";

export interface SessionRecord {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  status: "idle" | "running";
}

export interface MessageRecord {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  thought?: string;
  tool_calls?: string | any[];
  tool_call_id?: string;
  name?: string;
  created_at: string;
}

export interface EventRecord {
  id?: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
}

export interface AttachmentRecord {
  id: string;
  session_id: string;
  message_id: string | null;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
}

export class AppDatabase {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(path.dirname(CONFIG.DB_PATH), { recursive: true });
    this.db = new Database(CONFIG.DB_PATH);

    // High performance & concurrency settings
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");

    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        thought TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        name TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);

      CREATE TABLE IF NOT EXISTS tool_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        chars INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tool_outputs_session ON tool_outputs(session_id, id);

      CREATE TABLE IF NOT EXISTS tool_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        raw_chars INTEGER NOT NULL,
        visible_chars INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tool_usage_session ON tool_usage(session_id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
    `);

    // Migration: add model column if missing
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "model")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT 'muse-spark-1.2-contributor'`);
    }
  }

  // Session Operations
  createSession(id: string, title: string = "New Chat", model: string = CONFIG.LLM_MODEL): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO sessions (id, title, model, status, created_at, updated_at) VALUES (?, ?, ?, 'idle', ?, ?)")
      .run(id, title, model, now, now);
    return { id, title, model, status: "idle", created_at: now, updated_at: now };
  }

  getSession(id: string): SessionRecord | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | undefined;
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRecord[];
  }

  updateSessionTitle(id: string, title: string) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, now, id);
  }

  updateSessionModel(id: string, model: string) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?").run(model, now, id);
  }

  updateSessionStatus(id: string, status: SessionRecord["status"]) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  }

  deleteSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // Message Operations
  addMessage(msg: Omit<MessageRecord, "created_at"> & { created_at?: string }) {
    const now = msg.created_at || new Date().toISOString();
    const toolCallsStr = typeof msg.tool_calls === "object" ? JSON.stringify(msg.tool_calls) : msg.tool_calls;
    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, role, content, thought, tool_calls, tool_call_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        msg.id,
        msg.session_id,
        msg.role,
        msg.content,
        msg.thought || null,
        toolCallsStr || null,
        msg.tool_call_id || null,
        msg.name || null,
        now
      );
  }

  getMessages(sessionId: string): MessageRecord[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as MessageRecord[];
  }

  updateMessageContent(sessionId: string, messageId: string, content: string): void {
    this.db.prepare("UPDATE messages SET content = ? WHERE session_id = ? AND id = ?").run(content, sessionId, messageId);
  }

  // Truncate all messages and events strictly AFTER a specific message ID
  truncateAfterMessage(sessionId: string, messageId: string): void {
    const targetMsg = this.db
      .prepare("SELECT rowid, id, created_at FROM messages WHERE session_id = ? AND id = ?")
      .get(sessionId, messageId) as { rowid: number; id: string; created_at: string } | undefined;

    if (targetMsg) {
      // Find the corresponding user_message event in events table
      const targetEvent = this.db
        .prepare("SELECT id FROM events WHERE session_id = ? AND type = 'user_message' AND payload LIKE ? ORDER BY id ASC LIMIT 1")
        .get(sessionId, `%"id":"${messageId}"%`) as { id: number } | undefined;

      this.db.transaction(() => {
        this.db.prepare("DELETE FROM messages WHERE session_id = ? AND rowid > ?").run(sessionId, targetMsg.rowid);
        if (targetEvent) {
          this.db.prepare("DELETE FROM events WHERE session_id = ? AND id > ?").run(sessionId, targetEvent.id);
        } else {
          this.db.prepare("DELETE FROM events WHERE session_id = ? AND created_at >= ?").run(sessionId, targetMsg.created_at);
        }
      })();
    }
  }

  // Event Operations
  appendEvent(sessionId: string, type: string, payload: any): number {
    const now = new Date().toISOString();
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const info = this.db
      .prepare("INSERT INTO events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, type, payloadStr, now);
    return Number(info.lastInsertRowid);
  }

  getEvents(sessionId: string, afterId: number = 0): EventRecord[] {
    return this.db
      .prepare("SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id ASC")
      .all(sessionId, afterId) as EventRecord[];
  }

  getLastEventId(sessionId: string): number {
    const last = this.db
      .prepare("SELECT id FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { id: number } | undefined;
    return last ? last.id : 0;
  }

  // Tool output archive: full (untruncated) tool results live here so the
  // model-facing surface can be compacted aggressively without data loss.
  // Rows vanish with their session (CASCADE) and are pruned by age/count.
  archiveToolOutput(sessionId: string, tool: string, content: string, capChars: number): number {
    const chars = content.length;
    const stored = chars > capChars ? content.slice(0, capChars) + `\n...[archive cap of ${capChars} chars reached]` : content;
    const info = this.db
      .prepare("INSERT INTO tool_outputs (session_id, tool, chars, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, tool, chars, stored, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  getToolOutput(sessionId: string, id: number): { id: number; tool: string; chars: number; content: string; created_at: string } | undefined {
    return this.db
      .prepare("SELECT id, tool, chars, content, created_at FROM tool_outputs WHERE id = ? AND session_id = ?")
      .get(id, sessionId) as { id: number; tool: string; chars: number; content: string; created_at: string } | undefined;
  }

  pruneToolOutputs(): number {
    const cutoff = new Date(Date.now() - CONFIG.TOOL_OUTPUT_MAX_AGE_DAYS * 86400_000).toISOString();
    const byAge = this.db.prepare("DELETE FROM tool_outputs WHERE created_at < ?").run(cutoff);
    const byCount = this.db
      .prepare(
        `DELETE FROM tool_outputs WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn
             FROM tool_outputs
           ) WHERE rn > ?
         )`
      )
      .run(CONFIG.TOOL_OUTPUT_KEEP_PER_SESSION);
    return byAge.changes + byCount.changes;
  }

  // Usage ledger: one row per settled tool call, independent of message
  // lifecycle. Powers the per-tool context breakdown.
  recordToolUsage(sessionId: string, tool: string, rawChars: number, visibleChars: number): void {
    this.db
      .prepare("INSERT INTO tool_usage (session_id, tool, raw_chars, visible_chars, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, tool, rawChars, visibleChars, new Date().toISOString());
  }

  // Attachments: uploads land on disk first; the row is created unclaimed and
  // later bound to the user message that references it.
  createAttachment(a: { id: string; session_id: string; kind: "image" | "file"; name: string; mime: string; size: number; path: string }): void {
    this.db
      .prepare("INSERT INTO attachments (id, session_id, message_id, kind, name, mime, size, path, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.session_id, a.kind, a.name, a.mime, a.size, a.path, new Date().toISOString());
  }

  getUnclaimedAttachments(sessionId: string, ids: string[]): AttachmentRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM attachments WHERE session_id = ? AND message_id IS NULL AND id IN (${placeholders})`)
      .all(sessionId, ...ids) as AttachmentRecord[];
  }

  claimAttachments(messageId: string, sessionId: string, ids: string[]): AttachmentRecord[] {
    const rows = this.getUnclaimedAttachments(sessionId, ids);
    for (const r of rows) {
      this.db.prepare("UPDATE attachments SET message_id = ? WHERE id = ? AND session_id = ?").run(messageId, r.id, sessionId);
    }
    return rows;
  }

  getMessageAttachments(messageId: string): AttachmentRecord[] {
    return this.db.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC").all(messageId) as AttachmentRecord[];
  }

  getToolUsage(sessionId: string): {
    totals: { calls: number; raw_chars: number; visible_chars: number };
    breakdown: Array<{ tool: string; calls: number; raw_chars: number; visible_chars: number }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT tool, COUNT(*) AS calls, SUM(raw_chars) AS raw_chars, SUM(visible_chars) AS visible_chars
         FROM tool_usage WHERE session_id = ? GROUP BY tool ORDER BY raw_chars DESC`
      )
      .all(sessionId) as Array<{ tool: string; calls: number; raw_chars: number; visible_chars: number }>;
    const totals = rows.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        raw_chars: acc.raw_chars + r.raw_chars,
        visible_chars: acc.visible_chars + r.visible_chars,
      }),
      { calls: 0, raw_chars: 0, visible_chars: 0 }
    );
    return { totals, breakdown: rows };
  }
}

export const db = new AppDatabase();
