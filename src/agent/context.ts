// History assembly for the model-facing prompt.
//
// Two mechanisms, both deterministic (no LLM in the loop):
//   1. Budget cut — walk units back-to-front until the char budget is spent.
//      Units are never split mid-pair: an assistant message carrying
//      tool_calls and its role:"tool" results always move together, so the
//      API's pairing invariant can never be violated by a cut.
//   2. Aging — tool observations older than `recentFullTools` collapse to a
//     one-line receipt. The call record and its arguments stay visible; only
//     the bulky output body is replaced. Full copies remain recoverable via
//     read_output {"id": N} whenever the original surface referenced one.

export type HistoryRecord = {
  id?: string;
  role: string;
  content?: string | null;
  tool_call_id?: string | null;
  name?: string | null;
  tool_calls?: any;
};

export interface HistoryOptions {
  /** Token ceiling for retained history (script-aware estimate). */
  budgetTokens?: number;
  recentFullTools?: number;
  maxRecords?: number;
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
  content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: any[];
}

const OVERHEAD_PER_RECORD = 24;

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
// which are billed like any other prompt text).
type Unit = { recs: HistoryRecord[]; size: number };

const OVERHEAD_TOKENS_PER_RECORD = Math.ceil(OVERHEAD_PER_RECORD / 4);

function unitSize(recs: HistoryRecord[]): number {
  let n = 0;
  for (const r of recs) {
    n += OVERHEAD_TOKENS_PER_RECORD + estimateTokens(r.content ?? "");
    if (r.tool_calls) n += estimateTokens(JSON.stringify(r.tool_calls));
  }
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
  const content = rec.content ?? "";
  const name = rec.name || "tool";
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

  // ---- Pass 1: group records into pair-safe units -------------------------
  const units: Unit[] = [];
  let openExecUnit: Unit | null = null;

  for (const r of records) {
    if (r.role === "user") {
      openExecUnit = null;
      units.push({ recs: [r], size: unitSize([r]) });
    } else if (r.role === "assistant") {
      const calls = parseToolCalls(r.tool_calls);
      if (calls.length > 0) {
        openExecUnit = { recs: [r], size: 0 };
        units.push(openExecUnit);
      } else {
        openExecUnit = null;
        units.push({ recs: [r], size: unitSize([r]) });
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

  for (const u of units) u.size = unitSize(u.recs);

  // ---- Pass 2: current task verbatim, older history under token budget ----
  // The CURRENT task starts at its (last) user message; that unit and
  // everything after it are kept whole — they are live work, and dropping the
  // active user message yields payloads with no user turn at all, which
  // gateways reject outright (observed: HTTP 400 "messages parameter is
  // illegal"). Everything OLDER competes newest-first under the token budget;
  // the newest older unit is still kept even if it alone exceeds what's left.
  const isUserUnit = (u: Unit) => u.recs[0]?.role === "user";
  let currentUserIdx = -1;
  for (let i = units.length - 1; i >= 0; i--) {
    if (isUserUnit(units[i])) { currentUserIdx = i; break; }
  }
  const keep = new Array<boolean>(units.length).fill(false);
  let keptCount = 0;
  if (currentUserIdx !== -1) {
    for (let i = currentUserIdx; i < units.length; i++) { keep[i] = true; keptCount++; }
  }
  let spent = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    if (keep[i]) continue;
    if (spent < budgetTokens) {
      keep[i] = true;
      keptCount++;
      spent += units[i].size;
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

  // ---- Pass 4: hard ceiling on record count -------------------------------
  const flat = keptUnits.flatMap((u) => u.recs);
  const sliced = flat.slice(-maxRecords);

  // ---- Pass 5: emit API-shaped messages -----------------------------------
  const messages: BuiltMessage[] = [];
  for (const r of sliced) {
    if (r.role === "user") {
      messages.push({ role: "user", content: r.content ?? "" });
    } else if (r.role === "assistant") {
      const calls = parseToolCalls(r.tool_calls);
      const msg: BuiltMessage = { role: "assistant", content: r.content ?? "" };
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
      messages.push({ role: "tool", tool_call_id: r.tool_call_id ?? "", name: r.name ?? undefined, content: r.content ?? "" });
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
