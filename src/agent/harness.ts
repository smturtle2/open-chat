import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../config.js";
import { db } from "../db/database.js";
import { tools, type ToolContext, serializeObservation } from "./tools.js";
import { extractJsonObjects, parseToolArguments } from "./jsonUtils.js";
import { buildHistory } from "./context.js";
import { resolveEndpoint } from "./providers.js";
import { buildSystemPrompt } from "./prompt.js";
import { chatWorkspaceDir, sessionRoot } from "./sessionPaths.js";
import { getEndpointUrl, buildRequestBody, parseStreamData } from "./protocols.js";

type StreamingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

function generateCallId(): string {
  return "call_" + Math.random().toString(36).substring(2, 12);
}

export class AgentHarness {
  async runAutonomousLoop(sessionId: string, userPrompt: string, signal?: AbortSignal, model?: string, attachmentIds: string[] = []) {
    // 1. Record new user message — plain text only. Attachment markers are a
    // PROMPT-construction concern: they get appended in prepareMessages from
    // the attachments table, never stored in the transcript the user sees.
    const userMsgId = "msg_" + Math.random().toString(36).substring(2, 11);
    const claimed = db.claimAttachments(userMsgId, sessionId, attachmentIds);
    db.addMessage({
      id: userMsgId,
      session_id: sessionId,
      role: "user",
      content: userPrompt,
    });
    db.appendEvent(sessionId, "user_message", {
      id: userMsgId,
      content: userPrompt,
      attachments: claimed.map((a) => ({ kind: a.kind, name: a.name, path: a.path, size: a.size, mime: a.mime })),
    });

    // 2. Execute assistant loop
    await this.runAssistantTurn(sessionId, signal, model);
  }

