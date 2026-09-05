// History assembly for the model-facing prompt.
//
// Mechanisms, all deterministic (no LLM in the loop):
//   1. The current request is pinned. Older tasks survive whole, newest-first,
//      within the remaining budget. Long current tasks retain recent steps
//      plus compact receipts. Units are pair-safe: an assistant message
//      carrying tool_calls and its role:"tool" results always move together.
//   2. Aging — tool observations older than `recentFullTools` collapse to a
//      one-line receipt. The call record and its arguments stay visible; only
//      the bulky output body is replaced. Full copies remain recoverable via
//      read_output {"id": N}. Image observations lose their bytes entirely
//      (the file stays on disk).
//   3. Image observations — serialized as {"__obs__":"image",...} envelopes;
//      fresh ones are re-read from the workspace and emitted as multipart
//      vision content right before the API call.
//   4. Thought retention — the CURRENT task's assistant reasoning (<think>)
//      is replayed so the model continues its own chain mid-task. Older
//      tasks' thoughts are dropped entirely (industry-standard harness
//      behavior: OpenAI/Anthropic/Codex retain reasoning only within the
//      live task boundary).

import fs from "node:fs";
import path from "node:path";
import { parseObservation, statusFromText, type ToolStatus } from "./toolTypes.js";
import { CONFIG } from "../config.js";

export type HistoryRecord = {
  id?: string;
  role: string;
  content?: string | null;
  thought?: string | null;
  tool_call_id?: string | null;
  name?: string | null;
  tool_calls?: any;
  tool_status?: string | ToolStatus;
  output_id?: number;
};

export interface HistoryOptions {
  /** Token ceiling for retained history (script-aware estimate). */
  budgetTokens?: number;
  recentFullTools?: number;
  maxRecords?: number;
  /** Session workspace root — enables re-hydrating image observations. */
  workspaceDir?: string;
  /** Replay the current task's assistant reasoning as <think> blocks (default on). */
  retainThought?: boolean;
}

// Script-aware token estimation. Measured ratios vary by tokenizer
// (English prose ~4-5 chars/token; Hangul shatters to ~1 token per syllable
// block, corpus-measured 1.8-2.5 chars/token). These are estimates; exact
// usage depends on the selected model's tokenizer:
//   ASCII/Latin/code: 4 chars per token, CJK (Hangul/Han/Kana/fullwidth): 1.5.
const CJK_CHAR = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7A3\u3040-\u30FF\u3400-\u4DBF\uF900-\uFAFF\uFF00-\uFFEF]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_CHAR) || []).length;
  const other = text.length - cjk;
  return Math.ceil(other / 4 + cjk / 1.5);
}

export interface HistoryStats {
  recordsIn: number;
  recordsKept: number;
  unitsTotal: number;
  unitsDropped: number;
  toolsCollapsed: number;
  tokensIn: number;
  tokensKept: number;
}

export interface BuiltMessage {
  role: "user" | "assistant" | "tool";
  content?: string | Array<Record<string, any>>;
  tool_call_id?: string;
  name?: string;
  tool_calls?: any[];
}

const OVERHEAD_PER_RECORD = 24;

// Vision tokens billed per image part (≈1024² at high detail on OpenAI-style
// gateways). Conservative flat estimate — real cost varies with resolution.
const IMAGE_TOKEN_ESTIMATE = 765;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function parseToolCalls(raw: any): any[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Unit: the smallest slice that may move as one piece across a budget cut.
// Size is an estimated token count (content + serialized tool_call arguments,
// which are billed like any other prompt text). Units carrying current-task
// reasoning also bill the replayed <think> body.
type Unit = { recs: HistoryRecord[]; size: number; withThought?: boolean; source?: number };

const OVERHEAD_TOKENS_PER_RECORD = Math.ceil(OVERHEAD_PER_RECORD / 4);

function recordTokens(r: HistoryRecord, withThought = false): number {
  const obs = typeof r.content === "string" ? parseObservation(r.content) : null;
  let n = OVERHEAD_TOKENS_PER_RECORD + estimateTokens(obs ? obs.text : r.content ?? "");
  if (r.tool_calls) n += estimateTokens(JSON.stringify(r.tool_calls));
  if (withThought && r.thought) n += estimateTokens("<think>\n" + r.thought + "\n</think>\n\n");
  if (obs) n += IMAGE_TOKEN_ESTIMATE;
  return n;
}

function unitSize(recs: HistoryRecord[], withThought = false): number {
  let n = 0;
  for (const r of recs) n += recordTokens(r, withThought);
  return n;
}

function statusHint(rec: HistoryRecord): string {
  let status: ToolStatus | undefined;
  try { status = typeof rec.tool_status === "string" ? JSON.parse(rec.tool_status) : rec.tool_status; } catch {}
  status ??= statusFromText(rec.content ?? "");
  return status.timedOut ? "timed out" : status.interrupted ? "interrupted" : status.ok ? "ok" : "error";
}

const OUTPUT_ID_RE = /output #(\d+)/;

export function receiptFor(rec: HistoryRecord): string {
  const name = rec.name || "tool";
  const obs = typeof rec.content === "string" ? parseObservation(rec.content) : null;
  if (obs) return `[${name} · ok · ${obs.text}]`;
  const content = rec.content ?? "";
  const kb = content.length >= 1024 ? `${(content.length / 1024).toFixed(1)}KB` : `${content.length}B`;
  const id = rec.output_id ?? content.match(OUTPUT_ID_RE)?.[1];
  const tail = id ? ` · full copy: read_output {"id": ${id}}` : "";
  return `[${name} · ${statusHint(rec)} · ${kb}${tail}]`;
}


function clipTokens(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (estimateTokens(text) <= limit) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid) + "…") <= limit) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + "…";
}

