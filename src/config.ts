import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const DATA_ROOT = path.resolve(process.env.OPENCHAT_HOME || path.join(os.homedir(), ".openchat"));
const localDb = path.join(path.dirname(fileURLToPath(import.meta.url)), "../openchat.db");
const defaultDb = fs.existsSync(localDb) ? localDb : path.join(DATA_ROOT, "openchat.db");

export const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  LLM_BASE_URL: process.env.LLM_BASE_URL || "https://opencode.ai/zen/go/v1",
  LLM_MODEL: process.env.LLM_MODEL || "muse-spark-1.2-contributor",
  // Secret lives only in .env (dotenv). Never commit a fallback key here.
  LLM_API_KEY: process.env.LLM_API_KEY || "",
  // Data root: everything mutable lives under ~/.openchat (workspace,
  // skills). Individual paths stay env-overridable.
  WORKSPACES_ROOT: path.resolve(process.env.OPENCHAT_WORKSPACE_ROOT || path.join(DATA_ROOT, "workspace")),
  SKILLS_DIR: path.resolve(process.env.OPENCHAT_SKILLS_DIR || path.join(DATA_ROOT, "skills")),
  SANDBOX_IMAGE: process.env.OPENCHAT_SANDBOX_IMAGE || "openchat-sandbox:v2",
  SANDBOX_MEM_LIMIT: process.env.OPENCHAT_SANDBOX_MEM || "1g",
  SANDBOX_CPUS: process.env.OPENCHAT_SANDBOX_CPUS || "1.5",
  SANDBOX_PIDS_LIMIT: parseInt(process.env.OPENCHAT_SANDBOX_PIDS || "256", 10),
  SANDBOX_OUTPUT_CAP: parseInt(process.env.OPENCHAT_SANDBOX_OUTPUT_CAP || "262144", 10), // 256KB
  TOOL_ARCHIVE_MAX_CHARS: parseInt(process.env.OPENCHAT_TOOL_ARCHIVE_MAX || "262144", 10),
  TOOL_OUTPUT_KEEP_PER_SESSION: parseInt(process.env.OPENCHAT_TOOL_KEEP_N || "200", 10),
  TOOL_OUTPUT_MAX_AGE_DAYS: parseInt(process.env.OPENCHAT_TOOL_MAX_AGE_DAYS || "7", 10),
  // History budget in estimated TOKENS (script-aware: CJK ~1.5 ch/tok,
  // ASCII ~4 ch/tok). 145K leaves headroom under a ~150K total context for
  // the system prompt, tool schemas, and the model's response.
  HISTORY_BUDGET_TOKENS: parseInt(process.env.OPENCHAT_HISTORY_BUDGET_TOKENS || "145000", 10),
  HISTORY_RECENT_FULL_TOOLS: parseInt(process.env.OPENCHAT_RECENT_FULL_TOOLS || "8", 10),
  // Replay the current task's reasoning (<think>) in history. Set
  // OPENCHAT_THOUGHT_RETENTION=off to fall back to dropping all thoughts.
  THOUGHT_RETENTION: (process.env.OPENCHAT_THOUGHT_RETENTION || "task") !== "off",
  DB_PATH: path.resolve(process.env.OPENCHAT_DB_PATH || defaultDb),
  MAX_AGENT_TURNS: parseInt(process.env.OPENCHAT_MAX_TURNS || "40", 10),
  MAX_WORKSPACES_KEEP: parseInt(process.env.OPENCHAT_MAX_WORKSPACES || "30", 10),
};
