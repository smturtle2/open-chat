import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";
import { sniffImageMime, type ToolObservation } from "./toolTypes.js";

// Host-side file operations backing read_file / write_file / patch_file /
// view_image. One implementation serves both session modes:
//
//   chat  — the root is the session workspace (bind-mounted 1:1 at
//           /workspace inside the sandbox), so acting host-side touches the
//           exact files the container sees.
//   agent — the root is the user-chosen working directory; confinement is
//           enforced here because there is no container boundary.
//
// Paths may be relative (resolved against the root) or absolute. Two roots
// are always reachable: the session root and the shared skills volume, which
// keeps its stable virtual prefix "/opt/skills" in every mode so skill
// documentation and stored observations stay portable.

export const SKILLS_MOUNT = "/opt/skills";

interface ResolvedPath {
  abs: string;
  /** Path as shown to the model: relative when inside the root, else verbatim. */
  display: string;
}

async function resolvePath(rootDir: string, rawPath: string): Promise<ResolvedPath> {
  const p = (rawPath || "").trim();
  if (!p) throw new Error("a non-empty path is required");

  let abs: string;
  if (p === SKILLS_MOUNT || p.startsWith(SKILLS_MOUNT + "/")) {
    abs = path.join(CONFIG.SKILLS_DIR, p.slice(SKILLS_MOUNT.length));
  } else if (path.isAbsolute(p)) {
    // Bare absolute paths are interpreted against the skills root only for
    // the virtual mount; anything else must already be a real absolute path.
    abs = p;
  } else {
    abs = path.resolve(rootDir, p);
  }
  abs = path.normalize(abs);

  // Containment: realpath both sides so symlinks cannot escape either root.
  const [absReal, rootReal, skillsReal] = await Promise.all([
    fsp.realpath(abs).catch(() => null),
    fsp.realpath(rootDir).catch(() => null),
    fsp.realpath(CONFIG.SKILLS_DIR).catch(() => null),
  ]);
  if (!absReal) throw Object.assign(new Error(`File not found: ${p}`), { code: "ENOENT" });

  const inRoot = !!rootReal && !path.relative(rootReal, absReal).startsWith("..") && !path.isAbsolute(path.relative(rootReal, absReal));
  const inSkills = !!skillsReal && !path.relative(skillsReal, absReal).startsWith("..") && !path.isAbsolute(path.relative(skillsReal, absReal));
  if (!inRoot && !inSkills) {
    throw new Error(`path escapes the session workspace and ${SKILLS_MOUNT}`);
  }

  const display = inRoot && rootReal ? relativeDisplay(rootReal, absReal) : p;
  return { abs: absReal, display };
}

function relativeDisplay(rootReal: string, absReal: string): string {
  const rel = path.relative(rootReal, absReal);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return absReal;
  return rel;
}

export interface FsReadRequest {
  op: "read";
  path: string;
  offset?: number;
  limit?: number;
}

export interface FsWriteRequest {
  op: "write";
  path: string;
  content?: string;
}

export interface FsPatchRequest {
  op: "patch";
  path: string;
  target?: string;
  replacement?: string;
}

export type FsRequest = FsReadRequest | FsWriteRequest | FsPatchRequest;

/**
 * Execute a file operation. Returns user-facing text; all failures come back
 * as readable `Error: ...` strings, never thrown, matching the historical
 * fs_runner contract the compactor and UI were tuned around.
 */
export async function fsOp(rootDir: string, req: FsRequest): Promise<string> {
  try {
    switch (req.op) {
      case "read":
        return await readOp(rootDir, req);
      case "write":
        return await writeOp(rootDir, req);
      case "patch":
        return await patchOp(rootDir, req);
      default:
        return `Error: unknown operation: ${(req as any).op}`;
    }
  } catch (err: any) {
    if (err?.code === "ENOENT" && !String(err.message).startsWith("Error:")) {
      return `Error: File not found`;
    }
    return `Error: ${err?.message || String(err)}`;
  }
}

