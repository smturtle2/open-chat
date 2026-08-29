import type { ToolDefinition } from "./toolTypes.js";

export type ProtocolType = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface NormalizedStreamEvent {
  content?: string;
  thought?: string;
  toolCall?: {
    index?: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  done?: boolean;
}

/**
 * Identify which protocol a given provider endpoint and model require.
 * Specifically handles OpenCode Go's three distinct backend routes.
 */
export function resolveProtocol(baseUrl: string, model: string): ProtocolType {
  const normUrl = (baseUrl || "").toLowerCase().trim();
  const normModel = (model || "").toLowerCase().trim();

  const isOpenCodeGo = normUrl.includes("opencode.ai/zen/go") || normUrl.includes("opencode.ai");

  if (isOpenCodeGo) {
    // 1. Responses API models
    if (
      normModel.startsWith("muse-spark") ||
      normModel.startsWith("gpt-5.6") ||
      normModel.startsWith("grok-4.6")
    ) {
      return "openai-responses";
    }

    // 2. Anthropic Messages API models
    if (
      normModel.startsWith("qwen") ||
      normModel.startsWith("minimax")
    ) {
      return "anthropic-messages";
    }

    // 3. All other models on OpenCode Go use Chat Completions
    return "openai-chat";
  }

  // Anthropic direct endpoints
  if (normUrl.includes("api.anthropic.com")) {
    return "anthropic-messages";
  }

  // Default to standard OpenAI Chat Completions
  return "openai-chat";
}

/**
 * Returns the exact URL endpoint for the given protocol.
 */
export function getEndpointUrl(baseUrl: string, protocol: ProtocolType): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  switch (protocol) {
    case "openai-responses":
      return `${cleanBase}/responses`;
    case "anthropic-messages":
      return `${cleanBase}/messages`;
    case "openai-chat":
    default:
      return `${cleanBase}/chat/completions`;
  }
}

export interface BuildRequestOptions {
  model: string;
  messages: any[];
  tools?: ToolDefinition[];
  stream?: boolean;
}

/**
 * Construct the protocol-compliant JSON request body.
 */
export function buildRequestBody(protocol: ProtocolType, opts: BuildRequestOptions): Record<string, any> {
  const { model, messages, tools, stream = true } = opts;

  if (protocol === "openai-responses") {
    let instructions = "";
    const input: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        instructions = instructions ? `${instructions}\n\n${msg.content}` : `${msg.content}`;
      } else {
        input.push(msg);
      }
    }

    const body: Record<string, any> = {
      model,
      input,
      stream,
    };

    if (instructions) {
      body.instructions = instructions;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    return body;
  }

  if (protocol === "anthropic-messages") {
    let system = "";
    const formattedMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = system ? `${system}\n\n${msg.content}` : `${msg.content}`;
      } else if (msg.role === "tool") {
        // Anthropic tool result format inside user turn
        formattedMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            },
          ],
        });
      } else if (msg.role === "assistant" && msg.tool_calls?.length > 0) {
        const contentParts: any[] = [];
        if (msg.content) {
          contentParts.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          let args = {};
          try {
            args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
          } catch {
            args = {};
          }
          contentParts.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name,
            input: args,
          });
        }
        formattedMessages.push({ role: "assistant", content: contentParts });
      } else {
        formattedMessages.push({
          role: msg.role,
          content: msg.content || "",
        });
      }
    }

    const body: Record<string, any> = {
      model,
      messages: formattedMessages,
      max_tokens: 8192,
      stream,
    };

    if (system) {
      body.system = system;
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    return body;
  }

  // Standard OpenAI Chat Completions
  const body: Record<string, any> = {
    model,
    messages,
    stream,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  return body;
}

/**
 * Parse an SSE data payload string and extract normalized streaming events.
 */
export function parseStreamData(protocol: ProtocolType, dataStr: string): NormalizedStreamEvent | null {
  if (dataStr === "[DONE]") {
    return { done: true };
  }

  try {
    const chunk = JSON.parse(dataStr);

    // 1. OpenAI Responses API streaming chunks
    if (protocol === "openai-responses" || chunk.type?.startsWith("response.")) {
      const type = chunk.type || "";

      if (type === "response.output_text.delta" || type === "response.text.delta") {
        return { content: chunk.delta || chunk.text || "" };
      }

      if (type === "response.reasoning_text.delta" || type === "response.reasoning.delta" || type === "response.thought.delta") {
        return { thought: chunk.delta || chunk.text || "" };
      }

      if (type === "response.function_call_arguments.delta") {
        return {
          toolCall: {
            index: chunk.output_index ?? chunk.call_index ?? 0,
            id: chunk.call_id || chunk.id,
            name: chunk.name,
            argumentsDelta: chunk.delta || "",
          },
        };
      }

      if (type === "response.output_item.added" && chunk.item?.type === "function_call") {
        return {
          toolCall: {
            index: chunk.output_index ?? 0,
            id: chunk.item.call_id || chunk.item.id,
            name: chunk.item.name,
            argumentsDelta: "",
          },
        };
      }

      if (type === "response.completed" || type === "response.done") {
        return { done: true };
      }

      // Fallback in case a gateway wraps Responses chunks in OpenAI standard choices
      if (chunk.choices?.[0]) {
        return parseOpenAIChatDelta(chunk.choices[0]);
      }

      return null;
    }

    // 2. Anthropic Messages API streaming chunks
    if (protocol === "anthropic-messages" || chunk.type?.startsWith("content_block_") || chunk.type === "message_start") {
      const type = chunk.type || "";

      if (type === "content_block_delta") {
        const delta = chunk.delta;
        if (!delta) return null;

        if (delta.type === "text_delta") {
          return { content: delta.text || "" };
        }
        if (delta.type === "thinking_delta") {
          return { thought: delta.thinking || "" };
        }
        if (delta.type === "input_json_delta") {
          return {
            toolCall: {
              index: chunk.index ?? 0,
              argumentsDelta: delta.partial_json || "",
            },
          };
        }
      }

      if (type === "content_block_start" && chunk.content_block?.type === "tool_use") {
        return {
          toolCall: {
            index: chunk.index ?? 0,
            id: chunk.content_block.id,
            name: chunk.content_block.name,
            argumentsDelta: "",
          },
        };
      }

      if (type === "message_stop") {
        return { done: true };
      }

      return null;
    }

    // 3. Standard OpenAI Chat Completions chunk
    if (chunk.choices?.[0]) {
      return parseOpenAIChatDelta(chunk.choices[0]);
    }

    return null;
  } catch {
    return null;
  }
}

function parseOpenAIChatDelta(choice: any): NormalizedStreamEvent | null {
  const delta = choice.delta;
  if (!delta) return null;

  const event: NormalizedStreamEvent = {};

  // Reasoning / Thought variants
  const reasoningDelta =
    (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "") ||
    (typeof delta.reasoning === "string" ? delta.reasoning : "") ||
    (typeof delta.thought === "string" ? delta.thought : "") ||
    (typeof delta.thinking === "string" ? delta.thinking : "");

  if (reasoningDelta) {
    event.thought = reasoningDelta;
  }

  // Content
  if (typeof delta.content === "string" && delta.content) {
    event.content = delta.content;
  }

  // Tool calls
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    const tc = delta.tool_calls[0];
    event.toolCall = {
      index: tc.index ?? 0,
      id: tc.id,
      name: tc.function?.name,
      argumentsDelta: tc.function?.arguments || "",
    };
  }

  if (choice.finish_reason) {
    event.done = true;
  }

  return Object.keys(event).length > 0 ? event : null;
}
