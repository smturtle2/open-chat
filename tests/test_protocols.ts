import { resolveProtocol, getEndpointUrl, buildRequestBody, parseStreamData } from "../src/agent/protocols.js";
import { tools } from "../src/agent/tools.js";

function check(label: string, cond: boolean) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

async function main() {
  console.log("=== Testing Multi-Protocol Adapter ===");

  // 1. Protocol resolution tests
  const opencodeBase = "https://opencode.ai/zen/go/v1";
  check("OpenCode Go: muse-spark routes to openai-responses", resolveProtocol(opencodeBase, "muse-spark-1.2-contributor") === "openai-responses");
  check("OpenCode Go: gpt-5.6-luna routes to openai-responses", resolveProtocol(opencodeBase, "gpt-5.6-luna") === "openai-responses");
  check("OpenCode Go: grok-4.6 routes to openai-responses", resolveProtocol(opencodeBase, "grok-4.6") === "openai-responses");

  check("OpenCode Go: qwen3.7-max routes to anthropic-messages", resolveProtocol(opencodeBase, "qwen3.7-max") === "anthropic-messages");
  check("OpenCode Go: minimax-m3 routes to anthropic-messages", resolveProtocol(opencodeBase, "minimax-m3") === "anthropic-messages");

  check("OpenCode Go: deepseek-v4-pro routes to openai-chat", resolveProtocol(opencodeBase, "deepseek-v4-pro") === "openai-chat");
  check("OpenCode Go: glm-5.3 routes to openai-chat", resolveProtocol(opencodeBase, "glm-5.3") === "openai-chat");
  check("OpenCode Go: kimi-k3 routes to openai-chat", resolveProtocol(opencodeBase, "kimi-k3") === "openai-chat");

  check("OpenRouter routes to openai-chat", resolveProtocol("https://openrouter.ai/api/v1", "anthropic/claude-3.7-sonnet") === "openai-chat");
  check("Anthropic direct routes to anthropic-messages", resolveProtocol("https://api.anthropic.com/v1", "claude-3-7-sonnet-20250219") === "anthropic-messages");

  // 2. Endpoint URL resolution
  check("getEndpointUrl for openai-responses", getEndpointUrl(opencodeBase, "openai-responses") === "https://opencode.ai/zen/go/v1/responses");
  check("getEndpointUrl for anthropic-messages", getEndpointUrl(opencodeBase, "anthropic-messages") === "https://opencode.ai/zen/go/v1/messages");
  check("getEndpointUrl for openai-chat", getEndpointUrl(opencodeBase, "openai-chat") === "https://opencode.ai/zen/go/v1/chat/completions");

  // 3. Request body construction tests
  const sampleMessages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ];
  const sampleTools = tools.getSchemas("chat");

  // 3-1. openai-responses request body
  const responsesBody = buildRequestBody("openai-responses", {
    model: "muse-spark-1.2-contributor",
    messages: sampleMessages,
    tools: sampleTools,
    stream: true,
  });
  check("responses body has model", responsesBody.model === "muse-spark-1.2-contributor");
  check("responses body has instructions", responsesBody.instructions === "You are a helpful assistant.");
  check("responses body separates input from system", responsesBody.input.length === 1 && responsesBody.input[0].role === "user");
  check("responses body includes tools", responsesBody.tools?.length > 0);
  check("responses body has stream", responsesBody.stream === true);

  // 3-2. anthropic-messages request body
  const messagesBody = buildRequestBody("anthropic-messages", {
    model: "qwen3.7-max",
    messages: sampleMessages,
    tools: sampleTools,
    stream: true,
  });
  check("messages body has model", messagesBody.model === "qwen3.7-max");
  check("messages body has system", messagesBody.system === "You are a helpful assistant.");
  check("messages body formats messages array", messagesBody.messages.length === 1 && messagesBody.messages[0].role === "user");
  check("messages body sets max_tokens", messagesBody.max_tokens === 8192);
  check("messages body converts tools to input_schema", messagesBody.tools?.[0]?.input_schema !== undefined);

  // 3-3. openai-chat request body
  const chatBody = buildRequestBody("openai-chat", {
    model: "deepseek-v4-pro",
    messages: sampleMessages,
    tools: sampleTools,
    stream: true,
  });
  check("chat body has model", chatBody.model === "deepseek-v4-pro");
  check("chat body preserves full messages array", chatBody.messages.length === 2);
  check("chat body has tool_choice auto", chatBody.tool_choice === "auto");

  // 4. Stream event parsing tests
  // 4-1. Responses API chunk parsing
  const respTextChunk = JSON.stringify({
    type: "response.output_text.delta",
    delta: "Hello from Muse Spark!",
  });
  const parsedRespText = parseStreamData("openai-responses", respTextChunk);
  check("responses text delta parsed", parsedRespText?.content === "Hello from Muse Spark!");

  const respThoughtChunk = JSON.stringify({
    type: "response.reasoning_text.delta",
    delta: "Thinking step 1...",
  });
  const parsedRespThought = parseStreamData("openai-responses", respThoughtChunk);
  check("responses thought delta parsed", parsedRespThought?.thought === "Thinking step 1...");

  const respToolCallChunk = JSON.stringify({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    call_id: "call_abc123",
    name: "bash",
    delta: '{"command":"ls"}',
  });
  const parsedRespTool = parseStreamData("openai-responses", respToolCallChunk);
  check("responses tool call delta parsed", parsedRespTool?.toolCall?.argumentsDelta === '{"command":"ls"}' && parsedRespTool?.toolCall?.id === "call_abc123");

  const respDoneChunk = JSON.stringify({ type: "response.completed" });
  check("responses completed parsed as done", parseStreamData("openai-responses", respDoneChunk)?.done === true);
  check("DONE token parsed as done", parseStreamData("openai-responses", "[DONE]")?.done === true);

  // 4-2. Anthropic Messages API chunk parsing
  const anthropicTextChunk = JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello from Qwen!" },
  });
  const parsedAnthropicText = parseStreamData("anthropic-messages", anthropicTextChunk);
  check("anthropic text delta parsed", parsedAnthropicText?.content === "Hello from Qwen!");

  const anthropicThinkingChunk = JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Qwen reasoning..." },
  });
  const parsedAnthropicThinking = parseStreamData("anthropic-messages", anthropicThinkingChunk);
  check("anthropic thinking delta parsed", parsedAnthropicThinking?.thought === "Qwen reasoning...");

  const anthropicToolChunk = JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"query":"test"}' },
  });
  const parsedAnthropicTool = parseStreamData("anthropic-messages", anthropicToolChunk);
  check("anthropic tool input delta parsed", parsedAnthropicTool?.toolCall?.argumentsDelta === '{"query":"test"}');

  // 4-3. OpenAI Chat chunk parsing
  const openAIChatChunk = JSON.stringify({
    choices: [
      {
        delta: {
          content: "Hello from DeepSeek!",
          reasoning_content: "DeepSeek reasoning...",
        },
      },
    ],
  });
  const parsedOpenAIChat = parseStreamData("openai-chat", openAIChatChunk);
  check("openai chat content parsed", parsedOpenAIChat?.content === "Hello from DeepSeek!");
  check("openai chat reasoning parsed", parsedOpenAIChat?.thought === "DeepSeek reasoning...");

  console.log("\n>>> ALL MULTI-PROTOCOL TESTS PASSED SUCCESSFULLY! <<<\n");
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
