import { serve } from "@hono/node-server";
import { setTimeout as delay } from "node:timers/promises";
import { app } from "../../src/app.js";
import { createProvider, updateSettings } from "../../src/agent/providers.js";
import { syncBuiltinSkills } from "../../src/agent/skills.js";

syncBuiltinSkills();
const provider = createProvider({ id: "fixture", name: "Fixture", base_url: "http://localhost:1/v1" });
updateSettings({ default_provider: provider.id, default_model: "fixture-model" });
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("http://localhost:1/v1/")) throw new Error("Unexpected external request in test fixture");
  if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture-model", context_length: 32000 }] });
  const body = JSON.parse(String(init?.body));
  const prompt = body.messages.filter((m: any) => m.role === "user").at(-1)?.content || "";
  const last = body.messages.at(-1);
  const react = "```tsx\nimport { useState } from 'react';\nexport default function Counter() { const [n, setN] = useState<number>(0); return <button onClick={() => setN(n+1)}>Count {n}</button>; }\n```";
  const diagram = "```mermaid\ngraph LR\n  Start --> Done\n```";
  const chunks: any[] = [];
  const content = (text: string) => ({ choices: [{ delta: { content: text } }] });
  if (prompt.includes("프로젝트 구조")) chunks.push(content("## 프로젝트를 한눈에 보기\n\n이 프로젝트는 **대화 화면**, **에이전트 실행**, **데이터 저장**의 세 부분으로 구성되어 있습니다.\n\n| 영역 | 주요 역할 |\n| --- | --- |\n| 프론트엔드 | 메시지 작성, 실시간 답변, 파일 미리보기 |\n| 에이전트 | 모델 호출과 도구 실행 |\n| 데이터 | 대화 기록과 작업 파일 보관 |\n\n### 다음으로 살펴볼 부분\n\n1. 사용자가 자주 사용하는 대화 흐름을 확인합니다.\n2. 실패하거나 오래 걸리는 작업을 찾습니다.\n3. 작은 화면에서도 편하게 사용할 수 있는지 점검합니다.\n\n> 변경할 때는 실제 사용 흐름을 기준으로 확인하는 것이 좋습니다."));
  else if (prompt.includes("react")) chunks.push(content(react));
  else if (prompt.includes("mermaid")) chunks.push(content(diagram));
  else if (prompt.includes("slow")) {
    chunks.push({ choices: [{ delta: { reasoning_content: "Checking the task" } }] });
    for (let i = 0; i < 80; i++) chunks.push(content("Streaming "));
  } else if (last?.role !== "tool") {
    chunks.push({ choices: [{ delta: { reasoning_content: "Inspecting workspace" } }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: "fixture-call-" + Date.now(), type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: prompt.includes("failed tool") ? "missing-fixture-directory" : "." }) } }] } }] });
  } else chunks.push(content("Fixture response complete."));
  chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          await delay(prompt.includes("slow") ? 90 : 80, undefined, { signal: init?.signal ?? undefined });
          controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
        }
        controller.close();
      } catch (error) { try { controller.error(error); } catch {} }
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
};
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, info => console.log("READY " + info.port));
