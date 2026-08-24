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

export function chatWorkspaceDir(sessionId: string): string {
  const dir = path.join(CONFIG.WORKSPACES_ROOT, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
