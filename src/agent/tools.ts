import { db } from "../db/database.js";
import type { SessionMode } from "../db/database.js";
import { CONFIG } from "../config.js";
import { truncateDirectional, pageLines, type TruncateBias } from "./compactor.js";
import { readSkillBody } from "./skills.js";
import {
  ensureSessionContainer,
  cleanupContainer as cleanupContainerRaw,
  cleanupAllContainers as cleanupAllContainersRaw,
  formatExec,
  runDockerExec,
  runHostProc,
} from "./exec.js";
import { fsOp, viewImage, type FsRequest } from "./filesys.js";
import type { ToolDefinition, ToolObservation } from "./toolTypes.js";

export {
  serializeObservation,
  parseObservation,
  sniffImageMime,
  type ToolDefinition,
  type ToolObservation,
} from "./toolTypes.js";

// Everything a tool needs to know about where/how to act. Built once per
// assistant turn from the session record.
export interface ToolContext {
  sessionId: string;
  mode: SessionMode;
  /** Absolute host path all relative file paths resolve against. */
  cwd: string;
}

const BASH_TIMEOUT_MS = 45000;
const PYTHON_TIMEOUT_MS = 30000;

function bashDescription(mode: SessionMode): string {
  const where =
    mode === "agent"
      ? "directly on the host machine in the working directory. This is a real environment with the host's full filesystem access"
      : "inside an isolated Docker sandbox. Only the session workspace directory persists (mounted at /workspace); the rest of the container filesystem is disposable. Network access is allowed";
  return `Execute bash shell commands ${where}. Use for installing packages (pip), running scripts, compiling code, or testing. Output over ~60KB is tail-truncated (the end, where errors appear, is kept); the full output is archived and referenced as output #N — page through it with read_output.`;
}

function schemasFor(mode: SessionMode): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "bash",
        description: bashDescription(mode),
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
            path: { type: "string", description: "File path — relative to the workspace root (recommended) or absolute under /opt/skills/<skill>/...." },
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
        description: "View an image file from the session workspace (uploads, generated images) or from /opt/skills. Returns the image visually so you can see its pixels. Use when a task involves screenshots, photos, diagrams, or design references. Supported: PNG, JPEG, GIF, WebP up to 5MB.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Image path — relative to the workspace root (e.g. uploads/screenshot.png) or under /opt/skills/... ." },
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
            path: { type: "string", description: "File path — relative to the workspace root (recommended) or absolute under /opt/skills/<skill>/...." },
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
            path: { type: "string", description: "File path — relative to the workspace root (recommended) or absolute under /opt/skills/<skill>/...." },
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
        description: "Execute Python 3 code and capture stdout/stderr return values.",
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
    {
      type: "function",
      function: {
        name: "load_skill",
        description: "Load the full instructions of an installed skill from the available_skills list. Call this when a task matches a skill's description and before following its workflow. Returns the skill body plus its base directory and bundled files.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "The skill name exactly as listed in available_skills (e.g. pdf-processing)." },
          },
          required: ["name"],
        },
      },
    },
  ];
}

export class ToolRegistry {
  // ---- lifecycle passthroughs (used by index.ts boot/delete paths) ----

  async cleanupContainer(sessionId: string): Promise<void> {
    await cleanupContainerRaw(sessionId);
  }

  async cleanupAllContainers(): Promise<void> {
    await cleanupAllContainersRaw();
  }

  getSchemas(mode: SessionMode = "chat"): ToolDefinition[] {
    return schemasFor(mode);
  }

  async execute(name: string, args: Record<string, any>, ctx: ToolContext, signal?: AbortSignal): Promise<string | ToolObservation> {
    try {
      let rawResult: string | ToolObservation = "";
      switch (name) {
        case "bash":
          rawResult = await this.bash(args.command || "", ctx, signal);
          break;

        case "python":
          rawResult = await this.python(args.code || "", ctx, signal);
          break;

        case "web_search":
          rawResult = await this.webSearch(args.query || "", ctx, signal);
          break;

        case "web_fetch":
          rawResult = await this.webFetch(args, ctx, signal);
          break;

        case "web_crawl":
          rawResult = await this.webCrawl(args, ctx, signal);
          break;

        case "read_file":
          rawResult = await files(ctx, { op: "read", path: args.path || "", offset: args.offset, limit: args.limit });
          break;

        case "write_file":
          rawResult = await files(ctx, { op: "write", path: args.path || "", content: args.content ?? "" });
          break;

        case "patch_file":
          rawResult = await files(ctx, { op: "patch", path: args.path || "", target: args.target ?? "", replacement: args.replacement ?? "" });
          break;

        case "view_image": {
          const result = await viewImage(ctx.cwd, String(args.path || ""));
          if (typeof result === "object") {
            db.recordToolUsage(ctx.sessionId, "view_image", result.bytes, result.bytes);
            rawResult = result.obs;
          } else {
            rawResult = result;
          }
          break;
        }

        case "read_output":
          rawResult = this.readArchivedOutput(ctx.sessionId, args);
          break;

        case "load_skill":
          rawResult = await this.loadSkill(String(args.name || "").trim());
          break;

        default:
          return `Error: Unknown tool "${name}"`;
      }
      return rawResult;
    } catch (err: any) {
      return `Error executing tool "${name}": ${err.message || String(err)}`;
    }
  }

