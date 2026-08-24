import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";

// Process execution primitives shared by every tool backend.
//
// Two execution targets exist:
//   · container — `docker exec` into a session sandbox (chat mode; also the
//     scraping backend for web tools in agent mode)
//   · host      — direct child processes on the server (agent mode bash/python)
//
// Both return the same ExecResult shape and share output capping, timeout,
// abort, and partial-output-on-kill semantics so the tool layer stays
// backend-agnostic.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

export interface ExecResult {
  out: string;
  err: string;
  code: number | null;
  truncated: boolean;
  timedOut?: boolean;
  interrupted?: boolean;
  elapsedMs?: number;
}

export interface RunOptions {
  timeoutMs: number;
  label: string;
  stdinData?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- containers

export function containerName(sessionId: string): string {
  return "oc_sb_" + sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Helper scripts (web_search.py, scrapling_*.py) mounted read-only at /opt/agent. */
export const AGENT_SCRIPTS_DIR = __dirname;

let dockerReady: boolean | null = null;
let imageReady = false;

async function dockerRun(args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout };
  } catch (err: any) {
    return { ok: false, out: String(err?.stdout ?? "") };
  }
}

export async function dockerAvailable(): Promise<boolean> {
  if (dockerReady === null) {
    const r = await dockerRun(["info", "--format", "{{.ServerVersion}}"], 15000);
    dockerReady = r.ok;
    if (!r.ok) console.warn("[sandbox] Docker unavailable; containerized tools disabled");
  }
  return dockerReady;
}

async function ensureImage(): Promise<boolean> {
  if (imageReady) return true;
  const inspect = await dockerRun(["image", "inspect", CONFIG.SANDBOX_IMAGE], 30000);
  if (inspect.ok) {
    imageReady = true;
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
  imageReady = ok;
  return ok;
}

// Timeout/abort kills a command by restarting the container. Those restarts
// happen in the background; ensureContainer awaits any pending one for the
// container before inspecting, so calls never race a mid-restart state.
const pendingRestarts = new Map<string, Promise<void>>();

function restartContainer(container: string): Promise<void> {
  const prev = pendingRestarts.get(container);
  if (prev) return prev;
  const p = execFileAsync("docker", ["restart", container], { timeout: 60000 })
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (pendingRestarts.get(container) === p) pendingRestarts.delete(container);
    });
  pendingRestarts.set(container, p);
  return p;
}

/**
 * Ensure a long-lived sandbox container for the session with `rootDir`
 * bind-mounted at /workspace (plus the shared writable skills root and the
 * read-only helper scripts). Used for chat-mode tools and, in agent mode,
 * only as the scraping backend for web_* tools.
 */
