// Unit tests for the deterministic history builder (budget cut + aging).
// Run: npx tsx tests/test_context.ts
import { buildHistory, receiptFor, HistoryRecord } from "../src/agent/context";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const user = (c: string): HistoryRecord => ({ role: "user", content: c });
const assistant = (c = ""): HistoryRecord => ({ role: "assistant", content: c });
const call = (id: string, name = "bash", argsObj: any = { cmd: "x" }): HistoryRecord => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(argsObj) } }],
});
const obs = (id: string, body: string, name = "bash"): HistoryRecord => ({
  role: "tool",
  tool_call_id: id,
  name,
  content: body,
});

// 1. Small history: everything kept verbatim, nothing collapsed.
{
  const recs = [user("hi"), call("a"), obs("a", "small out"), assistant("done")];
  const { messages, stats } = buildHistory(recs);
  check("small: all records kept", messages.length === 4);
  check("small: no receipts", stats.toolsCollapsed === 0);
  check("small: observation intact", messages.some((m) => m.content === "small out"));
}

// 2. Aging: >8 tool results → older ones collapse with read_output ref.
{
  const recs: HistoryRecord[] = [user("task")];
  for (let i = 0; i < 12; i++) recs.push(call(`c${i}`), obs(`c${i}`, `out ${i} ... archived as output #${100 + i}`));
  const { messages, stats } = buildHistory(recs, { recentFullTools: 8 });
  const toolMsgs = messages.filter((m) => m.role === "tool") as { content: string }[];
  check("aging: collapsed count", stats.toolsCollapsed === 4, `${stats.toolsCollapsed}`);
  const oldest = toolMsgs[0].content;
  check("aging: oldest is receipt", oldest.startsWith("[bash · ok ·"));
  check("aging: receipt carries read_output id", oldest.includes('read_output {"id": 100}'), oldest);
  check("aging: newest intact", toolMsgs[toolMsgs.length - 1].content === "out 11 ... archived as output #111");
}

// 3. Pair safety: budget cut must never orphan a tool result.
{
  const recs: HistoryRecord[] = [];
  for (let i = 0; i < 10; i++) {
    recs.push(user(`u${i}`));
    recs.push(call(`p${i}`, "bash", { cmd: "x".repeat(2000) }));
    recs.push(obs(`p${i}`, "y".repeat(20000)));
  }
  const { messages, stats } = buildHistory(recs, { budgetTokens: 9_000 });
  check("pair: first message not a tool result", messages[0].role !== "tool", String(messages[0].role));
  // Every tool result's preceding assistant must carry its tool_call id.
  let pairsOk = true;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      const prev = messages.slice(0, i).reverse().find((m) => m.role === "assistant");
      const ids = (prev?.tool_calls ?? []).map((t: any) => t.id);
      if (!ids.includes(messages[i].tool_call_id)) pairsOk = false;
    }
  }
  check("pair: all results have owning calls in context", pairsOk);
  check("pair: units were dropped", stats.unitsDropped > 0, `${stats.unitsDropped}`);
}

// 4. Receipt status hints.
{
  check(
    "status: timeout",
    receiptFor({ role: "tool", name: "bash", content: "partial...\n[timed out after 55s — killed; output above is partial]" }).includes("timed out")
  );
  check(
    "status: interrupted",
    receiptFor({ role: "tool", name: "bash", content: "x\n[interrupted after 3s by user — output above is partial]" }).includes("interrupted")
  );
  check("status: error", receiptFor({ role: "tool", name: "bash", content: "Error: boom" }).includes("error"));
  check("status: ok", receiptFor({ role: "tool", name: "web_search", content: "[Result 1]: fine" }).includes("ok"));
}

// 5. Content without archive ref: receipt without read_output tail.
{
  const r = receiptFor({ role: "tool", name: "write_file", content: "ok - wrote 12 bytes" });
  check("no-ref receipt: has size", r.includes("19B"), r);
  check("no-ref receipt: no read_output tail", !r.includes("read_output"), r);
}

