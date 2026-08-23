import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../config.js";

// Agent Skills (agentskills.io convention): <name>/SKILL.md with YAML
// frontmatter. Discovery is lenient — unknown frontmatter keys are ignored,
// a missing description indexes as empty, and the DIRECTORY name is the
// canonical id (frontmatter/name mismatches only warn).
//
// Two roots are merged:
//   ~/.openchat/skills/<name>/        user skills (authoritative)
//   ~/.openchat/skills/.builtin/<name>/  builtins synced from the app repo
// A user skill shadows a builtin of the same name. Builtins are materialized
// to disk (codex-style) so the sandbox's single /opt/skills mount sees both.
// The root is rescanned on every call; prompt assembly runs per turn, so new
// or updated skills become usable without a restart.

const BUILTIN_DIR_NAME = ".builtin";
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface SkillMeta {
  name: string;
  description: string;
  dir: string; // absolute directory of the skill
  builtin?: boolean;
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!kv) continue; // tolerate arbitrary extra keys
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (kv[1] === "name") out.name = v;
    else out.description = v;
  }
  return out;
}

function scanRoot(root: string, builtin: boolean): SkillMeta[] {
  if (!fs.existsSync(root)) return [];
  const out: SkillMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!NAME_RE.test(entry.name)) continue;
    const mdPath = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(mdPath)) continue;
    let raw = "";
    try {
      raw = fs.readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    if (fm.name && fm.name !== entry.name) {
      console.warn(`[skills] frontmatter name "${fm.name}" != directory "${entry.name}" — using directory`);
    }
    out.push({
      name: entry.name,
      description: (fm.description ?? "").slice(0, 1024),
      dir: path.join(root, entry.name),
      builtin,
    });
  }
  return out;
}

export function listSkills(): SkillMeta[] {
  // Builtins first so user entries overwrite them in the map (override).
  const merged = new Map<string, SkillMeta>();
  for (const s of scanRoot(path.join(CONFIG.SKILLS_DIR, BUILTIN_DIR_NAME), true)) merged.set(s.name, s);
  for (const s of scanRoot(CONFIG.SKILLS_DIR, false)) merged.set(s.name, s);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- builtin sync (codex-style: embedded assets -> disk, fingerprinted) ----

function hashTree(dir: string): string {
  const items: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(relPath);
      else items.push(`${relPath}:${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, relPath))).digest("hex")}`);
    }
  };
  walk("");
  items.sort();
  return crypto.createHash("sha256").update(items.join("\n")).digest("hex");
}

function builtinSourceDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin-skills");
}

export function syncBuiltinSkills(): void {
  const src = builtinSourceDir();
  if (!fs.existsSync(src)) return;
  const destRoot = path.join(CONFIG.SKILLS_DIR, BUILTIN_DIR_NAME);
  const fingerprint = hashTree(src);
  const marker = path.join(destRoot, ".fingerprint");
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(marker, "utf8").trim();
  } catch {}
  if (existing === fingerprint) return;
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.cpSync(src, destRoot, { recursive: true });
  fs.writeFileSync(marker, fingerprint);
  console.log(`[skills] builtins synced -> ${destRoot}`);
}

// ---- body loading ----------------------------------------------------------

export interface SkillBody {
  body: string;
  dir: string;
  files: string[];
}

const MAX_SKILL_BODY_BYTES = 256 * 1024;

async function readFrom(root: string, name: string): Promise<SkillBody | null> {
  const rootReal = await fsp.realpath(root).catch(() => null);
  if (!rootReal) return null;
  const real = await fsp.realpath(path.join(root, name)).catch(() => null);
  if (!real || real !== path.join(rootReal, name)) return null;
  const md = path.join(real, "SKILL.md");
  const stat = await fsp.stat(md).catch(() => null);
  if (!stat || stat.size > MAX_SKILL_BODY_BYTES) return null;
  let raw: string;
  try {
    raw = await fsp.readFile(md, "utf8");
  } catch {
    return null;
  }

  // Sibling file listing (2 levels deep, excluding SKILL.md itself) so the
  // model can see what resources ship with the skill.
  const files: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (files.length >= 10 || depth > 2) return;
    const entries = await fsp.readdir(path.join(real, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files.length >= 10) break;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(relPath, depth + 1);
      else if (relPath !== "SKILL.md" && relPath !== ".fingerprint") files.push(relPath);
    }
  };
  await walk("", 0);

  // Strip frontmatter from the returned body — metadata already lives in
  // the system prompt listing.
  const stripped = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return { body: stripped.trim(), dir: real, files };
}

// Loads SKILL.md for an installed skill, user copy first. The requested name
// is confined to the skills roots via realpath so traversal cannot escape.
export async function readSkillBody(name: string): Promise<SkillBody | null> {
  if (!NAME_RE.test(name)) return null;
  return (
    (await readFrom(CONFIG.SKILLS_DIR, name)) ??
    (await readFrom(path.join(CONFIG.SKILLS_DIR, BUILTIN_DIR_NAME), name))
  );
}
