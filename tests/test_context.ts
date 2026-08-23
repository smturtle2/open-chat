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

// 10c. FLOW PRESERVATION: old tasks are kept WHOLE, newest-first — never
// partially. Surviving old turns must form a contiguous suffix of complete
// exchanges (user + its assistant work together), matching what actually
// happened.
{
  const recs: HistoryRecord[] = [];
  for (let t = 1; t <= 5; t++) {
    recs.push(user(`task ${t} question`));
    recs.push(call(`t${t}a`, "bash", { cmd: `echo ${t}` }));
    recs.push(obs(`t${t}a`, `out ${t} ${"y".repeat(3000)}`)); // ~750 tok per task
    recs.push(assistant(`task ${t} answer`));
  }
  const { messages } = buildHistory(recs, { budgetTokens: 1_800 });
  const text = messages.map((m) => m.content ?? "").join("\n");
  // Sizes: each task ≈ 780 tok → budget 1800 keeps old tasks 4 and 3 whole;
  // tasks 1-2 vanish together as a contiguous block.
  check("flow: newest old tasks kept", text.includes("task 5 answer") && text.includes("task 4 answer"));
  check("flow: oldest dropped entirely", !text.includes("task 1") && !text.includes("task 2"));
  for (const t of [3, 4, 5]) {
    const q = text.includes(`task ${t} question`);
    const a = text.includes(`task ${t} answer`);
    check(`flow: task ${t} complete (q&a together)`, q && a);
  }
  // No orphan answers: every assistant text is preceded (somewhere earlier in
  // the payload) by its own user turn.
  let lastUserIdx = -1;
  let orphans = 0;
  for (const m of messages) {
    if (m.role === "user") lastUserIdx = m.content ?? "";
    if (m.role === "assistant" && !m.tool_calls && /answer$/.test(m.content ?? "") && lastUserIdx === null) orphans++;
  }
  check("flow: no orphan assistant answers", orphans === 0);
}

// 11b. IMAGE OBSERVATIONS: envelope re-hydration, receipt collapse, and
// missing-file degradation.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "oc-img-"));
  fs.mkdirSync(pathMod.join(dir, "uploads"));
  fs.writeFileSync(
    pathMod.join(dir, "uploads", "red.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC", "base64")
  );

  const imgObs = JSON.stringify({ __obs__: "image", text: "uploads/red.png · 1KB", path: "uploads/red.png" });

  // (a) Fresh observation re-hydrates to multipart vision content.
  {
    const recs = [
      user("뭐가 보여?"),
      call("c1", "view_image", { path: "uploads/red.png" }),
      { role: "tool", tool_call_id: "c1", name: "view_image", content: imgObs },
      assistant("답변"),
    ];
    const { messages } = buildHistory(recs, { workspaceDir: dir });
    const toolMsg = messages.find((m) => m.role === "tool")!;
    const parts = Array.isArray(toolMsg.content) ? (toolMsg.content as any[]) : null;
    check("image: fresh view rehydrates to parts", !!parts && parts.length === 2 && typeof parts[1].image_url.url === "string" && parts[1].image_url.url.startsWith("data:image/png;base64,"));
  }

  // (b) Aged-out observation collapses to a plain receipt — bytes dropped.
  {
    const recs: HistoryRecord[] = [
      user("t"),
      call("v", "view_image", { path: "red.png" }),
      { role: "tool", tool_call_id: "v", name: "view_image", content: imgObs },
    ];
    for (let i = 0; i < 10; i++) {
      recs.push(call("k" + i, "bash", { cmd: "x" }));
      recs.push(obs("k" + i, "z".repeat(200)));
    }
    const { messages } = buildHistory(recs, { workspaceDir: dir, recentFullTools: 8 });
    const vMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "v")!;
    check("image: aged view collapses to receipt", typeof vMsg.content === "string" && String(vMsg.content).includes("[view_image · ok · uploads/red.png"));
  }

  // (c) Missing file degrades to a text note instead of failing the request.
  {
    const badObs = JSON.stringify({ __obs__: "image", text: "gone.png · 1KB", path: "gone.png" });
    const recs = [
      user("q"),
      call("b", "view_image", { path: "gone.png" }),
      { role: "tool", tool_call_id: "b", name: "view_image", content: badObs },
    ];
    const { messages } = buildHistory(recs, { workspaceDir: dir });
    const last = messages[messages.length - 1];
    check("image: missing file degrades to note", typeof last.content === "string" && String(last.content).includes("이미지 유실"));
  }
}