async function readOp(rootDir: string, req: FsReadRequest): Promise<string> {
  const { abs } = await resolvePath(rootDir, req.path);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat) return `Error: File not found`;
  if (stat.isDirectory()) return `Error: path is a directory`;

  const text = await fsp.readFile(abs, "utf8");
  const lines = text.split(/(?<=\n)/); // keep line endings intact
  const total = lines.length;

  const start = Math.max(Number(req.offset) || 1, 1);
  if (total > 0 && start > total) {
    return `Error: offset ${start} is beyond end of file (${total} lines)`;
  }
  const limit = Number(req.limit) || 0;
  const end = limit <= 0 ? total + 1 : Math.min(total + 1, start + limit);

  let body = lines.slice(start - 1, end - 1).join("");
  if (end - 1 < total) {
    body += `\n[showing lines ${start}-${end - 1} of ${total} total; use offset=${end} for next page]\n`;
  }
  return body;
}

async function writeOp(rootDir: string, req: FsWriteRequest): Promise<string> {
  const { abs, display } = await resolveTargetPath(rootDir, req.path);
  const content = req.content ?? "";
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf8");
  return `File "${display}" successfully created/updated (${Buffer.byteLength(content, "utf8")} bytes).`;
}

async function patchOp(rootDir: string, req: FsPatchRequest): Promise<string> {
  const { abs, display } = await resolvePath(rootDir, req.path);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat) return `Error: File not found: ${display}`;
  if (stat.isDirectory()) return `Error: ${display} is a directory`;

  const cur = await fsp.readFile(abs, "utf8");
  const target = req.target ?? "";
  const replacement = req.replacement ?? "";
  const count = target ? cur.split(target).length - 1 : 0;
  if (!target || count === 0) {
    return `Error: Target string not found in "${display}". Verify exact characters and whitespace.`;
  }
  if (count > 1) {
    return `Error: Target string matched ${count} times in "${display}". Provide more surrounding context to make the replacement unique.`;
  }
  await fsp.writeFile(abs, cur.replace(target, replacement), "utf8");
  return `File "${display}" patched successfully.`;
}

// write creates new files: containment check without requiring existence.
async function resolveTargetPath(rootDir: string, rawPath: string): Promise<{ abs: string; display: string }> {
  const p = (rawPath || "").trim();
  if (!p) throw new Error("a non-empty path is required");

  let abs: string;
  if (p === SKILLS_MOUNT || p.startsWith(SKILLS_MOUNT + "/")) {
    abs = path.join(CONFIG.SKILLS_DIR, p.slice(SKILLS_MOUNT.length));
  } else if (path.isAbsolute(p)) {
    abs = p;
  } else {
    abs = path.resolve(rootDir, p);
  }
  abs = path.normalize(abs);

  // Deepest existing ancestor must sit inside one of the two roots.
  let probe = abs;
  while (true) {
    const real = await fsp.realpath(probe).catch(() => null);
    if (real) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const [probeReal, rootReal, skillsReal] = await Promise.all([
    fsp.realpath(probe).catch(() => null),
    fsp.realpath(rootDir).catch(() => null),
    fsp.realpath(CONFIG.SKILLS_DIR).catch(() => null),
  ]);
  if (probeReal) {
    const inRoot = !!rootReal && !path.relative(rootReal, probeReal).startsWith("..") && !path.isAbsolute(path.relative(rootReal, probeReal));
    const inSkills = !!skillsReal && !path.relative(skillsReal, probeReal).startsWith("..") && !path.isAbsolute(path.relative(skillsReal, probeReal));
    if (!inRoot && !inSkills) throw new Error(`path escapes the session workspace and ${SKILLS_MOUNT}`);
  }

  const rel = rootReal ? path.relative(rootReal, abs) : "..";
  const display = !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
  return { abs, display };
}

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Read an image for vision input. Same dual-root reachability as fsOp, with a
 * size cap and magic-byte decoding check. Returns the observation plus the
 * byte size (for usage accounting), or a readable error string.
 */
export async function viewImage(rootDir: string, imgPath: string): Promise<{ obs: ToolObservation; bytes: number } | string> {
  const raw = (imgPath || "").trim();
  if (!raw) return "Error: an image path is required";

  try {
    const { abs, display } = await resolvePath(rootDir, raw);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) return `Error: image not found at ${raw}`;
    if (stat.size > IMAGE_MAX_BYTES) {
      return `Error: image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB) — limit is 5MB. Downscale or crop it first.`;
    }
    const buf = await fsp.readFile(abs);
    const mime = sniffImageMime(buf);
    if (!mime) {
      return `Error: ${display} is not a decodable image (PNG/JPEG/GIF/WebP). If it is an image in another format, convert it first.`;
    }
    return {
      obs: {
        text: `${display} · ${stat.size >= 1024 ? `${(stat.size / 1024).toFixed(0)}KB` : `${stat.size}B`}`,
        kind: "image",
        path: display,
      },
      bytes: buf.length,
    };
  } catch (err: any) {
    return err?.code === "ENOENT" ? `Error: image not found at ${raw}` : `Error: ${err?.message || String(err)}`;
  }
}

