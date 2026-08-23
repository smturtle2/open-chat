import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../config.js";
import { db } from "../db/database.js";
import { compactor, truncateDirectional, pageLines, type TruncateBias } from "./compactor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export class ToolRegistry {
  private dockerReady: boolean | null = null;
  private imageReady = false;

  private getWorkspaceDir(sessionId: string): string {
    const dir = path.join(CONFIG.WORKSPACES_ROOT, sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // ---- Docker sandbox (filesystem confined to the workspace mount) ----

  private containerName(sessionId: string): string {
    return "oc_sb_" + sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  }

  private dockerAvailable(): boolean {
    if (this.dockerReady === null) {
      try {
        const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15000 });
        this.dockerReady = r.status === 0;
      } catch {
        this.dockerReady = false;
      }
      if (!this.dockerReady) console.warn("[sandbox] Docker unavailable; bash tool disabled");
    }
    return this.dockerReady;
  }

  private async ensureImage(): Promise<boolean> {
    if (this.imageReady) return true;
    const inspect = spawnSync("docker", ["image", "inspect", CONFIG.SANDBOX_IMAGE], { timeout: 30000 });
    if (inspect.status === 0) {
      this.imageReady = true;
      return true;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sandbox-build-"));
    const dfPath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dfPath,
      [
        "FROM python:3.12-slim",
        "RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates build-essential procps ripgrep jq unzip && rm -rf /var/lib/apt/lists/*",
        "RUN pip install --no-cache-dir requests beautifulsoup4 lxml markdownify httpie",
        "RUN pip install --no-cache-dir playwright && python -m playwright install-deps chromium && python -m playwright install chromium",
        "RUN pip install --no-cache-dir \"scrapling[all]\" && scrapling install",
        "WORKDIR /workspace",
        'CMD ["sleep", "infinity"]',
        "",
      ].join("\n")
    );
    console.log("[sandbox] Building sandbox image (first run only)...");
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("docker", ["build", "-f", dfPath, "-t", CONFIG.SANDBOX_IMAGE, tmpDir]);
      child.stderr?.on("data", () => {});
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
    this.imageReady = ok;
    if (!ok) console.error("[sandbox] Sandbox image build failed");
    return ok;
  }

  private async ensureContainer(sessionId: string, workspaceDir: string): Promise<string | null> {
    if (!this.dockerAvailable()) return null;
    const imageOk = await this.ensureImage();
    if (!imageOk) return null;

    const name = this.containerName(sessionId);
    const inspect = spawnSync("docker", ["container", "inspect", "--format", "{{.State.Running}}", name], { timeout: 15000 });
    if (inspect.status === 0) {
      if (inspect.stdout.toString().trim() !== "true") {
        spawnSync("docker", ["start", name], { timeout: 60000 });
      }
      return name;
    }

    const runArgs = [
      "run", "-d", "--name", name,
      "-v", `${workspaceDir}:/workspace`,
      "-v", `${__dirname}:/opt/agent:ro`,
      "-w", "/workspace",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", CONFIG.SANDBOX_MEM_LIMIT,
      "--cpus", CONFIG.SANDBOX_CPUS,
      "--pids-limit", String(CONFIG.SANDBOX_PIDS_LIMIT),
      CONFIG.SANDBOX_IMAGE,
      "bash", "-c", "sleep infinity",
    ];
    spawnSync("docker", runArgs, { timeout: 120000 });

    const check = spawnSync("docker", ["container", "inspect", "--format", "{{.State.Running}}", name], { timeout: 15000 });
    if (check.status === 0 && check.stdout.toString().trim() === "true") return name;

    // possible race with a parallel call — try starting whatever exists
    spawnSync("docker", ["start", name], { timeout: 60000 });
    const check2 = spawnSync("docker", ["container", "inspect", "--format", "{{.State.Running}}", name], { timeout: 15000 });
    if (check2.status === 0 && check2.stdout.toString().trim() === "true") return name;
    return null;
  }

  cleanupContainer(sessionId: string): void {
    try {
      spawnSync("docker", ["rm", "-f", this.containerName(sessionId)], { timeout: 30000 });
    } catch {}
  }

  cleanupAllContainers(): void {
    try {
      const ps = spawnSync("docker", ["ps", "-aq", "--filter", "name=oc_sb_"], { timeout: 20000 });
      if (ps.status !== 0) return;
      const ids = ps.stdout.toString().trim();
      if (!ids) return;
      spawnSync("docker", ["rm", "-f", ...ids.split("\n")], { timeout: 60000 });
      console.log(`[sandbox] Removed ${ids.split("\n").length} stale sandbox container(s)`);
    } catch {}
  }

  // Resolves relPath under workspaceDir or returns null when the path escapes
  // the workspace (traversal, sibling-prefix tricks, or symlinks pointing out).
  getSchemas(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "bash",
          description: "Execute bash shell commands inside an isolated Docker container. Only the session workspace directory is available (mounted at /workspace); the rest of the host filesystem is inaccessible. Network access is allowed. Use for installing packages (pip), running scripts, compiling code, or testing. Output over ~60KB is tail-truncated (the end, where errors appear, is kept); the full output is archived and referenced as output #N — page through it with read_output.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "The bash command line string to execute.",
              },
            },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web in real-time using DuckDuckGo to obtain up-to-date documentation, API references, library versions, and solutions.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query string.",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web_fetch",
          description: "Fetch and scrape web pages with Scrapling. Bypasses anti-bot systems in stealth mode, executes JavaScript in dynamic mode, and extracts structured content with CSS/XPath/Text/Regex selectors in clean markdown, text, HTML, links, or JSON.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "The URL of the web page to fetch." },
              engine: { type: "string", enum: ["http", "stealthy", "dynamic"], description: "Fetching engine: http (fast), stealthy (anti-bot bypass), dynamic (JavaScript rendering)." },
              selector_type: { type: "string", enum: ["css", "xpath", "text", "regex"], description: "Type of selector to use for extraction." },
              selector: { type: "string", description: "Selector expression to extract a specific element instead of the whole page." },
              extract_format: { type: "string", enum: ["markdown", "text", "html", "links", "json"], description: "Output format of the extracted content." },
              wait_for: { type: "string", description: "CSS selector or state to wait for before extraction (dynamic engine)." },
              screenshot: { type: "boolean", description: "Take a screenshot of the page." },
              adaptive: { type: "boolean", description: "Use adaptive auto-healing selectors." },
            },
            required: ["url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web_crawl",
          description: "Crawl multiple web pages starting from given URLs with Scrapling. Follows links matching an optional pattern and saves structured results to a JSON file in the workspace.",
          parameters: {
            type: "object",
            properties: {
              start_urls: { type: "array", items: { type: "string" }, description: "List of URLs to start crawling from." },
              crawl_type: { type: "string", enum: ["follow_links", "single_page"], description: "Crawling strategy." },
              link_pattern: { type: "string", description: "Regex pattern; only links matching it are followed." },
              css_selector: { type: "string", description: "CSS selector to extract specific content from each page." },
              max_pages: { type: "number", description: "Maximum number of pages to crawl (default 10)." },
              concurrency: { type: "number", description: "Number of parallel requests (default 4)." },
              output_file: { type: "string", description: "Output JSON filename in the workspace (default crawl_results.json)." },
            },
            required: ["start_urls"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read the contents of a file in the session workspace. Files up to ~60KB are returned in full; use offset/limit to page through larger files line by line. Very large reads are head-truncated with the full copy archived as output #N (retrieve via read_output).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the workspace root." },
              offset: { type: "number", description: "Optional 1-based line number to start reading from (for paging through large files)." },
              limit: { type: "number", description: "Optional maximum number of lines to read." },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or overwrite a file in the session workspace with the given content.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the workspace root." },
              content: { type: "string", description: "Full content to write to the file." },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "patch_file",
          description: "Apply an exact-string replacement inside an existing workspace file. The target string must match exactly once.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the workspace root." },
              target: { type: "string", description: "The exact existing string/block of code to replace." },
              replacement: { type: "string", description: "The new replacement string/block of code." },
            },
            required: ["path", "target", "replacement"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "python",
          description: "Execute Python 3 code in the workspace sandbox and capture stdout/stderr return values.",
          parameters: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The Python 3 code snippet to run.",
              },
            },
            required: ["code"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_output",
          description: "Read an archived tool output. When bash/python/read_file results are truncated you receive a notice like \"Full copy archived as output #N\" — pass that id here to read the complete text, optionally with line paging.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "number", description: "The archived output number from the truncation notice (e.g. 14)." },
              offset: { type: "number", description: "Optional 1-based line number to start reading from." },
              limit: { type: "number", description: "Optional maximum number of lines to read." },
            },
            required: ["id"],
          },
        },
      },
    ];
  }

  async execute(name: string, args: Record<string, any>, sessionId: string = "default", signal?: AbortSignal): Promise<string> {
    const workspaceDir = this.getWorkspaceDir(sessionId);

    try {
      let rawResult = "";
      switch (name) {
        case "web_fetch":
        case "scrape_webpage":
        case "fetch_webpage":
        case "scrape":
          rawResult = await this.scrapeWebpage(args, sessionId, workspaceDir, signal);
          break;

        case "web_crawl":
        case "crawl":
        case "spider":
          rawResult = await this.crawlWebsites(args, sessionId, workspaceDir, signal);
          break;

        case "bash":
        case "execute_bash":
        case "terminal":
        case "shell":
          rawResult = await this.executeBash(args.command || args.cmd || "", sessionId, workspaceDir, signal);
          break;

        // Pure outbound HTTP from the server: no agent-controlled code and no
        // local filesystem/process access, so containerization does not apply.
        case "web_search":
        case "search":
          rawResult = await this.webSearch(args.query || args.q || "", sessionId, workspaceDir, signal);
          break;

        case "read_file":
        case "readFile":
          rawResult = await this.fsOp(sessionId, workspaceDir, { op: "read", path: args.path || args.file_path || "", offset: args.offset, limit: args.limit }, signal);
          break;

        case "write_file":
        case "writeFile":
          rawResult = await this.fsOp(sessionId, workspaceDir, { op: "write", path: args.path || args.file_path || "", content: args.content ?? "" }, signal);
          break;

        case "patch_file":
        case "edit_file":
        case "patchFile":
          rawResult = await this.fsOp(sessionId, workspaceDir, { op: "patch", path: args.path || args.file_path || "", target: args.target ?? "", replacement: args.replacement ?? "" }, signal);
          break;

        case "python":
        case "run_python":
        case "python3":
          rawResult = await this.runPython(args.code || "", sessionId, workspaceDir, signal);
          break;

        case "read_output":
        case "tool_output":
          rawResult = this.readArchivedOutput(sessionId, args);
          break;

        default:
          return `Error: Unknown tool "${name}"`;
      }
      return compactor.compact(rawResult);
    } catch (err: any) {
      return `Error executing tool "${name}": ${err.message || String(err)}`;
    }
  }


  private async scrapeWebpage(args: Record<string, any>, sessionId: string, workspaceDir: string, signal?: AbortSignal): Promise<string> {
    const jsonArgs = JSON.stringify({
      url: args.url || "",
      engine: args.engine || args.mode || "http",
      selector_type: args.selector_type || "css",
      selector: args.selector || args.css_selector,
      extract_format: args.extract_format || "markdown",
      wait_for: args.wait_for,
      screenshot: Boolean(args.screenshot),
      adaptive: Boolean(args.adaptive),
    });
    const container = await this.getContainer(sessionId, workspaceDir);
    const r = await this.runDockerExec(container, ["python3", "/opt/agent/scrapling_fetch.py", jsonArgs, "/workspace"], 45000, "Scrapling fetch", undefined, signal);
    return this.settle("web_fetch", sessionId, r.out.trim() || r.err.trim() || "[Scrapling fetch finished with no output]");
  }


  private async crawlWebsites(args: Record<string, any>, sessionId: string, workspaceDir: string, signal?: AbortSignal): Promise<string> {
    const jsonArgs = JSON.stringify({
      start_urls: args.start_urls || (args.url ? [args.url] : []),
      crawl_type: args.crawl_type || "follow_links",
      link_pattern: args.link_pattern || "",
      css_selector: args.css_selector || "",
      max_pages: args.max_pages || 10,
      concurrency: args.concurrency || 4,
      output_file: args.output_file || "crawl_results.json",
    });
    const container = await this.getContainer(sessionId, workspaceDir);
    const r = await this.runDockerExec(container, ["python3", "/opt/agent/scrapling_crawl.py", jsonArgs, "/workspace"], 60000, "Scrapling crawl", undefined, signal);
    return this.settle("web_crawl", sessionId, r.out.trim() || r.err.trim() || `[Scrapling crawl finished with code ${r.code}]`);
  }


  private async getContainer(sessionId: string, workspaceDir: string): Promise<string> {
    const container = await this.ensureContainer(sessionId, workspaceDir);
    if (!container) {
      throw new Error("Sandbox backend unavailable (Docker is required for this tool)");
    }
    return container;
  }

  // Runs `docker exec` inside the session container. Output is capped,
  // timeout/abort kills the command via container restart (the workspace
  // volume survives; only the sleep-infinity entrypoint re-runs).
  private runDockerExec(
    container: string,
    argv: string[],
    timeoutMs: number,
    label: string,
    stdinData?: string,
    signal?: AbortSignal
  ): Promise<{ out: string; err: string; code: number | null; truncated: boolean; timedOut?: boolean; interrupted?: boolean; elapsedMs?: number }> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn("docker", [
        "exec", "-i",
        "-w", "/workspace",
        "-e", "TERM=xterm-256color",
        "-e", "PAGER=cat",
        "-e", "PIP_DISABLE_PIP_VERSION_CHECK=1",
        "-e", "PYTHONUNBUFFERED=1",
        container,
        ...argv,
      ]);

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let finished = false;
      const cap = CONFIG.SANDBOX_OUTPUT_CAP;
      const append = (dst: "out" | "err", d: Buffer) => {
        const cur = dst === "out" ? stdout : stderr;
        if (cur.length >= cap) { truncated = true; return; }
        const next = cur + d.toString();
        if (next.length > cap) {
          truncated = true;
          if (dst === "out") stdout = next.slice(0, cap);
          else stderr = next.slice(0, cap);
        } else {
          if (dst === "out") stdout = next;
          else stderr = next;
        }
      };

      let killedByUs = false;
      const killRunning = () => {
        killedByUs = true;
        try { spawnSync("docker", ["restart", container], { timeout: 60000 }); } catch {}
      };

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          const elapsedMs = Date.now() - startedAt;
          killRunning();
          resolve({ out: stdout, err: `${label} timed out (${Math.round(timeoutMs / 1000)}s limit)\n${stderr}`, code: null, truncated, timedOut: true, elapsedMs });
        }
      }, timeoutMs);

      const abortHandler = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          const elapsedMs = Date.now() - startedAt;
          killRunning();
          resolve({ out: stdout, err: `${label} aborted by user.`, code: -1, truncated, interrupted: true, elapsedMs });
        }
      };

      if (signal) {
        if (signal.aborted) { abortHandler(); return; }
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      child.stdout?.on("data", (d) => append("out", d));
      child.stderr?.on("data", (d) => append("err", d));
      if (stdinData !== undefined) child.stdin?.end(stdinData);
      child.on("close", (code) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          if (killedByUs) {
            // Our watchdog or the user's abort triggered the restart-kill;
            // classify so formatExec can mark the output as partial.
            const userAborted = signal?.aborted === true;
            resolve({ out: stdout, err: stderr, code, truncated, timedOut: !userAborted, interrupted: userAborted, elapsedMs: Date.now() - startedAt });
          } else {
            resolve({ out: stdout, err: stderr, code, truncated });
          }
        }
      });
      child.on("error", (err) => {
        if (!finished) { finished = true; clearTimeout(timer); resolve({ out: "", err: err.message, code: -1, truncated }); }
      });
    });
  }

  private formatExec(r: { out: string; err: string; code: number | null; truncated: boolean; timedOut?: boolean; interrupted?: boolean; elapsedMs?: number }): string {
    const secs = r.elapsedMs !== undefined ? Math.round(r.elapsedMs / 1000) : 0;
    const lifeNote = r.timedOut
      ? `\n[timed out after ${secs}s — killed; output above is partial]`
      : r.interrupted
        ? `\n[interrupted after ${secs}s by user — output above is partial]`
        : "";
    const truncNote = r.truncated ? "\n[output truncated at size limit]" : "";
    const combined = [
      r.out.trim(),
      r.err.trim() ? `[stderr]\n${r.err.trim()}` : "",
      r.code !== null && r.code !== 0 ? `\n[Process exited with status code ${r.code}]` : "",
      truncNote,
      lifeNote,
    ]
      .filter(Boolean)
      .join("\n");
    return combined || "[Command completed successfully with no output]";
  }

  private async executeBash(command: string, sessionId: string, workspaceDir: string, signal?: AbortSignal): Promise<string> {
    if (!command.trim()) return "Error: No command provided.";
    const container = await this.getContainer(sessionId, workspaceDir);
    const r = await this.runDockerExec(container, ["bash", "-c", command], 45000, "Execution", undefined, signal);
    return this.settle("bash", sessionId, this.formatExec(r));
  }


  private async webSearch(query: string, sessionId: string, workspaceDir: string, signal?: AbortSignal): Promise<string> {
    if (!query || !query.trim()) return "Error: Query is required";
    const cleanQuery = query.trim();

    const container = await this.getContainer(sessionId, workspaceDir);
    if (!container) return "Error: Sandbox backend unavailable (Docker is required for this tool)";

    const r = await this.runDockerExec(container, ["python3", "/opt/agent/web_search.py", cleanQuery, "10"], 60000, "Web search", undefined, signal);

    let items: Array<{ title?: string; url?: string; snippet?: string }> = [];
    try { items = JSON.parse(r.out.trim()); } catch {}

    if (!items.length) {
      const detail = r.err ? `\n${r.err.slice(0, 300)}` : "";
      return `No results found for "${cleanQuery}".${detail}`;
    }

    return this.settle(
      "web_search",
      sessionId,
      items.map((it, idx) => `[Result ${idx + 1}]:\nTitle: ${it.title || "(no title)"}\nURL: ${it.url}\nSnippet: ${it.snippet || ""}`).join("\n\n")
    );
  }

  // File operations execute inside the session container via fs_runner.py.
  // No host-side path validation is needed: the worst case is the agent
  // modifying its own (disposable) container filesystem, never the host.
  private async fsOp(sessionId: string, workspaceDir: string, req: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const container = await this.getContainer(sessionId, workspaceDir);
    const r = await this.runDockerExec(container, ["python3", "/opt/agent/fs_runner.py"], 30000, "File operation", JSON.stringify(req), signal);
    if (!r.out.trim() && r.code !== 0) {
      return `Error: ${r.err.trim() || "file operation failed"}`;
    }
    if (req.op === "read") {
      return this.settle("read_file", sessionId, r.out.trim());
    }
    return r.out.trim();
  }

  private async runPython(code: string, sessionId: string, workspaceDir: string, signal?: AbortSignal): Promise<string> {
    if (!code.trim()) return "Error: No code provided.";
    const container = await this.getContainer(sessionId, workspaceDir);
    const r = await this.runDockerExec(container, ["python3", "-c", code], 30000, "Python execution", undefined, signal);
    return this.settle("python", sessionId, this.formatExec(r));
  }

  // Archives the full output and returns the model-facing surface.
  // Tail bias for bash/python (errors live at the end), head bias elsewhere.
  private static readonly HEAD_BIAS = new Set(["read_file", "web_fetch", "web_crawl", "web_search"]);

  private settle(tool: string, sessionId: string, fullText: string): string {
    const id = db.archiveToolOutput(sessionId, tool, fullText, CONFIG.TOOL_ARCHIVE_MAX_CHARS);
    const bias: TruncateBias = ToolRegistry.HEAD_BIAS.has(tool) ? "head" : "tail";
    const surface = truncateDirectional(fullText, bias, id);
    db.recordToolUsage(sessionId, tool, fullText.length, surface.length);
    return surface;
  }

  private readArchivedOutput(sessionId: string, args: Record<string, any>): string {
    const id = Math.trunc(Number(args.id ?? args.output_id));
    if (!Number.isInteger(id) || id <= 0) return 'Error: a positive integer "id" is required';
    const rec = db.getToolOutput(sessionId, id);
    if (!rec) return `Error: output #${id} not found in this session (it may belong to another session or have been pruned)`;
    const header = `[output #${id} · ${rec.tool} · ${rec.chars} chars archived]`;
    const body = pageLines(rec.content, args.offset, args.limit);
    return `${header}\n${body}`;
  }
}

export const tools = new ToolRegistry();
