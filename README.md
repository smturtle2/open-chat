<div align="center">

# 🚀 OpenChat

**The Self-Hosted, Open-Source Alternative to ChatGPT & Claude**

*Real-time AI assistant with 0ms SSE streaming, Live Artifacts, Code Interpreter, and multi-provider LLM gateway.*

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

Then open **`http://localhost:3000`** in your browser.

> **Directory Layout**: Application files live in `~/.openchat/app`. Databases and workspaces live safely in `~/.openchat/` and are preserved across updates.

---

## ✨ Features

- **⚡ 0ms Push Streaming**: Instant `<think>` reasoning and token generation without polling delays.
- **🎨 Live Artifacts**: Interactive canvas for HTML/JS apps, React components, and SVG/Mermaid diagrams.
- **📊 Code Interpreter**: Built-in Python environment for computational processing and data visualization.
- **🔍 File Search**: Keyword and regex pattern search across workspace files (`search_files`, `list_files`).
- **🌐 Web Search & Fetch**: Live internet search engine and precision web scrapers.
- **🔒 Dual-Mode Sandbox**: Isolated Docker containers (**Chat Mode**) and local host workspace (**Agent Mode**).
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
```

---

## 🧪 Testing

```bash
npm run test:unit
npm run typecheck
```

---

## 📄 License

MIT