// 6. Leading orphan tool results are dropped (generalized strip).
{
  const recs = [obs("ghost", "orphan"), user("q"), assistant("a")];
  const { messages } = buildHistory(recs);
  check("orphan: stripped", messages.length === 2 && messages[0].role === "user");
}

// 7. tool_calls as JSON string (DB shape) normalizes correctly.
{
  const recs: HistoryRecord[] = [
    {
      role: "assistant",
      content: "",
      // @ts-expect-error exercising DB string shape
      tool_calls: JSON.stringify([{ id: "z1", name: "bash", arguments: '{"cmd":"ls"}' }]),
    },
    obs("z1", "file.txt"),
  ];
  const { messages } = buildHistory(recs);
  const a = messages.find((m) => m.role === "assistant")!;
  const tc: any = (a.tool_calls ?? [])[0];
  check("normalize: function shape", tc?.function?.name === "bash" && typeof tc.function.arguments === "string");
}

// 8. Budget keeps the newest unit even if it alone exceeds the budget.
{
  const huge = obs("h", "z".repeat(300_000));
  const recs = [user("old"), call("o"), obs("o", "older"), user("new"), call("h"), huge];
  const { messages } = buildHistory(recs, { budgetTokens: 2_500 });
  check("oversize-last-unit: still present", messages.some((m) => m.content?.startsWith("zzz")));
}

// 9. Caller's records are never mutated by aging.
{
  const recs: HistoryRecord[] = [user("t")];
  for (let i = 0; i < 10; i++) recs.push(call(`m${i}`), obs(`m${i}`, `body ${i}`));
  const before = recs.map((r) => r.content);
  buildHistory(recs, { recentFullTools: 2 });
  check("immutable inputs", recs.every((r, i) => r.content === before[i]));
}

// 10. REGRESSION (2026-08-23 incident): the CURRENT task's user message and
// everything after it must survive any budget cut; older turns compete for
// the remaining token budget newest-first.
{
  const recs: HistoryRecord[] = [user("ORIGINAL TASK PROMPT")];
  for (let i = 0; i < 12; i++) {
    recs.push(call(`big${i}`, "write_file", { path: `f${i}.html`, content: "x".repeat(20_000) }));
    recs.push(obs(`big${i}`, "ok"));
    if (i % 4 === 3) recs.push(user(`follow-up ${i}`));
  }
  const { messages, stats } = buildHistory(recs, { budgetTokens: 9_000 });
  const allText = messages.map((m) => m.content ?? "").join("\n");
  check("regression: current-task user survives", allText.includes("follow-up 11"));
  check("regression: stale task prompt may be cut", !allText.includes("ORIGINAL TASK PROMPT"));
  check("regression: budget still cuts old units", stats.unitsDropped > 0, `${stats.unitsDropped}`);
  let pairsOk = true;
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as any).role === "tool") {
      const prev = messages.slice(0, i).reverse().find((m) => m.role === "assistant");
      const ids = ((prev as any)?.tool_calls ?? []).map((t: any) => t.id);
      if (!ids.includes(messages[i].tool_call_id)) pairsOk = false;
    }
  }
  check("regression: pairs intact after cut", pairsOk);
}

// 10b. Generous budget keeps everything, including all user turns.
{
  const { messages } = buildHistory(
    [user("old"), assistant("mid"), user("new")],
    { budgetTokens: 100_000 }
  );
  check("generous: all users kept", messages.filter(m => m.role === "user").length === 2);
}

// 11. A session whose ONLY unit is one oversized user message keeps it.
{
  const { messages } = buildHistory([user("y".repeat(200_000))], { budgetTokens: 2_500 });
  check("oversized lone user kept", messages.length === 1 && messages[0].content?.length === 200_000);
}

console.log(failures === 0 ? "\n>>> ALL PASSED" : `\n>>> ${failures} FAILURES`);
process.exit(failures ? 1 : 0);
