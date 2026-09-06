<div align="center">

# 🚀 OpenChat

**The Self-Hosted, Open-Source Alternative to ChatGPT & Claude**

*Real-time AI assistant with SSE streaming, Live Artifacts, Code Interpreter, and multi-provider LLM gateway.*

</div>

---

## ⚡ Quick Start

Install and start OpenChat with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/smturtle2/open-chat/main/install.sh | bash
```

### 🚀 Running OpenChat

```bash
# Foreground execution
openchat

# Run as background systemd service
openchat service install   # Register and start service
openchat service status    # Check status
openchat service logs      # Follow real-time logs
openchat service restart   # Restart service
```

Then open **`http://localhost:3000`** to start chatting. No application login is required. Provider API keys remain on the server.

> **Directory Layout**: Application files live in `~/.openchat/app`. Databases and workspaces live safely in `~/.openchat/` and are preserved across updates.

---

## ✨ Features

- **⚡ Push Streaming**: Live `<think>` reasoning and token generation without polling delays.
- **🎨 Live Artifacts**: Interactive canvas for HTML/JS apps, React components, and SVG/Mermaid diagrams.
- **📊 Code Interpreter**: Built-in Python environment for computational processing and data visualization.
- **🔍 File Search**: Keyword and regex pattern search across workspace files (`search_files`, `list_files`).
- **🌐 Web Search & Fetch**: Live internet search engine and precision web scrapers.
- **🔒 Dual-Mode Sandbox**: Docker runs Chat commands and web tools; these tools return an error if Docker is unavailable. Agent mode executes commands directly in the selected host workspace.
- **↩️ Recoverable Workspaces**: Running sessions are excluded from automatic cleanup. Inactive workspaces beyond the retention count move to a seven-day archive and restore on access. Conversation records remain in the database. Explicit session deletion removes its workspace immediately.
- **🧩 Multi-Provider Gateway**: OpenAI, OpenRouter, OpenCode, Ollama, vLLM, or any custom API endpoint.
- **💾 Markdown Export**: One-click conversation export and search across session history.
- **💬 Conversation Workspace**: Drafts and attachments stay with their conversation; failed sends preserve your input, and failed edits restore the previous answer. Responsive previews, searchable model selection and keyboard-accessible dialogs work across screen sizes.

---

## 🛠 Included Autonomous Tools

| Tool | Purpose |
| :--- | :--- |
| `search_files` / `list_files` | Search and explore workspace files |
| `python` | Python computational runtime and chart generation |
| `web_search` / `web_fetch` | DuckDuckGo search and Scrapling web extraction |
| `read_file` / `write_file` / `patch_file` | Surgical file reading and editing |
| `view_image` | Image and diagram inspection |
| `load_skill` | On-demand modular workflow loader ([agentskills.io](https://agentskills.io)) |

---

## ⚙️ Configuration (`.env`)

```ini
PORT=3000
LLM_BASE_URL=https://opencode.ai/zen/go/v1
LLM_MODEL=muse-spark-1.2-contributor
LLM_API_KEY=your_api_key_here
OPENCHAT_THOUGHT_RETENTION=task
# Optional bind address; the default is the Node server default:
# OPENCHAT_HOST=
# Additional browser origins, comma-separated; no wildcard:
# OPENCHAT_ALLOWED_ORIGINS=https://chat.example.com
OPENCHAT_CONTEXT_WINDOW_TOKENS=128000
OPENCHAT_MAX_OUTPUT_TOKENS=8192
OPENCHAT_MAX_WORKSPACES=30
OPENCHAT_WORKSPACE_TRASH_DAYS=7
```

---

React previews compile TSX/JSX and support `react`, `react-dom/client`, a default exported component or `App`. They run in a sandbox with network access disabled. Other imports display an error. Mermaid diagrams render on demand; diagram code remains available in the code tab. Heavy renderers load only when used. Compilation uses [Sucrase](https://github.com/alangpierce/sucrase); diagrams use [Mermaid's strict renderer](https://mermaid.js.org/config/usage).

The context limit comes from model catalog metadata when available, with `OPENCHAT_CONTEXT_WINDOW_TOKENS` as fallback. Input reserves room for system instructions, tool schemas and output. History uses a conservative token estimate, preserves the latest request and complete tool/result pairs, and summarizes older steps when needed. It is not an exact model tokenizer.

OpenCode requests include `User-Agent: OpenChat/<version>` and `x-opencode-session`, as required by [OpenCode Go](https://dev.opencode.ai/docs/go/#where-can-i-use-it). Inference reuses the saved conversation ID across tool calls, retries, regeneration and server restarts. Model catalog requests use a separate stable catalog ID. Other providers do not receive the OpenCode session header.

## 🧪 Testing

```bash
npm ci
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

---

Tests use temporary databases and workspaces. Browser tests use a deterministic local model fixture and require no provider key. CI runs the same checks.

## 📄 License

MIT
