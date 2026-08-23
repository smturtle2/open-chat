import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";

// Agent Skills (agentskills.io convention): <name>/SKILL.md with YAML
// frontmatter. Discovery is lenient — unknown frontmatter keys are ignored,
// a missing description indexes as empty, and the DIRECTORY name is the
// canonical id (frontmatter/name mismatches only warn). The skills root is
// rescanned on every call; prompt assembly runs per turn, so installed
// skills become usable without a restart.

export interface SkillMeta {
  name: string;
  description: string;
  dir: string; // absolute directory of the skill
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

export function listSkills(): SkillMeta[] {
  const root = CONFIG.SKILLS_DIR;
  if (!fs.existsSync(root)) return [];
  const skills: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = path.join(root, entry.name, "SKILL.md");
    if (!entry.name.match(/^[a-z0-9][a-z0-9_-]*$/) || !fs.existsSync(mdPath)) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
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
    const description = (fm.description ?? "").slice(0, 1024);
    skills.push({ name: entry.name, description, dir: path.join(root, entry.name) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillBody {
  body: string;
  dir: string;
  files: string[];
}

const MAX_SKILL_BODY_BYTES = 256 * 1024;

// Loads SKILL.md for an installed skill. The requested name is confined to
// the skills root via realpath so traversal ("../../etc") cannot escape.
export async function readSkillBody(name: string): Promise<SkillBody | null> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null;
  const rootReal = await fsp.realpath(CONFIG.SKILLS_DIR).catch(() => null);
  if (!rootReal) return null;
  const dir = path.join(CONFIG.SKILLS_DIR, name);
  const real = await fsp.realpath(dir).catch(() => null);
  if (!real || real !== path.join(rootReal, name)) return null;
  const md = path.join(real, "SKILL.md");
  const stat = await fsp.stat(md).catch(() => null);
  if (!stat || stat.size > MAX_SKILL_BODY_BYTES) return null;
  let body: string;
  try {
    body = await fsp.readFile(md, "utf8");
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
      else if (relPath !== "SKILL.md") files.push(relPath);
    }
  };
  await walk("", 0);

  // Strip frontmatter from the returned body — metadata already lives in
  // the system prompt listing.
  const stripped = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return { body: stripped.trim(), dir: real, files };
}