  // ------------------------------------------------------------- code execution

  private async bash(command: string, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
    if (!command.trim()) return "Error: No command provided.";
    const result =
      ctx.mode === "agent"
        ? await runHostProc(["bash", "-c", command], ctx.cwd, { timeoutMs: BASH_TIMEOUT_MS, label: "Execution", signal })
        : await runDockerExec(await this.requireContainer(ctx), ["bash", "-c", command], { timeoutMs: BASH_TIMEOUT_MS, label: "Execution", signal });
    return this.settle("bash", ctx.sessionId, formatExec(result));
  }

  private async python(code: string, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
    if (!code.trim()) return "Error: No code provided.";
    const result =
      ctx.mode === "agent"
        ? await runHostProc(["python3", "-c", code], ctx.cwd, { timeoutMs: PYTHON_TIMEOUT_MS, label: "Python execution", signal })
        : await runDockerExec(await this.requireContainer(ctx), ["python3", "-c", code], { timeoutMs: PYTHON_TIMEOUT_MS, label: "Python execution", signal });
    return this.settle("python", ctx.sessionId, formatExec(result));
  }

  // ------------------------------------------------------------------ web tools

  // Web scraping depends on the sandbox image's Python stack (scrapling +
  // playwright), so both modes route these calls through the session's
  // container. In agent mode the container is a lazily created scraping
  // backend with the same working directory mounted — bash/fs stay on the
  // host; only hostile-content processing stays boxed.
  private async webSearch(query: string, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
    if (!query || !query.trim()) return "Error: Query is required";
    const cleanQuery = query.trim();
    const container = await this.requireContainer(ctx);
    const r = await runDockerExec(container, ["python3", "/opt/agent/web_search.py", cleanQuery, "10"], { timeoutMs: 60000, label: "Web search", signal });

    let items: Array<{ title?: string; url?: string; snippet?: string }> = [];
    try { items = JSON.parse(r.out.trim()); } catch {}

    if (!items.length) {
      const detail = r.err ? `\n${r.err.slice(0, 300)}` : "";
      return `No results found for "${cleanQuery}".${detail}`;
    }

    return this.settle(
      "web_search",
      ctx.sessionId,
      items.map((it, idx) => `[Result ${idx + 1}]:\nTitle: ${it.title || "(no title)"}\nURL: ${it.url}\nSnippet: ${it.snippet || ""}`).join("\n\n")
    );
  }

  private async webFetch(args: Record<string, any>, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
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
    const container = await this.requireContainer(ctx);
    const r = await runDockerExec(container, ["python3", "/opt/agent/scrapling_fetch.py", jsonArgs, "/workspace"], { timeoutMs: 45000, label: "Scrapling fetch", signal });
    return this.settle("web_fetch", ctx.sessionId, r.out.trim() || r.err.trim() || "[Scrapling fetch finished with no output]");
  }

  private async webCrawl(args: Record<string, any>, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
    const jsonArgs = JSON.stringify({
      start_urls: args.start_urls || (args.url ? [args.url] : []),
      crawl_type: args.crawl_type || "follow_links",
      link_pattern: args.link_pattern || "",
      css_selector: args.css_selector || "",
      max_pages: args.max_pages || 10,
      concurrency: args.concurrency || 4,
      output_file: args.output_file || "crawl_results.json",
    });
    const container = await this.requireContainer(ctx);
    const r = await runDockerExec(container, ["python3", "/opt/agent/scrapling_crawl.py", jsonArgs, "/workspace"], { timeoutMs: 60000, label: "Scrapling crawl", signal });
    return this.settle("web_crawl", ctx.sessionId, r.out.trim() || r.err.trim() || `[Scrapling crawl finished with code ${r.code}]`);
  }

  private async requireContainer(ctx: ToolContext): Promise<string> {
    const container = await ensureSessionContainer(ctx.sessionId, ctx.cwd);
    if (!container) {
      throw new Error("Sandbox backend unavailable (Docker is required for this tool)");
    }
    return container;
  }

  // ------------------------------------------------------------ skills & archive

  private async loadSkill(skillName: string): Promise<string | ToolObservation> {
    const skill = await readSkillBody(skillName);
    if (!skill) {
      return `Error: skill "${skillName}" not found. Check the exact name in available_skills.`;
    }
    const fileList = skill.files.length
      ? `\n\n<skill_files>\n${skill.files.map((f) => `<file>${skill.dir}/${f}</file>`).join("\n")}\n</skill_files>`
      : "";
    return (
      `<skill_content name="${skillName}">\n\n` +
      `Base directory for this skill: ${skill.dir}\n` +
      `Relative paths in this skill are relative to this base directory.\n\n` +
      `${skill.body}` +
      `${fileList}\n\n</skill_content>`
    );
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

/** File operations run against the context root via the shared filesys layer. */
async function files(ctx: ToolContext, req: FsRequest): Promise<string> {
  return fsOp(ctx.cwd, req);
}

export const tools = new ToolRegistry();
