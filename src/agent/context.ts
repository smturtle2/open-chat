// History assembly for the model-facing prompt.
//
// Mechanisms, all deterministic (no LLM in the loop):
//   1. Whole-task cut — history is cut at task boundaries; the current task
//      is kept verbatim, older tasks survive whole newest-first while they
//      fit the token budget. Units are pair-safe: an assistant message
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
import { parseObservation } from "./toolTypes.js";
import { CONFIG } from "../config.js";

export type HistoryRecord = {
  id?: string;
  role: string;
  content?: string | null;
  thought?: string | null;
  tool_call_id?: string | null;
  name?: string | null;
  tool_calls?: any;
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
// block, corpus-measured 1.8-2.5 chars/token). We take conservative values so
// real usage never overshoots the budget:
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
type Unit = { recs: HistoryRecord[]; size: number; withThought?: boolean };

const OVERHEAD_TOKENS_PER_RECORD = Math.ceil(OVERHEAD_PER_RECORD / 4);

function recordTokens(r: HistoryRecord, withThought = false): number {
  const obs = typeof r.content === "string" ? parseObservation(r.content) : null;
  let n = OVERHEAD_TOKENS_PER_RECORD + estimateTokens(obs ? obs.text : r.content ?? "");
  if (r.tool_calls) n += estimateTokens(JSON.stringify(r.tool_calls));
  if (withThought && r.thought) n += estimateTokens(r.thought);
  if (obs) n += IMAGE_TOKEN_ESTIMATE;
  return n;
}

function unitSize(recs: HistoryRecord[], withThought = false): number {
  let n = 0;
  for (const r of recs) n += recordTokens(r, withThought);
  return n;
}

function statusHint(content: string): string {
  if (/\[timed out after/.test(content)) return "timed out";
  if (/\[interrupted after/.test(content)) return "interrupted";
  if (/Tool Execution Error|^Error\b|exit code [1-9]|exit status [1-9]/m.test(content)) return "error";
  return "ok";
}

const OUTPUT_ID_RE = /output #(\d+)/;

export function receiptFor(rec: HistoryRecord): string {
  const name = rec.name || "tool";
  const obs = typeof rec.content === "string" ? parseObservation(rec.content) : null;
  if (obs) return `[${name} · ok · ${obs.text}]`;
  const content = rec.content ?? "";
  const kb = content.length >= 1024 ? `${(content.length / 1024).toFixed(1)}KB` : `${content.length}B`;
  const id = content.match(OUTPUT_ID_RE)?.[1];
  const tail = id ? ` · full copy: read_output {"id": ${id}}` : "";
  return `[${name} · ${statusHint(content)} · ${kb}${tail}]`;
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

  // Current-task membership by record identity: everything from the last
  // user record onward. With no user record at all (degenerate session),
  // every record is treated as current — matching the keep-everything rule.
  let lastUserIdx = -1;
  for (let i = 0; i < records.length; i++) if (records[i].role === "user") lastUserIdx = i;
  const currentTask = new Set<HistoryRecord>(
    lastUserIdx === -1 ? records : records.slice(lastUserIdx)
  );

  // ---- Pass 1: group records into pair-safe units -------------------------
  const units: Unit[] = [];
  let openExecUnit: Unit | null = null;

  for (const r of records) {
    const cur = retainThought && currentTask.has(r);
    if (r.role === "user") {
      openExecUnit = null;
      units.push({ recs: [r], size: unitSize([r]) });
    } else if (r.role === "assistant") {
      const calls = parseToolCalls(r.tool_calls);
      if (calls.length > 0) {
        openExecUnit = { recs: [r], size: unitSize([r], cur), withThought: cur };
        units.push(openExecUnit);
      } else {
        openExecUnit = null;
        units.push({ recs: [r], size: unitSize([r], cur), withThought: cur });
      }
    } else if (r.role === "tool") {
      if (openExecUnit) {
        // Result belongs to the open tool-call block — same unit, always.
        openExecUnit.recs.push(r);
        openExecUnit.size += unitSize([r]);
      }
      // Orphan result (no owning call in view): dropped silently. This
      // generalizes the old "strip leading tool records" rule.
    } else {
      openExecUnit = null; // unknown roles break pairing context
    }
  }

  for (const u of units) u.size = unitSize(u.recs, u.withThought ?? false);

  // ---- Pass 2: whole-TASK retention ---------------------------------------
  // History is cut at task boundaries, never mid-story. A task = one user
  // message plus everything the agent did until the next user message. The
  // CURRENT task (last user message onward) is kept verbatim; older tasks
  // are kept complete, newest-first, while their total size fits the token
  // budget. The first older task that does not fit — and everything older
  // than it — disappears together, so the replayed story is always a
  // contiguous run of complete exchanges. (Partial per-unit keeps made the
  // model see orphan answers whose questions were gone.)
  const isUserUnit = (u: Unit) => u.recs[0]?.role === "user";
  const taskStarts: number[] = [];
  units.forEach((u, i) => {
    if (isUserUnit(u)) taskStarts.push(i);
  });

  const keep = new Array<boolean>(units.length).fill(false);
  let keptCount = 0;

  if (taskStarts.length === 0) {
    // No user message at all (degenerate): keep everything.
    for (let i = 0; i < units.length; i++) { keep[i] = true; keptCount++; }
  } else {
    // Preamble before the first user task: always kept.
    for (let i = 0; i < taskStarts[0]; i++) { keep[i] = true; keptCount++; }

    // Current task: last taskStart → end, verbatim.
    const currentStart = taskStarts[taskStarts.length - 1];
    for (let i = currentStart; i < units.length; i++) { keep[i] = true; keptCount++; }

    // Older tasks, newest-first, whole-or-nothing against the budget.
    let spent = 0;
    for (let t = taskStarts.length - 2; t >= 0; t--) {
      const startIdx = taskStarts[t];
      const endIdx = taskStarts[t + 1] - 1;
      let size = 0;
      for (let i = startIdx; i <= endIdx; i++) size += units[i].size;
      if (spent + size > budgetTokens) break;
      for (let i = startIdx; i <= endIdx; i++) { keep[i] = true; keptCount++; }
      spent += size;
    }
  }
  const keptUnits = units.filter((_, i) => keep[i]);

  // ---- Pass 3: aging — collapse old tool observations to receipts ---------
  let toolsSeen = 0;
  let toolsCollapsed = 0;
  for (let i = keptUnits.length - 1; i >= 0; i--) {
    for (let j = keptUnits[i].recs.length - 1; j >= 0; j--) {
      const r = keptUnits[i].recs[j];
      if (r.role !== "tool") continue;
      toolsSeen++;
      if (toolsSeen > recentFullTools) {
        // Never mutate the caller's records — swap in a receipt copy.
        keptUnits[i].recs[j] = { ...r, content: receiptFor(r) };
        toolsCollapsed++;
      }
    }
  }

  // ---- Pass 4: hard ceiling on record count (atomic unit aware) ------------
  // Slice by whole units from newest to oldest so assistant tool_calls and tool results are never split
  let totalRecs = 0;
  const unitsUnderCeiling: typeof keptUnits = [];
  for (let i = keptUnits.length - 1; i >= 0; i--) {
    const unit = keptUnits[i];
    if (unitsUnderCeiling.length > 0 && totalRecs + unit.recs.length > maxRecords) {
      break;
    }
    unitsUnderCeiling.unshift(unit);
    totalRecs += unit.recs.length;
  }
  const sliced = unitsUnderCeiling.flatMap((u) => u.recs);

  // ---- Pass 5: emit API-shaped messages -----------------------------------
  const messages: BuiltMessage[] = [];
  for (const r of sliced) {
    if (r.role === "user") {
      messages.push({ role: "user", content: r.content ?? "" });
    } else if (r.role === "assistant") {
      const calls = parseToolCalls(r.tool_calls);
      let body = r.content ?? "";
      if (retainThought && currentTask.has(r)) {
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
          const skillsMount = "/opt/skills";
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

  const tokensIn = units.reduce((a, u) => a + u.size, 0);
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
