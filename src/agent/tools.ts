import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../config.js";
import { db } from "../db/database.js";
import { truncateDirectional, pageLines, type TruncateBias } from "./compactor.js";

import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

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

// Multipart observation (e.g. view_image): text summary plus content parts
// replayed verbatim into the tool message on the wire.
export interface ToolObservation {
  text: string;
  kind?: "image";
  path?: string;
}

// Envelope persisted in the tool record's content column. Image BYTES are not
// stored — only the workspace-relative path; buildHistory re-reads the file at
// prompt-build time and degrades to plain text if it has vanished.
export function serializeObservation(obs: ToolObservation | string): string {
  if (typeof obs === "string") return obs;
  return JSON.stringify({ __obs__: obs.kind ?? "image", text: obs.text, path: obs.path });
}

export function parseObservation(content: string): ToolObservation | null {
  if (!content.startsWith("{")) return null;
  try {
    const o = JSON.parse(content);
    if (o && o.__obs__ === "image" && typeof o.path === "string") {
      return { text: typeof o.text === "string" ? o.text : "", kind: "image", path: o.path };
    }
  } catch {}
  return null;
}

// Content-sniffing beats extensions: uploads are frequently misnamed
// (screenshot saved as .bin, JPEG named .png).
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
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

  // Non-blocking probe wrapper: resolves {ok, stdout} without throwing on
  // non-zero exit codes (execFile rejects on those).
  private async dockerRun(args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
    try {
      const { stdout } = await execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      return { ok: true, out: stdout };
    } catch (err: any) {
      return { ok: false, out: String(err?.stdout ?? "") };
    }
  }

  private async dockerAvailable(): Promise<boolean> {
    if (this.dockerReady === null) {
      const r = await this.dockerRun(["info", "--format", "{{.ServerVersion}}"], 15000);
      this.dockerReady = r.ok;
      if (!r.ok) console.warn("[sandbox] Docker unavailable; bash tool disabled");
    }
    return this.dockerReady;
  }

  private async ensureImage(): Promise<boolean> {
    if (this.imageReady) return true;
    const inspect = await this.dockerRun(["image", "inspect", CONFIG.SANDBOX_IMAGE], 30000);
    if (inspect.ok) {
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
      let errTail = "";
      child.stderr?.on("data", (d: Buffer) => {
        errTail = (errTail + d.toString()).slice(-500);
      });
      child.on("close", (code) => {
        if (code !== 0) console.error(`[sandbox] Image build failed:\n${errTail}`);
        resolve(code === 0);
      });
      child.on("error", () => resolve(false));
    });
    this.imageReady = ok;
    return ok;
  }

  // Timeout/abort kills a command by restarting the container. Those restarts
  // happen in the background; ensureContainer awaits any pending one for the
  // container before inspecting, so calls never race a mid-restart state.
  private pendingRestarts = new Map<string, Promise<void>>();

  private restartContainer(container: string): Promise<void> {
    const prev = this.pendingRestarts.get(container);
    if (prev) return prev;
    const p = execFileAsync("docker", ["restart", container], { timeout: 60000 })
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.pendingRestarts.get(container) === p) this.pendingRestarts.delete(container);
      });
    this.pendingRestarts.set(container, p);
    return p;
  }

  private async ensureContainer(sessionId: string, workspaceDir: string): Promise<string | null> {
    if (!(await this.dockerAvailable())) return null;
    const imageOk = await this.ensureImage();
    if (!imageOk) return null;

    const name = this.containerName(sessionId);
    await this.pendingRestarts.get(name);

    const inspect = await this.dockerRun(["container", "inspect", "--format", "{{.State.Running}}", name], 15000);
    if (inspect.ok) {
      if (inspect.out.trim() !== "true") {
        await this.dockerRun(["start", name], 60000);
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
    await execFileAsync("docker", runArgs, { timeout: 120000 }).catch(() => undefined);

    const check = await this.dockerRun(["container", "inspect", "--format", "{{.State.Running}}", name], 15000);
    if (check.ok && check.out.trim() === "true") return name;

    // possible race with a parallel call — try starting whatever exists
    await this.dockerRun(["start", name], 60000);
    const check2 = await this.dockerRun(["container", "inspect", "--format", "{{.State.Running}}", name], 15000);
    if (check2.ok && check2.out.trim() === "true") return name;
    return null;
  }

  async cleanupContainer(sessionId: string): Promise<void> {
    await execFileAsync("docker", ["rm", "-f", this.containerName(sessionId)], { timeout: 30000 }).catch(() => undefined);
  }

  async cleanupAllContainers(): Promise<void> {
    const ps = await this.dockerRun(["ps", "-aq", "--filter", "name=oc_sb_"], 20000);
    if (!ps.ok || !ps.out.trim()) return;
    const ids = ps.out.trim().split("\n");
    await execFileAsync("docker", ["rm", "-f", ...ids], { timeout: 60000 }).catch(() => undefined);
    console.log(`[sandbox] Removed ${ids.length} stale sandbox container(s)`);
  }

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
          name: "view_image",
          description: "View an image file from the session workspace (user uploads or generated images). Returns the image visually so you can see its pixels. Use when a task involves screenshots, photos, diagrams, or design references. Supported: PNG, JPEG, GIF, WebP up to 5MB.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Image path relative to the workspace root (e.g. uploads/screenshot.png)." },
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

  async execute(name: string, args: Record<string, any>, sessionId: string = "default", signal?: AbortSignal): Promise<string | ToolObservation> {
    const workspaceDir = this.getWorkspaceDir(sessionId);

    try {
      let rawResult: string | ToolObservation = "";
      switch (name) {
        case "web_fetch":
          rawResult = await this.scrapeWebpage(args, sessionId, workspaceDir, signal);
          break;

        case "web_crawl":
          rawResult = await this.crawlWebsites(args, sessionId, workspaceDir, signal);
          break;

        case "bash":
          rawResult = await this.executeBash(args.command || "", sessionId, workspaceDir, signal);
          break;

        // Pure outbound HTTP from the server: no agent-controlled code and no
        // local filesystem/process access, so containerization does not apply.
        case "web_search":
          rawResult = await this.webSearch(args.query || "", sessionId, workspaceDir, signal);
          break;

        case "read_file":
          rawResult = await this.fsOp(sessionId, workspaceDir, { op: "read", path: args.path || "", offset: args.offset, limit: args.limit }, signal);
          break;

        case "view_image":
          rawResult = await this.viewImage(sessionId, workspaceDir, String(args.path || ""));
          break;

        case "write_file":
          rawResult = await this.fsOp(sessionId, workspaceDir, { op: "write", path: args.path || "", content: args.content ?? "" }, signal);
          break;

        case "patch_file":
          rawResult = await this.fsOp(sessionId, workspaceDir, { op: "patch", path: args.path || "", target: args.target ?? "", replacement: args.replacement ?? "" }, signal);
          break;

        case "python":
          rawResult = await this.runPython(args.code || "", sessionId, workspaceDir, signal);
          break;

        case "read_output":
          rawResult = this.readArchivedOutput(sessionId, args);
          break;

        default:
          return `Error: Unknown tool "${name}"`;
      }
      return rawResult;
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
  // volume survives; only the sleep-infinity entrypoint re-runs). The kill is
  // issued asynchronously — the partial result resolves immediately instead of
  // blocking the event loop on `docker restart`.
  private async runDockerExec(
    container: string,
    argv: string[],
    timeoutMs: number,
    label: string,
    stdinData?: string,
    signal?: AbortSignal
  ): Promise<{ out: string; err: string; code: number | null; truncated: boolean; timedOut?: boolean; interrupted?: boolean; elapsedMs?: number }> {
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

    type ExecResult = { out: string; err: string; code: number | null; truncated: boolean; timedOut?: boolean; interrupted?: boolean; elapsedMs?: number };
    let settled = false;
    let release!: (r: ExecResult) => void;
    const done = new Promise<ExecResult>((res) => (release = res));
    const settle = (r: ExecResult) => {
      if (!settled) {
        settled = true;
        release(r);
      }
    };
    const killAndSettle = (partial: { out: string; err: string; code: number | null; truncated: boolean; timedOut?: boolean; interrupted?: boolean }) => {
      const elapsedMs = Date.now() - startedAt;
      settle({ ...partial, elapsedMs });
      void this.restartContainer(container);
    };

    const timer = setTimeout(() => {
      killAndSettle({
        out: stdout,
        err: `${label} timed out (${Math.round(timeoutMs / 1000)}s limit)\n${stderr}`,
        code: null,
        truncated,
        timedOut: true,
      });
    }, timeoutMs);

    const abortHandler = () => {
      clearTimeout(timer);
      killAndSettle({
        out: stdout,
        err: `${label} aborted by user.`,
        code: -1,
        truncated,
        interrupted: true,
      });
    };

    if (signal) {
      if (signal.aborted) { clearTimeout(timer); abortHandler(); }
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout?.on("data", (d) => append("out", d));
    child.stderr?.on("data", (d) => append("err", d));
    if (stdinData !== undefined) child.stdin?.end(stdinData);

    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ out: stdout, err: stderr, code, truncated });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ out: "", err: err.message, code: -1, truncated });
    });

    return done;
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
  private async fsOp(sessionId: string, workspaceDir: string, req: Record<string, any>, signal?: AbortSignal): Promise<string> {    const container = await this.getContainer(sessionId, workspaceDir);
    const r = await this.runDockerExec(container, ["python3", "/opt/agent/fs_runner.py"], 30000, "File operation", JSON.stringify(req), signal);
    if (!r.out.trim() && r.code !== 0) {
      return `Error: ${r.err.trim() || "file operation failed"}`;
    }
    if (req.op === "read") {
      return this.settle("read_file", sessionId, r.out.trim());
    }
    return r.out.trim();
  }

  // Host-side image reader for vision input. The workspace volume is mounted
  // into the sandbox, so uploads written by the server are visible here by
  // the same relative path. Containment is enforced host-side (realpath) and
  // the image type is detected from magic bytes, not the extension.
  private static readonly IMAGE_MAX_BYTES = 5 * 1024 * 1024;

  private async viewImage(sessionId: string, workspaceDir: string, relPath: string): Promise<ToolObservation | string> {
    const clean = relPath.replace(/^\/+/, "");
    if (!clean) return "Error: an image path relative to the workspace root is required";

    let fullReal: string;
    let wsReal: string;
    try {
      fullReal = fs.realpathSync(path.resolve(workspaceDir, clean));
      wsReal = fs.realpathSync(workspaceDir);
    } catch {
      return `Error: image not found at ${clean}`;
    }
    const rel = path.relative(wsReal, fullReal);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return `Error: image path escapes the workspace`;
    if (!fs.existsSync(fullReal) || !fs.statSync(fullReal).isFile()) return `Error: image not found at ${clean}`;

    const size = fs.statSync(fullReal).size;
    if (size > ToolRegistry.IMAGE_MAX_BYTES) {
      return `Error: image too large (${(size / 1024 / 1024).toFixed(1)}MB) — limit is 5MB. Downscale or crop it first.`;
    }

    const buf = fs.readFileSync(fullReal);
    const mime = sniffImageMime(buf);
    if (!mime) return `Error: ${clean} is not a decodable image (PNG/JPEG/GIF/WebP). If it is an image in another format, convert it first.`;

    db.recordToolUsage(sessionId, "view_image", buf.length, buf.length);
    const kb = size >= 1024 ? `${(size / 1024).toFixed(0)}KB` : `${size}B`;
    return { text: `${clean} · ${kb}`, kind: "image", path: clean };
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
