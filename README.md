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

Then open **`http://localhost:3000`** and enter the access key printed by `openchat token` (or `npm run --silent auth:token` from the repository). The key is created once in `~/.openchat/auth-token` with owner-only permissions and survives upgrades. Existing installations also require this key after upgrading.

All API routes require a login cookie or `Authorization: Bearer <access-key>`. Provider API keys remain on the server. Browser sessions last seven days. To replace the access key and invalidate all sessions, stop the server, remove the token file, and restart; then retrieve the new key. If `OPENCHAT_AUTH_TOKEN` is set, replace that value instead.

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
# Optional access key override (at least 16 characters):
# OPENCHAT_AUTH_TOKEN=
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