export async function ensureSessionContainer(sessionId: string, rootDir: string): Promise<string | null> {
  if (!(await dockerAvailable())) return null;
  if (!(await ensureImage())) return null;

  const name = containerName(sessionId);
  await pendingRestarts.get(name);

  const inspect = await dockerRun(["container", "inspect", "--format", "{{.State.Running}}", name], 15000);
  if (inspect.ok) {
    if (inspect.out.trim() !== "true") {
      await dockerRun(["start", name], 60000);
    }
    return name;
  }

  const runArgs = [
    "run", "-d", "--name", name,
    "-v", `${rootDir}:/workspace`,
    // Skills root shared across sessions, writable: the agent can install
    // new skills (git clone / curl) and they become live on next turn.
    "-v", `${CONFIG.SKILLS_DIR}:/opt/skills`,
    "-v", `${AGENT_SCRIPTS_DIR}:/opt/agent:ro`,
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

  const check = await dockerRun(["container", "inspect", "--format", "{{.State.Running}}", name], 15000);
  if (check.ok && check.out.trim() === "true") return name;

  // possible race with a parallel call — try starting whatever exists
  await dockerRun(["start", name], 60000);
  const check2 = await dockerRun(["container", "inspect", "--format", "{{.State.Running}}", name], 15000);
  if (check2.ok && check2.out.trim() === "true") return name;
  return null;
}

export async function cleanupContainer(sessionId: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", containerName(sessionId)], { timeout: 30000 }).catch(() => undefined);
}

export async function cleanupAllContainers(): Promise<void> {
  const ps = await dockerRun(["ps", "-aq", "--filter", "name=oc_sb_"], 20000);
  if (!ps.ok || !ps.out.trim()) return;
  const ids = ps.out.trim().split("\n");
  await execFileAsync("docker", ["rm", "-f", ...ids], { timeout: 60000 }).catch(() => undefined);
  console.log(`[sandbox] Removed ${ids.length} stale sandbox container(s)`);
}

// -------------------------------------------------------------- run plumbing

function capAndCollect(cap: number) {
  let out = "";
  let err = "";
  let truncated = false;
  const append = (dst: "out" | "err", d: Buffer) => {
    const cur = dst === "out" ? out : err;
    if (cur.length >= cap) {
      truncated = true;
      return;
    }
    const next = cur + d.toString();
    truncated = truncated || next.length > cap;
    if (dst === "out") out = next.slice(0, cap);
    else err = next.slice(0, cap);
  };
  return { append, result: () => ({ out, err, truncated }) as Pick<ExecResult, "out" | "err" | "truncated"> };
}

/**
 * Run `docker exec` inside a container. Output is capped; timeout/abort kills
 * the command via container restart (the workspace volume survives; only the
 * sleep-infinity entrypoint re-runs). The kill is issued asynchronously — the
 * partial result resolves immediately instead of blocking on `docker restart`.
 */
export async function runDockerExec(container: string, argv: string[], opts: RunOptions): Promise<ExecResult> {
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
  return runChild(child, opts, () => void restartContainer(container), startedAt);
}

/**
 * Run a process directly on the host (agent mode). The command runs detached
 * in its own process group so timeout/abort can kill the whole tree without
 * touching the server process; the partial result settles immediately.
 */
export async function runHostProc(argv: string[], cwd: string, opts: RunOptions): Promise<ExecResult> {
  const startedAt = Date.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    detached: true,
    env: { ...process.env, TERM: "xterm-256color", PAGER: "cat", PYTHONUNBUFFERED: "1" },
  });
  return runChild(child, opts, () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, startedAt);
}

function runChild(
  child: ReturnType<typeof spawn>,
  opts: RunOptions,
  kill: () => void,
  startedAt: number
): Promise<ExecResult> {
  const { timeoutMs, label, stdinData, signal } = opts;
  const collect = capAndCollect(CONFIG.SANDBOX_OUTPUT_CAP);

  let settled = false;
  let release!: (r: ExecResult) => void;
  const done = new Promise<ExecResult>((res) => (release = res));
  const settle = (r: ExecResult) => {
    if (!settled) {
      settled = true;
      release(r);
    }
  };
  const killAndSettle = (partial: ExecResult) => {
    settle({ ...partial, elapsedMs: Date.now() - startedAt });
    kill();
  };

  const timer = setTimeout(() => {
    killAndSettle({
      ...collect.result(),
      code: null,
      err: `${label} timed out (${Math.round(timeoutMs / 1000)}s limit)\n${collect.result().err}`,
      timedOut: true,
    });
  }, timeoutMs);

  const abortHandler = () => {
    clearTimeout(timer);
    killAndSettle({
      ...collect.result(),
      code: -1,
      err: `${label} aborted by user.`,
      interrupted: true,
    });
  };

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  child.stdout?.on("data", (d) => collect.append("out", d));
  child.stderr?.on("data", (d) => collect.append("err", d));
  if (stdinData !== undefined) child.stdin?.end(stdinData);

  child.on("close", (code) => {
    clearTimeout(timer);
    settle({ ...collect.result(), code });
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    settle({ out: "", err: err.message, code: -1, truncated: false });
  });

  return done;
}

/** Human-facing rendering of an ExecResult for model observations. */
export function formatExec(r: ExecResult): string {
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