  async runAssistantTurn(sessionId: string, signal?: AbortSignal, model?: string) {
    db.updateSessionStatus(sessionId, "running");

    const session = db.getSession(sessionId);
    if (!session) {
      return;
    }
    // Agent sessions work in a real host directory; chat sessions get their
    // disposable workspace. Everything downstream (tools, prompt, history)
    // derives from these two values.
    const sessionRootDir = sessionRoot(session);
    if (!fs.existsSync(sessionRootDir)) {
      if (session.mode === "agent") {
        db.appendEvent(sessionId, "error", { message: `작업 디렉토리가 존재하지 않습니다: ${session.workdir}` });
        db.updateSessionStatus(sessionId, "idle");
        return;
      }
      chatWorkspaceDir(sessionId);
    }

    const endpoint = resolveEndpoint({ provider: session.provider, model: model || session.model });

    let turn = 0;
    const maxTurns = CONFIG.MAX_AGENT_TURNS;
    const maxConsecutiveErrors = 5;
    let consecutiveErrors = 0;
    // Empty-completion guard: upstream instability can terminate a stream
    // after reasoning only — no content, no tool_calls (observed live).
    // Treating that as "final answer" silently ends the task with an
    // invisible message, which looks like a frozen chat from the UI side.
    let emptyCompletions = 0;
    const maxEmptyCompletions = 2;

    const toolCtx: ToolContext = {
      sessionId,
      mode: session.mode,
      cwd: sessionRootDir,
    };

    // Autonomous loop: runs until the model delivers a final answer without tool calls, hits the turn cap, or is aborted.
    while (turn < maxTurns) {
      if (signal?.aborted) {
        db.appendEvent(sessionId, "task_interrupted", { message: "Task stopped by user" });
        break;
      }

      turn++;
      const rawMessages = db.getMessages(sessionId);
      const messagesForApi = await this.prepareMessages(session, sessionRootDir, rawMessages);

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

      const targetUrl = getEndpointUrl(endpoint.baseUrl, endpoint.protocol);
      const requestBody = buildRequestBody(endpoint.protocol, {
        model: endpoint.model,
        messages: messagesForApi,
        tools: tools.getSchemas(session.mode),
        stream: true,
      });

      const requestHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      };

      if (endpoint.protocol === "anthropic-messages") {
        requestHeaders["x-api-key"] = endpoint.apiKey;
        requestHeaders["anthropic-version"] = "2023-06-01";
      }

      // Retry mechanism with exponential backoff for network/API resilience
      while (attempt < 3) {
        attempt++;
        try {
          response = await fetch(targetUrl, {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(requestBody),
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
              const event = parseStreamData(endpoint.protocol, dataStr);
              if (!event) continue;

              if (event.done) break;

              // 1. Dedicated thinking delta
              if (event.thought) {
                queueThoughtDelta(event.thought);
              }

              // 2. Content delta with split-tag safe <think> parser
              const rawContent = event.content || "";
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
              const incomingCalls = event.toolCalls || (event.toolCall ? [event.toolCall] : []);
              for (const tc of incomingCalls) {
                if (tc.name && toolNameSequence[toolNameSequence.length - 1] !== tc.name) {
                  toolNameSequence.push(tc.name);
                }

                let currentTool: StreamingToolCall | undefined;

                if (tc.id) {
                  const existingIdx = toolCallsList.findIndex((t) => t.id === tc.id);
                  if (existingIdx === -1) {
                    toolCallsList.push({
                      id: tc.id,
                      name: tc.name || "",
                      arguments: "",
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
                      name: tc.name || "",
                      arguments: "",
                    };
                  }
                  currentTool = toolCallsList[activeToolIndex];
                } else {
                  currentTool = toolCallsList[activeToolIndex] || toolCallsList[toolCallsList.length - 1];
                }

                if (currentTool) {
                  if (orphanArgBuffer) {
                    currentTool.arguments += orphanArgBuffer;
                    orphanArgBuffer = "";
                  }
                  if (tc.name && !currentTool.name) {
                    currentTool.name = tc.name;
                  }
                  if (tc.argumentsDelta) {
                    currentTool.arguments += tc.argumentsDelta;
                  }
                } else if (tc.argumentsDelta) {
                  orphanArgBuffer += tc.argumentsDelta;
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

      // An empty completion — no text and no tool calls — is a dead round,
      // not a finished task. Retry the round (history was not touched yet);
      // after repeated failures surface a visible error instead of ending
      // the turn with an invisible answer.
      if (generatedToolCalls.length === 0 && !sanitizedContent) {
        flushDeltas();
        if (emptyCompletions < maxEmptyCompletions) {
          emptyCompletions++;
          console.warn(`[Harness] Empty completion (round ${turn}, attempt ${emptyCompletions}/${maxEmptyCompletions}) — retrying`);
          db.appendEvent(sessionId, "empty_response_retry", { attempt: emptyCompletions });
          turn--;
          continue;
        }
        emptyCompletions = 0;
        db.appendEvent(sessionId, "error", { message: "모델이 빈 응답을 반복했습니다. 메시지를 다시 보내거나 재생성해 주세요." });
        db.appendEvent(sessionId, "turn_completed", { turn });
        break;
      }
      emptyCompletions = 0;

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
            const result = await tools.execute(tc.function.name, parsedArgs, toolCtx, signal);
            observation = typeof result === "string" ? result : serializeObservation(result);
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

  private async prepareMessages(session: { mode: "chat" | "agent" }, sessionRootDir: string, records: any[]): Promise<any[]> {
    // Attachment markers are appended here — prompt-only decoration. The
    // transcript stays clean; every replay still tells the model where its
    // files live.
    const enriched = await Promise.all(
      records.map(async (r) => {
        if (r.role !== "user" || !r.id) return r;
        const atts = db.getMessageAttachments(r.id);
        if (atts.length === 0) return r;
        const markers = atts
          .filter((a) => a.kind !== "skill")
          .map((a) => {
            const kb = a.size >= 1024 ? `${(a.size / 1024).toFixed(0)}KB` : `${a.size}B`;
            return a.kind === "image" ? `[첨부 이미지: ${a.path} · ${kb}]` : `[첨부 파일: ${a.path} · ${kb}]`;
          })
          .join("\n");
        let content = `${r.content ?? ""}`;
        if (markers) content += `\n\n${markers}`;
        // Slash skill hints ("/name ...") stay verbatim in the transcript;
        // the model resolves them via load_skill (see skillsSection hint).
        return { ...r, content };
      })
    );

    const systemPrompt = buildSystemPrompt({ mode: session.mode, rootDir: sessionRootDir });

    const { messages } = buildHistory(enriched, {
      budgetTokens: CONFIG.HISTORY_BUDGET_TOKENS,
      recentFullTools: CONFIG.HISTORY_RECENT_FULL_TOOLS,
      retainThought: CONFIG.THOUGHT_RETENTION,
      workspaceDir: sessionRootDir,
    });

    return [systemPrompt, ...messages];
  }
}

export const harness = new AgentHarness();
