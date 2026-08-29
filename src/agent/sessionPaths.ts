import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import type { SessionMode, SessionRecord } from "../db/database.js";

// Single source of truth for where a session's files live on the HOST.
//
//   chat  sessions: ~/.openchat/workspace/<id>        (bind-mounted at
//                    /workspace inside the session container, 1:1)
//   agent sessions: an arbitrary host directory chosen at creation time.
//                    Uploads land in a hidden .openchat/ subdir so real
//                    project directories stay clean.
//
// Everything that resolves user-visible file paths (tool execution, download
// routes, upload handling, image re-hydration in context.ts) must go through
// these helpers instead of joining WORKSPACES_ROOT directly.

export function pruneWorkspaces(keepCount: number = CONFIG.MAX_WORKSPACES_KEEP): number {
  const wsRoot = CONFIG.WORKSPACES_ROOT;
  if (!fs.existsSync(wsRoot)) return 0;
  try {
    const entries = fs.readdirSync(wsRoot, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(wsRoot, e.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {}
        return { name: e.name, full, mtime };
      });

    dirs.sort((a, b) => b.mtime - a.mtime);
    let removed = 0;
    if (dirs.length > keepCount) {
      for (const dir of dirs.slice(keepCount)) {
        try {
          fs.rmSync(dir.full, { recursive: true, force: true });
          removed++;
        } catch {}
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

export function deleteChatWorkspace(sessionId: string): void {
  const dir = path.join(CONFIG.WORKSPACES_ROOT, sessionId);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

export function chatWorkspaceDir(sessionId: string): string {
  const dir = path.join(CONFIG.WORKSPACES_ROOT, sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    pruneWorkspaces();
  }
  return dir;
}

export function sessionMode(session: Pick<SessionRecord, "mode">): SessionMode {
  return session.mode === "agent" ? "agent" : "chat";
}

/** Host-side root directory all of a session's relative paths resolve against. */
export function sessionRoot(session: SessionRecord): string {
  return sessionMode(session) === "agent" && session.workdir
    ? session.workdir
    : chatWorkspaceDir(session.id);
}

/** Where uploaded attachments live, relative to the session root. */
export function uploadsRelDir(session: SessionRecord): string {
  return sessionMode(session) === "agent" ? ".openchat/uploads" : "uploads";
}

export function uploadsAbsDir(session: SessionRecord): string {
  return path.join(sessionRoot(session), uploadsRelDir(session));
}
