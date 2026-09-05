import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { db, type SessionMode, type SessionRecord } from "../db/database.js";

function workspacePath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid session ID");
  return path.join(CONFIG.WORKSPACES_ROOT, sessionId);
}

function trashEntries(sessionId?: string): Array<{ name: string; id: string; archivedAt: number }> {
  if (!fs.existsSync(CONFIG.WORKSPACE_TRASH_ROOT)) return [];
  return fs.readdirSync(CONFIG.WORKSPACE_TRASH_ROOT, { withFileTypes: true }).flatMap((entry) => {
    const match = /^([a-zA-Z0-9_-]{1,128})\.([a-z0-9]+)$/.exec(entry.name);
    if (!entry.isDirectory() || !match || (sessionId && match[1] !== sessionId)) return [];
    const archivedAt = parseInt(match[2], 36);
    return Number.isFinite(archivedAt) ? [{ name: entry.name, id: match[1], archivedAt }] : [];
  });
}

/** Move inactive workspaces into a recoverable trash area; never evict a run. */
export function pruneWorkspaces(keepCount = CONFIG.MAX_WORKSPACES_KEEP, protectedIds = new Set<string>()): number {
  if (!Number.isInteger(keepCount) || keepCount < 0) throw new Error("Workspace retention count must be non-negative");
  if (!fs.existsSync(CONFIG.WORKSPACES_ROOT)) return 0;
  const sessions = new Map(db.listSessions().map((s) => [s.id, s]));
  const dirs = fs.readdirSync(CONFIG.WORKSPACES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.name))
    .map((entry) => {
      const session = sessions.get(entry.name);
      const full = workspacePath(entry.name);
      return { id: entry.name, full,
        lastUsed: session ? Date.parse(session.updated_at) : fs.statSync(full).mtimeMs,
        active: protectedIds.has(entry.name) || session?.status === "running" };
    }).sort((a, b) => b.lastUsed - a.lastUsed);
  let remaining = dirs.length;
  let moved = 0;
  for (const dir of dirs.slice().reverse()) {
    if (remaining <= keepCount) break;
    if (dir.active) continue;
    fs.mkdirSync(CONFIG.WORKSPACE_TRASH_ROOT, { recursive: true });
    const destination = path.join(CONFIG.WORKSPACE_TRASH_ROOT, dir.id + "." + Date.now().toString(36));
    // Do not replace an earlier recovery copy or delete data after a failed move.
    if (fs.existsSync(destination)) continue;
    try {
      fs.renameSync(dir.full, destination);
      moved++;
      remaining--;
    } catch (error: any) {
      console.warn("[workspace] Could not archive " + dir.id + ": " + error.message);
    }
  }
  return moved;
}

export function purgeWorkspaceTrash(now = Date.now()): number {
  const days = CONFIG.WORKSPACE_TRASH_DAYS;
  if (!Number.isFinite(days) || days < 1) return 0;
  const active = new Set(db.listSessions().filter((s) => s.status === "running").map((s) => s.id));
  let removed = 0;
  for (const entry of trashEntries()) {
    if (active.has(entry.id) || now - entry.archivedAt < days * 86400_000) continue;
    fs.rmSync(path.join(CONFIG.WORKSPACE_TRASH_ROOT, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export function deleteChatWorkspace(sessionId: string): void {
  const dir = workspacePath(sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const entry of trashEntries(sessionId)) fs.rmSync(path.join(CONFIG.WORKSPACE_TRASH_ROOT, entry.name), { recursive: true, force: true });
}

/** Access restores an archived workspace during its grace period. */
export function chatWorkspaceDir(sessionId: string): string {
  const dir = workspacePath(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(CONFIG.WORKSPACES_ROOT, { recursive: true });
    const archived = trashEntries(sessionId).sort((a, b) => b.archivedAt - a.archivedAt)[0];
    if (archived) fs.renameSync(path.join(CONFIG.WORKSPACE_TRASH_ROOT, archived.name), dir);
    else fs.mkdirSync(dir, { recursive: true });
    db.touchSession(sessionId);
    pruneWorkspaces(CONFIG.MAX_WORKSPACES_KEEP, new Set([sessionId]));
  }
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("Workspace must be a directory, not a symlink");
  return dir;
}

export function workspaceState(session: SessionRecord): "active" | "archived" | "missing" {
  if (session.mode === "agent") return session.workdir && fs.existsSync(session.workdir) ? "active" : "missing";
  if (fs.existsSync(workspacePath(session.id))) return "active";
  return trashEntries(session.id).length ? "archived" : "missing";
}

export function sessionMode(session: Pick<SessionRecord, "mode">): SessionMode {
  return session.mode === "agent" ? "agent" : "chat";
}

export function sessionRoot(session: SessionRecord): string {
  return sessionMode(session) === "agent" && session.workdir ? session.workdir : chatWorkspaceDir(session.id);
}

export function uploadsRelDir(session: SessionRecord): string {
  return sessionMode(session) === "agent" ? ".openchat/uploads" : "uploads";
}

export function uploadsAbsDir(session: SessionRecord): string {
  return path.join(sessionRoot(session), uploadsRelDir(session));
}
