import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  HOST: process.env.HOST || "0.0.0.0",
  LLM_BASE_URL: process.env.LLM_BASE_URL || "https://opencode.ai/zen/go/v1",
  LLM_MODEL: process.env.LLM_MODEL || "muse-spark-1.2-contributor",
  LLM_API_KEY: process.env.LLM_API_KEY || "sk-yqE0i2u6pCQ23n2WlLtp9IhMhE60v04Am87VFQhfNkTSAdV0jve6DET0j1UOQOql",
  WORKSPACES_ROOT: path.resolve(process.env.OPENCHAT_WORKSPACE_ROOT || "/root/workspace"),
  SANDBOX_IMAGE: process.env.OPENCHAT_SANDBOX_IMAGE || "openchat-sandbox:v2",
  SANDBOX_MEM_LIMIT: process.env.OPENCHAT_SANDBOX_MEM || "1g",
  SANDBOX_CPUS: process.env.OPENCHAT_SANDBOX_CPUS || "1.5",
  SANDBOX_PIDS_LIMIT: parseInt(process.env.OPENCHAT_SANDBOX_PIDS || "256", 10),
  SANDBOX_OUTPUT_CAP: parseInt(process.env.OPENCHAT_SANDBOX_OUTPUT_CAP || "262144", 10), // 256KB
  TOOL_ARCHIVE_MAX_CHARS: parseInt(process.env.OPENCHAT_TOOL_ARCHIVE_MAX || "262144", 10),
  TOOL_OUTPUT_KEEP_PER_SESSION: parseInt(process.env.OPENCHAT_TOOL_KEEP_N || "200", 10),
  TOOL_OUTPUT_MAX_AGE_DAYS: parseInt(process.env.OPENCHAT_TOOL_MAX_AGE_DAYS || "7", 10),
  HISTORY_BUDGET_CHARS: parseInt(process.env.OPENCHAT_HISTORY_BUDGET || "120000", 10),
  HISTORY_RECENT_FULL_TOOLS: parseInt(process.env.OPENCHAT_RECENT_FULL_TOOLS || "8", 10),
  DB_PATH: path.resolve("/root/openchat/openchat.db"),
  MAX_AGENT_TURNS: 9999, // Unbounded
  TOOL_TIMEOUT_MS: 120000,
};
