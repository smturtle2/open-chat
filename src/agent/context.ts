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
  budgetChars?: number;
  recentFullTools?: number;
  maxRecords?: number;
}

export interface HistoryStats {
  recordsIn: number;
  recordsKept: number;
  unitsTotal: number;
  unitsDropped: number;
  toolsCollapsed: number;
  charsIn: number;
  charsKept: number;
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
type Unit = { recs: HistoryRecord[]; size: number };

function unitSize(recs: HistoryRecord[]): number {
  let n = 0;
  for (const r of recs) {
    n += OVERHEAD_PER_RECORD + (r.content?.length ?? 0);
    if (r.tool_calls) n += JSON.stringify(r.tool_calls).length;
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
  const budgetChars = opts.budgetChars ?? 120_000;
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

  // ---- Pass 2: backward walk under the char budget ------------------------
  // User-message units are NEVER budget-cut: they carry the task intent, and
  // dropping them yields payloads with zero user messages, which gateways
  // reject outright (observed: HTTP 400 "messages parameter is illegal").
  // Non-user units compete for the budget newest-first; the newest unit is
  // always kept even if it alone exceeds the budget.
  const isUserUnit = (u: Unit) => u.recs[0]?.role === "user";
  const keep = new Array<boolean>(units.length).fill(false);
  let spent = 0;
  let keptCount = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    if (isUserUnit(units[i])) {
      keep[i] = true;
      keptCount++;
      continue;
    }
    if (spent < budgetChars) {
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

  const charsIn = records.reduce((a, r) => a + (r.content?.length ?? 0), 0);
  const charsKept = sliced.reduce((a, r) => a + (r.content?.length ?? 0), 0);
  return {
    messages,
    stats: {
      recordsIn: records.length,
      recordsKept: sliced.length,
      unitsTotal: units.length,
      unitsDropped: units.length - keptCount,
      toolsCollapsed,
      charsIn,
      charsKept,
    },
  };
}
