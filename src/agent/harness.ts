import path from "node:path";
import { CONFIG } from "../config.js";
import { db } from "../db/database.js";
import { tools } from "./tools.js";
import { extractJsonObjects, parseToolArguments } from "./jsonUtils.js";
import { buildHistory } from "./context.js";

type StreamingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

function generateCallId(): string {
  return "call_" + Math.random().toString(36).substring(2, 12);
}

export class AgentHarness {
  async runAutonomousLoop(sessionId: string, userPrompt: string, signal?: AbortSignal, model?: string) {
    // 1. Record new user message
    const userMsgId = "msg_" + Math.random().toString(36).substring(2, 11);
    db.addMessage({
      id: userMsgId,
      session_id: sessionId,
      role: "user",
      content: userPrompt,
    });
    db.appendEvent(sessionId, "user_message", { id: userMsgId, content: userPrompt });

    // 2. Execute assistant loop
    await this.runAssistantTurn(sessionId, signal, model);
  }

  async runAssistantTurn(sessionId: string, signal?: AbortSignal, model?: string) {
    db.updateSessionStatus(sessionId, "running");

    let turn = 0;
    const maxTurns = CONFIG.MAX_AGENT_TURNS;
    const maxConsecutiveErrors = 5;
    let consecutiveErrors = 0;
    const sessionWorkspace = path.join(CONFIG.WORKSPACES_ROOT, sessionId);

    // Autonomous loop: runs until the model delivers a final answer without tool calls, hits the turn cap, or is aborted.
    while (turn < maxTurns) {
      if (signal?.aborted) {
        db.appendEvent(sessionId, "task_interrupted", { message: "Task stopped by user" });
        break;
      }

      turn++;
      const rawMessages = db.getMessages(sessionId);
      const messagesForApi = this.prepareMessages(rawMessages, sessionWorkspace);

      db.appendEvent(sessionId, "turn_started", { turn });

      let currentThought = "";
      let currentContent = "";
      let inThinkTag = false;
      let tagBuffer = "";

      // Streamed deltas hit the DB in ~50ms batches instead of one INSERT
      // per token chunk. Order is preserved (single writer); the UI only
      // needs the aggregate text, so the coalescing delay is invisible.
      let pendingThoughtDelta = "";
      let pendingContentDelta = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushDeltas = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (pendingThoughtDelta) {
          db.appendEvent(sessionId, "thought_delta", { delta: pendingThoughtDelta });
          pendingThoughtDelta = "";
        }
        if (pendingContentDelta) {
          db.appendEvent(sessionId, "content_delta", { delta: pendingContentDelta });
          pendingContentDelta = "";
        }
      };
      const queueThoughtDelta = (d: string) => {
        pendingThoughtDelta += d;
        currentThought += d;
        if (!flushTimer) flushTimer = setTimeout(flushDeltas, 50);
      };
      const queueContentDelta = (d: string) => {
        pendingContentDelta += d;
        currentContent += d;
        if (!flushTimer) flushTimer = setTimeout(flushDeltas, 50);
      };
      const toolCallsList: StreamingToolCall[] = [];
      const toolNameSequence: string[] = [];
      let orphanArgBuffer = "";
      let activeToolIndex = 0;

      let response: Response | null = null;
      let attempt = 0;

      // Retry mechanism with exponential backoff for network/API resilience
      while (attempt < 3) {
        attempt++;
        try {
          response = await fetch(`${CONFIG.LLM_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CONFIG.LLM_API_KEY}`,
            },
            body: JSON.stringify({
              model: model || CONFIG.LLM_MODEL,
              messages: messagesForApi,
              tools: tools.getSchemas(),
              tool_choice: "auto",
              stream: true,
            }),
            signal,
          });

          if (response.ok && response.body) {
            consecutiveErrors = 0;
            break;
          }

          const errBody = await response.text();
          console.warn(`[Harness] API attempt ${attempt} failed with status ${response.status}: ${errBody.slice(0, 300)}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, attempt * 1000));
          }
        } catch (fetchErr: any) {
          if (signal?.aborted) break;
          console.warn(`[Harness] Fetch attempt ${attempt} error: ${fetchErr.message}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, attempt * 1000));
          }
        }
      }

      if (!response || !response.ok || !response.body) {
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          db.appendEvent(sessionId, "error", { message: "Failed to connect to LLM API after multiple attempts." });
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          if (signal?.aborted) break;

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") break;

            try {
              const chunk = JSON.parse(dataStr);
              const choice = chunk.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;

              // 1. Dedicated thinking delta (reasoning_content / reasoning / thought / thinking variants)
              const reasoningDelta =
                (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "") ||
                (typeof delta.reasoning === "string" ? delta.reasoning : "") ||
                (typeof delta.thought === "string" ? delta.thought : "") ||
                (typeof delta.thinking === "string" ? delta.thinking : "");
              if (reasoningDelta) {
                queueThoughtDelta(reasoningDelta);
              }

              // 2. Content delta with split-tag safe <think> parser
              const rawContent = delta.content || "";
              if (rawContent) {
                tagBuffer += rawContent;

                while (tagBuffer.length > 0) {
                  if (!inThinkTag) {
                    const openIdx = tagBuffer.indexOf("<think>");
                    if (openIdx !== -1) {
                      const before = tagBuffer.slice(0, openIdx);
                      if (before) {
                        queueContentDelta(before);
                      }
                      inThinkTag = true;
                      tagBuffer = tagBuffer.slice(openIdx + 7);
                    } else {
                      let partialLen = 0;
                      for (let len = Math.min(6, tagBuffer.length); len > 0; len--) {
                        if ("<think>".startsWith(tagBuffer.slice(-len))) {
                          partialLen = len;
                          break;
                        }
                      }

                      if (partialLen > 0) {
                        const safeText = tagBuffer.slice(0, -partialLen);
                        if (safeText) {
                          queueContentDelta(safeText);
                        }
                        tagBuffer = tagBuffer.slice(-partialLen);
                        break;
                      } else {
                        queueContentDelta(tagBuffer);
                        tagBuffer = "";
                      }
                    }
                  } else {
                    const closeIdx = tagBuffer.indexOf("</think>");
                    if (closeIdx !== -1) {
                      const thoughtPart = tagBuffer.slice(0, closeIdx);
                      if (thoughtPart) {
                        queueThoughtDelta(thoughtPart);
                      }
                      inThinkTag = false;
                      tagBuffer = tagBuffer.slice(closeIdx + 8);
                    } else {
                      let partialLen = 0;
                      for (let len = Math.min(7, tagBuffer.length); len > 0; len--) {
                        if ("</think>".startsWith(tagBuffer.slice(-len))) {
                          partialLen = len;
                          break;
                        }
                      }

                      if (partialLen > 0) {
                        const safeThought = tagBuffer.slice(0, -partialLen);
                        if (safeThought) {
                          queueThoughtDelta(safeThought);
                        }
                        tagBuffer = tagBuffer.slice(-partialLen);
                        break;
                      } else {
                        queueThoughtDelta(tagBuffer);
                        tagBuffer = "";
                      }
                    }
                  }
                }
              }

              // 3. Tool Calls delta - Strict ID & Index Pointer Isolation
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  // Track every distinct function name in arrival order (consecutive
                  // duplicates from re-sending gateways are collapsed). Used to
                  // reconstruct names when parallel calls get demuxed later.
                  if (tc.function?.name && toolNameSequence[toolNameSequence.length - 1] !== tc.function.name) {
                    toolNameSequence.push(tc.function.name);
                  }

                  let currentTool: StreamingToolCall | undefined;

                  if (tc.id) {
                    const existingIdx = toolCallsList.findIndex((t) => t.id === tc.id);
                    if (existingIdx === -1) {
                      toolCallsList.push({
                        id: tc.id,
                        name: tc.function?.name || "",
                        arguments: tc.function?.arguments || "",
                      });
                      activeToolIndex = toolCallsList.length - 1;
                    } else {
                      activeToolIndex = existingIdx;
                    }
                    currentTool = toolCallsList[activeToolIndex];
                  } else if (typeof tc.index === "number") {
                    activeToolIndex = tc.index;
                    if (!toolCallsList[activeToolIndex]) {
                      toolCallsList[activeToolIndex] = {
                        id: generateCallId(),
                        name: tc.function?.name || "",
                        arguments: "",
                      };
                    }
                    currentTool = toolCallsList[activeToolIndex];
                  } else {
                    // No id and no index: continuation of the most recent call.
                    currentTool = toolCallsList[activeToolIndex] || toolCallsList[toolCallsList.length - 1];
                  }

                  if (currentTool) {
                    // Flush argument chunks that arrived before any call was identifiable.
                    if (orphanArgBuffer) {
                      currentTool.arguments += orphanArgBuffer;
                      orphanArgBuffer = "";
                    }
                    if (tc.function?.name && !currentTool.name) {
                      currentTool.name = tc.function.name;
                    }
                    if (tc.function?.arguments) {
                      currentTool.arguments += tc.function.arguments;
                    }
                  } else if (tc.function?.arguments) {
                    orphanArgBuffer += tc.function.arguments;
                  }
                }
              }
            } catch {}
          }
        }

        if (tagBuffer) {
          if (inThinkTag) queueThoughtDelta(tagBuffer);
          else queueContentDelta(tagBuffer);
          tagBuffer = "";
        }
        flushDeltas();
      } catch (err: any) {
        flushDeltas();
        if (signal?.aborted) {
          db.appendEvent(sessionId, "task_interrupted", { message: "Task stopped by user" });
          break;
        }
        console.error(`[Harness] Stream error during turn ${turn}:`, err);
      }

      // ---- Finalize tool calls: lenient parse, repair, and de-multiplex ----
      const entries = toolCallsList.filter((tc) => tc.name || (tc.arguments && tc.arguments.trim()));

      const perEntryObjects: any[][] = entries.map((e) =>
        e.arguments && e.arguments.trim() ? extractJsonObjects(e.arguments) : []
      );
      const totalObjects = perEntryObjects.reduce((sum, arr) => sum + arr.length, 0);

      type FinalizedCall = { id: string; name: string; args: Record<string, any> };
      const finalizedCalls: FinalizedCall[] = [];

      const fallbackName = (slot: number): string =>
        toolNameSequence[slot] || entries[0]?.name || "bash";

      const asArgsObject = (value: any): Record<string, any> =>
        value !== undefined && typeof value === "object" && !Array.isArray(value)
          ? value
          : value === undefined
            ? {}
            : { raw: String(value) };

      // Concatenation detection: either more parsed objects than streaming slots,
      // or one slot swallowed several objects while another slot got none.
      const hasSwallowedSplit =
        perEntryObjects.some((a) => a.length > 1) && perEntryObjects.some((a) => a.length === 0);

      if (entries.length === 0) {
        // No usable tool calls detected.
      } else if (totalObjects > entries.length || (hasSwallowedSplit && totalObjects >= 2)) {
        // Provider concatenated parallel calls into fewer slots: flatten every
        // parsed object in arrival order and rebuild one call per object.
        const flatObjects = perEntryObjects.flat();
        flatObjects.forEach((obj, idx) => {
          finalizedCalls.push({
            id: idx === 0 ? entries[0].id || generateCallId() : generateCallId(),
            name: toolNameSequence[idx] || fallbackName(0),
            args: asArgsObject(obj),
          });
        });
      } else {
        entries.forEach((entry, idx) => {
          let args = perEntryObjects[idx][0];
          if (args === undefined) {
            args = parseToolArguments(entry.arguments);
          }
          finalizedCalls.push({
            id: entry.id || generateCallId(),
            name: entry.name || fallbackName(idx),
            args: asArgsObject(args),
          });
        });
      }

      // Format standard OpenAI tool_calls structure with guaranteed-valid JSON arguments
      const generatedToolCalls = finalizedCalls.map((fc) => ({
        id: fc.id,
        type: "function" as const,
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        },
      }));

      const parsedArgsById = new Map(finalizedCalls.map((fc) => [fc.id, fc.args]));

      // Clean empty content strings
      const sanitizedContent = currentContent.trim() || undefined;
      const sanitizedThought = currentThought.trim() || undefined;

      // Save assistant turn
      const assistantMsgId = "msg_" + Math.random().toString(36).substring(2, 11);
      db.addMessage({
        id: assistantMsgId,
        session_id: sessionId,
        role: "assistant",
        content: sanitizedContent || "",
        thought: sanitizedThought,
        tool_calls: generatedToolCalls.length > 0 ? generatedToolCalls : undefined,
      });

      db.appendEvent(sessionId, "assistant_message", {
        id: assistantMsgId,
        content: sanitizedContent || "",
        thought: sanitizedThought,
        tool_calls: generatedToolCalls,
      });

      // If no tool calls were requested, the model has delivered its final response and concluded the task
      if (generatedToolCalls.length === 0) {
        db.appendEvent(sessionId, "turn_completed", { turn });
        break;
      }

      // Execute tool calls autonomously and in parallel, while maintaining strict order
      const executionResults = await Promise.all(
        generatedToolCalls.map(async (tc) => {
          if (signal?.aborted) return { tc, observation: "Execution aborted by user." };

          let parsedArgs = parsedArgsById.get(tc.id);
          if (!parsedArgs) {
            parsedArgs = parseToolArguments(tc.function.arguments);
          }

          db.appendEvent(sessionId, "tool_executing", {
            id: tc.id,
            name: tc.function.name,
            args: parsedArgs,
          });

          let observation = "";
          try {
            observation = await tools.execute(tc.function.name, parsedArgs, sessionId, signal);
          } catch (toolErr: any) {
            observation = `Tool Execution Error: ${toolErr.message || String(toolErr)}`;
          }

          return { tc, observation };
        })
      );

      // Record tool messages in exact tool_calls order to guarantee API pairing compliance
      for (const res of executionResults) {
        if (!res) continue;
        const toolMsgId = "msg_" + Math.random().toString(36).substring(2, 11);
        db.addMessage({
          id: toolMsgId,
          session_id: sessionId,
          role: "tool",
          tool_call_id: res.tc.id,
          name: res.tc.function.name,
          content: res.observation,
        });

        db.appendEvent(sessionId, "tool_observed", {
          tool_call_id: res.tc.id,
          name: res.tc.function.name,
          observation: res.observation,
        });
      }

      if (signal?.aborted) {
        db.appendEvent(sessionId, "task_interrupted", { message: "Task stopped by user" });
        break;
      }
    }

    if (!signal?.aborted) {
      db.updateSessionStatus(sessionId, "idle");
    }
  }

  private prepareMessages(records: any[], workspaceDir: string): any[] {
    const systemPrompt = {
      role: "system",
      content: `You are OpenChat, an elite autonomous AI software engineering agent.
You operate inside an isolated session sandbox at: ${workspaceDir}
Your current working directory (CWD) is set to your sandbox root.

# History convention:
- Tool observations from earlier work may appear as one-line receipts like
  [bash · ok · 78.9KB · full copy: read_output {"id": 42}]. The call and its
  arguments are intact; only the output body is summarized. If you need the
  original output, retrieve it with read_output using the referenced id.

# Autonomous Workflow:
1. Deep Reasoning & Planning:
   - Before taking complex actions, formulate your step-by-step reasoning inside <think>...</think> tags.
2. Complete Multi-Step Autonomous Execution:
   - When the user asks you to solve a problem or build software, execute all necessary tools across multiple turns (e.g. search -> inspect -> write -> run tests -> verify).
   - If tests or commands fail, analyze the stderr error observation, fix the code, and re-run until passing.
   - When all implementation and verification are completely finished, output your final comprehensive answer without calling tools.
3. Direct Inline Link System:
   - When you create or deliver files (e.g. scripts, HTML documents, code files), embed direct inline markdown links in your response: e.g. [filename.py](filename.py) or [filename.html](filename.html).
   - The UI automatically renders these as direct 1-click download/open links for the user.
4. Radical Fluidity:
   - Call tools directly without unnecessary filler text.
   - You can execute multiple tools in parallel in a single turn.
5. All relative paths refer directly to your sandbox root.

# Tools:
- \`bash\`: Execute bash shell commands, install packages, run scripts, compile binaries, and run tests in the workspace sandbox.
- \`web_search\`: Search the web in real-time using DuckDuckGo.
- \`web_fetch\`: Single-page precision fetcher & scraper powered by Scrapling. Supports engine ('http', 'stealth' for Cloudflare/Turnstile bypass, 'dynamic' for JS rendering), selectors (CSS, XPath, Text, Regex), adaptive re-location, screenshots, and formats (markdown, text, html, links, json).
- \`web_crawl\`: Multi-page spider crawler powered by Scrapling. Crawls websites via sitemap.xml or link following with regex pattern filtering, extracts targeted content, and saves structured results to a file (JSON/CSV).
- \`read_file\`, \`write_file\`, \`patch_file\`: Inspect, create/overwrite, and surgically patch files in the sandbox.
- \`python\`: Execute Python 3 code for computation and analysis.`,
    };

    const { messages } = buildHistory(records, {
      budgetTokens: CONFIG.HISTORY_BUDGET_TOKENS,
      recentFullTools: CONFIG.HISTORY_RECENT_FULL_TOOLS,
    });

    return [systemPrompt, ...messages];
  }
}

export const harness = new AgentHarness();