export interface SearchFilesRequest {
  query: string;
  path?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export async function searchFilesOp(rootDir: string, req: SearchFilesRequest): Promise<string> {
  if (!req.query || !req.query.trim()) return "Error: Search query is required.";
  try {
    let targetDir = rootDir;
    if (req.path && req.path.trim()) {
      const resolved = await resolvePath(rootDir, req.path);
      targetDir = resolved.abs;
    }
    const maxResults = Math.min(Math.max(Number(req.maxResults) || 30, 1), 100);
    const results: Array<{ file: string; line: number; text: string }> = [];

    const walk = async (dir: string) => {
      if (results.length >= maxResults) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith(".") && entry.name !== ".openchat") continue;
        if (["node_modules", ".git", ".venv", "__pycache__", "dist", "build", "coverage"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          try {
            const stat = await fsp.stat(full);
            if (stat.size > 2 * 1024 * 1024) continue;
            const content = await fsp.readFile(full, "utf8");
            const lines = content.split(/\r?\n/);
            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx];
              let isMatch = false;
              if (req.isRegex) {
                try {
                  const re = new RegExp(req.query, req.caseSensitive ? "" : "i");
                  isMatch = re.test(line);
                } catch {
                  return "Error: Invalid regular expression pattern.";
                }
              } else {
                isMatch = req.caseSensitive
                  ? line.includes(req.query)
                  : line.toLowerCase().includes(req.query.toLowerCase());
              }
              if (isMatch) {
                const rel = path.relative(rootDir, full);
                results.push({ file: rel, line: idx + 1, text: line.trim().slice(0, 180) });
                if (results.length >= maxResults) break;
              }
            }
          } catch {}
        }
      }
    };

    await walk(targetDir);
    if (results.length === 0) return `No matches found for "${req.query}".`;
    const formatted = results.map((r) => `${r.file}:${r.line}: ${r.text}`).join("\n");
    return `Found ${results.length} match(es):\n${formatted}`;
  } catch (err: any) {
    return `Error searching files: ${err.message || String(err)}`;
  }
}

export interface ListFilesRequest {
  path?: string;
  depth?: number;
}

export async function listFilesOp(rootDir: string, req: ListFilesRequest): Promise<string> {
  try {
    let targetDir = rootDir;
    if (req.path && req.path.trim()) {
      const resolved = await resolvePath(rootDir, req.path);
      targetDir = resolved.abs;
    }
    const maxDepth = Math.min(Math.max(Number(req.depth) || 2, 1), 5);
    const rows: string[] = [];

    const walk = async (dir: string, currentDepth: number, prefix: string) => {
      if (currentDepth > maxDepth || rows.length >= 150) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of sorted) {
        if (rows.length >= 150) break;
        if (entry.name.startsWith(".") && entry.name !== ".openchat") continue;
        if (["node_modules", ".git", ".venv", "__pycache__", "dist"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          rows.push(`${prefix}📁 ${entry.name}/`);
          await walk(full, currentDepth + 1, prefix + "  ");
        } else if (entry.isFile()) {
          const stat = await fsp.stat(full).catch(() => null);
          const sz = stat ? (stat.size >= 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`) : "";
          rows.push(`${prefix}📄 ${entry.name} (${sz})`);
        }
      }
    };

    await walk(targetDir, 1, "");
    if (rows.length === 0) return "Directory is empty.";
    return rows.join("\n");
  } catch (err: any) {
    return `Error listing files: ${err.message || String(err)}`;
  }
}

