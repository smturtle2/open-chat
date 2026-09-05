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
  if (prompt.includes("react")) chunks.push(content(react));
  else if (prompt.includes("mermaid")) chunks.push(content(diagram));
  else if (prompt.includes("slow")) {
    chunks.push({ choices: [{ delta: { reasoning_content: "Checking the task" } }] });
    for (let i = 0; i < 80; i++) chunks.push(content("Streaming "));
  } else if (last?.role !== "tool") {
    chunks.push({ choices: [{ delta: { reasoning_content: "Inspecting workspace" } }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: "fixture-call-" + Date.now(), type: "function", function: { name: "list_files", arguments: '{"path":"."}' } }] } }] });
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