export function buildHistory(
  records: HistoryRecord[],
  opts: HistoryOptions = {}
): { messages: BuiltMessage[]; stats: HistoryStats } {
  const budgetTokens = opts.budgetTokens ?? 145_000;
  const recentFullTools = Math.max(0, opts.recentFullTools ?? 8);
  const maxRecords = Math.max(1, opts.maxRecords ?? 200);
  const workspaceDir = opts.workspaceDir;
  const retainThought = opts.retainThought !== false;

  let lastUserIdx = -1;
  for (let i = 0; i < records.length; i++) if (records[i].role === "user") lastUserIdx = i;
  const currentTask = new Set(lastUserIdx < 0 ? records : records.slice(lastUserIdx));
  const units: Unit[] = [];
  let openExecUnit: Unit | null = null;
  for (const r of records) {
    const withThought = retainThought && currentTask.has(r);
    if (r.role === "user" || r.role === "assistant") {
      const unit: Unit = { recs: [r], size: 0, withThought, source: units.length };
      units.push(unit);
      openExecUnit = r.role === "assistant" && parseToolCalls(r.tool_calls).length ? unit : null;
    } else if (r.role === "tool" && openExecUnit) {
      const ids = parseToolCalls(openExecUnit.recs[0].tool_calls).map((call) => call.id);
      if (ids.includes(r.tool_call_id)) openExecUnit.recs.push(r);
    } else {
      openExecUnit = null;
    }
  }

  // A server restart can leave an assistant call without its result. Restore
  // protocol pairing without pretending that the interrupted tool succeeded.
  for (const unit of units) {
    for (const call of parseToolCalls(unit.recs[0].tool_calls)) {
      if (!unit.recs.some((r) => r.role === "tool" && r.tool_call_id === call.id)) {
        unit.recs.push({ role: "tool", tool_call_id: call.id, name: call.function?.name || call.name,
          content: "[Tool interrupted before its result was recorded. Verify the current state before retrying.]",
          tool_status: { ok: false, interrupted: true } });
      }
    }
    unit.size = unitSize(unit.recs, unit.withThought);
  }
  const tokensIn = units.reduce((sum, unit) => sum + unit.size, 0);
  const collapsed = new Set<HistoryRecord>();
  let toolsSeen = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    unit.recs = unit.recs.map((r) => ({ ...r }));
    for (let j = unit.recs.length - 1; j >= 0; j--) {
      const r = unit.recs[j];
      if (r.role === "tool" && ++toolsSeen > recentFullTools) {
        r.content = receiptFor(r);
        collapsed.add(r);
      }
    }
    unit.size = unitSize(unit.recs, unit.withThought);
  }

  const taskStarts = units.flatMap((u, i) => u.recs[0].role === "user" ? [i] : []);
  const currentStart = taskStarts.at(-1) ?? 0;
  const current = units.slice(currentStart);
  const root = current[0]?.recs[0].role === "user" ? current[0] : undefined;
  if (root && root.size > budgetTokens) {
    throw new Error("현재 요청이 모델의 입력 예산을 초과합니다. 긴 자료는 파일로 첨부하거나 요청을 나누어 주세요.");
  }
  const count = (items: Unit[]) => items.reduce((n, u) => n + u.recs.length, 0);
  const cost = (items: Unit[]) => items.reduce((n, u) => n + u.size, 0);
  let keptUnits = [...current];

  if (cost(keptUnits) > budgetTokens || count(keptUnits) > maxRecords) {
    const pinned = root ? [root] : [];
    const candidates = root ? current.slice(1) : current;
    const spareTokens = budgetTokens - cost(pinned);
    const spareRecords = maxRecords - count(pinned);
    const summaryReserve = spareRecords > 0 ? Math.min(512, Math.floor(spareTokens / 3)) : 0;
    const recent: Unit[] = [];
    let spent = cost(pinned) + summaryReserve;
    let usedRecords = count(pinned) + (summaryReserve > OVERHEAD_TOKENS_PER_RECORD ? 1 : 0);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const unit = candidates[i];
      if (spent + unit.size > budgetTokens || usedRecords + unit.recs.length > maxRecords) break;
      recent.unshift(unit);
      spent += unit.size;
      usedRecords += unit.recs.length;
    }
    const omitted = candidates.slice(0, candidates.length - recent.length);
    keptUnits = [...pinned, ...recent];
    const remainingTokens = budgetTokens - cost(keptUnits);
    if (omitted.length && count(keptUnits) < maxRecords && remainingTokens > OVERHEAD_TOKENS_PER_RECORD + 8) {
      const details = omitted.slice().reverse().flatMap((unit) => {
        const receipts = unit.recs.filter((r) => r.role === "tool").map(receiptFor);
        return receipts.length ? receipts : [String(unit.recs[0].content || "").slice(0, 240)];
      }).filter(Boolean).join("\n");
      const text = "[Earlier steps compacted; newest first. The original request is preserved.]\n" + details;
      const record: HistoryRecord = { role: "assistant", content: clipTokens(text, Math.min(remainingTokens, 512) - OVERHEAD_TOKENS_PER_RECORD) };
      const summary: Unit = { recs: [record], size: unitSize([record]) };
      keptUnits = [...pinned, summary, ...recent];
    }
  }

  // Older tasks are all-or-nothing. Charge the retained current task first.
  let spent = cost(keptUnits);
  let usedRecords = count(keptUnits);
  for (let t = taskStarts.length - 2; t >= 0; t--) {
    const task = units.slice(taskStarts[t], taskStarts[t + 1]);
    if (spent + cost(task) > budgetTokens || usedRecords + count(task) > maxRecords) break;
    keptUnits.unshift(...task);
    spent += cost(task);
    usedRecords += count(task);
  }

  const sliced = keptUnits.flatMap((unit) => unit.recs);
  const thoughtRecords = new Set(keptUnits.filter((u) => u.withThought).flatMap((u) => u.recs));
  const keptCount = keptUnits.filter((u) => u.source !== undefined).length;
  const toolsCollapsed = sliced.filter((r) => collapsed.has(r)).length;

  // ---- Pass 5: emit API-shaped messages -----------------------------------
  const messages: BuiltMessage[] = [];
  for (const r of sliced) {
    if (r.role === "user") {
      messages.push({ role: "user", content: r.content ?? "" });
    } else if (r.role === "assistant") {
      const calls = parseToolCalls(r.tool_calls);
      let body = r.content ?? "";
      if (retainThought && thoughtRecords.has(r)) {
        // Replay the live task's own reasoning so the chain continues.
        // Stray tags inside stored thoughts are stripped — a leaked
        // </think> would end the block early and confuse the model.
        const t = r.thought?.replace(/<\/?think>/g, "").trim();
        if (t) body = `<think>\n${t}\n</think>\n\n${body}`;
      }
      const msg: BuiltMessage = { role: "assistant", content: body };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((tc: any) => {
          if (tc.function) return tc;
          return {
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
          };
        });
      }
      messages.push(msg);
    } else if (r.role === "tool") {
      const obs = typeof r.content === "string" ? parseObservation(r.content) : null;
      const msg: BuiltMessage = { role: "tool", tool_call_id: r.tool_call_id ?? "", name: r.name ?? undefined };
      if (obs && workspaceDir) {
        // Re-hydrate the image from disk right before the call. Two roots are
        // valid: the session workspace (relative paths) and the shared skills
        // volume via its container path (/opt/skills/...). If the file has
        // vanished, degrade to a plain-text note instead of failing.
        try {
          const skillsMount = "/opt/skills/";
          const absRaw = obs.path?.startsWith(skillsMount)
            ? path.join(CONFIG.SKILLS_DIR, obs.path.slice(skillsMount.length))
            : path.resolve(workspaceDir, obs.path ?? "");
          const absReal = fs.realpathSync(absRaw);
          const rootReal = fs.realpathSync(
            obs.path?.startsWith(skillsMount) ? CONFIG.SKILLS_DIR : workspaceDir
          );
          const relCheck = path.relative(rootReal, absReal);
          if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error("escapes root");
          const mime = IMAGE_MIME_BY_EXT[path.extname(absReal).toLowerCase()];
          if (!mime) throw new Error("unsupported image type");
          const buf = fs.readFileSync(absReal);
          msg.content = [
            { type: "text", text: obs.text },
            { type: "image_url", image_url: { url: `data:${mime};base64,${buf.toString("base64")}` } },
          ];
        } catch {
          msg.content = `(이미지 유실: ${obs.path})`;
        }
      } else {
        msg.content = obs ? obs.text : r.content ?? "";
      }
      messages.push(msg);
    }
  }

  const tokensKept = keptUnits.reduce((a, u) => a + u.size, 0);
  return {
    messages,
    stats: {
      recordsIn: records.length,
      recordsKept: sliced.length,
      unitsTotal: units.length,
      unitsDropped: units.length - keptCount,
      toolsCollapsed,
      tokensIn,
      tokensKept,
    },
  };
}