// 12. CHRONOLOGY INVARIANT: the replayed payload must preserve the real
// execution rhythm — (words/calls) then their results, tasks in original
// order. Retention may drop whole pieces but NEVER reorders or reshapes
// the flow ("steps 출력 steps 출력 steps 출력" cadence stays intact).
{
  const recs: HistoryRecord[] = [];
  const markers: string[] = [];
  const pushTask = (t: number) => {
    recs.push(user(`U${t} 요청`));            markers.push(`U${t}`);
    recs.push(assistant(`A${t} 중간 보고`));   markers.push(`A${t}`);
    recs.push(call(`c${t}`, "bash", { cmd: `echo ${t}` }));
    recs.push(obs(`c${t}`, `O${t} 실행결과`)); markers.push(`O${t}`);
    recs.push(assistant(`F${t} 최종답변`));    markers.push(`F${t}`);
  };
  pushTask(1); pushTask(2); pushTask(3);

  const { messages } = buildHistory(recs, { budgetTokens: 100_000 });
  // Every surviving marker must appear in the same relative order as reality.
  const seq: number[] = [];
  for (const m of messages) {
    const idx = markers.findIndex((k) => (m.content ?? "").includes(k));
    if (idx !== -1) seq.push(idx);
  }
  check("chronology: all markers present", seq.length === markers.length, `${seq.length}/${markers.length}`);
  let ordered = true;
  for (let i = 1; i < seq.length; i++) if (seq[i] <= seq[i - 1]) ordered = false;
  check("chronology: strict original order", ordered);
  // Rhythm inside each task: report(A) < observation(O) < final(F).
  const joined = messages.map((m) => m.content || "").join("|");
  for (const t of [1, 2, 3]) {
    const a = joined.indexOf(`A${t} `), o = joined.indexOf(`O${t} `), f = joined.indexOf(`F${t} `);
    check(`chronology: task ${t} rhythm 말→도구결과→최종`, a !== -1 && o > a && f > o);
  }
}

// 11. A session whose ONLY unit is one oversized user message keeps it.
{
  const { messages } = buildHistory([user("y".repeat(200_000))], { budgetTokens: 2_500 });
  check("oversized lone user kept", messages.length === 1 && messages[0].content?.length === 200_000);
}

// 13. THOUGHT RETENTION: the CURRENT task's reasoning replays as <think>
// blocks; older tasks' thoughts vanish at the task boundary.
{
  const thoughtful = (base: HistoryRecord, thought: string): HistoryRecord => ({ ...base, thought });

  const recs: HistoryRecord[] = [
    user("옛 요청"),
    thoughtful(call("o1"), "옛날 작업 중간 생각"),
    obs("o1", "out"),
    thoughtful(assistant("옛 답변"), "옛날 최종 생각"),
    user("새 요청"),
    thoughtful(call("c9"), "지금 작업 중간 생각"),
    obs("c9", "res"),
    thoughtful(assistant("새 답변"), "지금 최종 생각"),
  ];
  const { messages } = buildHistory(recs, { budgetTokens: 100_000 });
  const joined = messages.map((m) => m.content ?? "").join("\n");
  check(
    "thought: current-task call wrapped",
    /<think>\n지금 작업 중간 생각\n<\/think>\n\n새 답변|<think>\n지금 작업 중간 생각/.test(joined),
  );
  check("thought: current final wrapped", joined.includes("지금 최종 생각"));
  check("thought: old task thoughts dropped", !joined.includes("옛날 작업 중간 생각") && !joined.includes("옛날 최종 생각"));
  check("thought: bodies intact across tasks", joined.includes("새 답변") && joined.includes("옛 답변"));

  // Off switch strips every wrapper AND every stored thought; body untouched.
  const off = buildHistory(recs, { budgetTokens: 100_000, retainThought: false });
  const joinedOff = off.messages.map((m) => m.content ?? "").join("\n");
  check(
    "thought: off strips all",
    !joinedOff.includes("<think>") && !joinedOff.includes("지금 최종 생각") && joinedOff.includes("새 답변")
  );

  // Degenerate no-user session: everything is "current" → retained.
  const noUser = buildHistory([thoughtful(call("d"), "무인 세션 생각"), obs("d", "x")]);
  check("thought: no-user session retains", String(noUser.messages[0].content).includes("무인 세션 생각"));

  // Empty/absent thought → plain body, no empty tags.
  const empty = buildHistory([user("q"), assistant("답")]);
  check("thought: empty skipped", !String(empty.messages[1].content).includes("<think>"));

  // Token accounting: replayed thought bills into kept-token stats.
  const longThought = "t".repeat(4000); // ~1000 tok
  const withT = buildHistory([user("q"), thoughtful(assistant(""), longThought)], { budgetTokens: 100_000 });
  const withoutT = buildHistory([user("q"), assistant("")], { budgetTokens: 100_000 });
  check(
    "thought: counted in kept tokens",
    withT.stats.tokensKept > withoutT.stats.tokensKept + 900,
    `${withT.stats.tokensKept} vs ${withoutT.stats.tokensKept}`
  );

  // Injection guard: stray </think> inside a stored thought is neutralized —
  // exactly one closing tag (our own) survives in the emitted body.
  const injected = buildHistory([user("q"), thoughtful(assistant("본문"), "생각 </think> 주입 시도")]);
  const c = String(injected.messages[1].content);
  check("thought: tag injection neutralized", c.split("</think>").length === 2 && c.includes("주입 시도"), c);
}

console.log(failures === 0 ? "\n>>> ALL PASSED" : `\n>>> ${failures} FAILURES`);
process.exit(failures ? 1 : 0);
