import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// 1. Setup isolated test environment
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-test-"));
process.env.OPENCHAT_WORKSPACE_ROOT = path.join(tmp, "workspace");
fs.mkdirSync(process.env.OPENCHAT_WORKSPACE_ROOT, { recursive: true });

const { pruneWorkspaces, chatWorkspaceDir, deleteChatWorkspace } = await import("../src/agent/sessionPaths.js");

// 2. Test initial empty prune
const removed0 = pruneWorkspaces(30);
check("empty root prune returns 0", removed0 === 0);

// 3. Create 35 simulated workspace directories with staggered mtime
const wsRoot = process.env.OPENCHAT_WORKSPACE_ROOT;
const now = Date.now();
for (let i = 1; i <= 35; i++) {
  const dir = path.join(wsRoot, `session-${i.toString().padStart(2, "0")}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test.txt"), `data for session ${i}`);
  // Set explicit mtime (session-35 is newest, session-01 is oldest)
  const time = (now - (35 - i) * 1000) / 1000;
  fs.utimesSync(dir, time, time);
}

const beforeEntries = fs.readdirSync(wsRoot);
check("35 directories created", beforeEntries.length === 35);

// 4. Run prune keeping 30
const removedCount = pruneWorkspaces(30);
check("pruneWorkspaces removed 5 oldest", removedCount === 5, `removed: ${removedCount}`);

const afterEntries = fs.readdirSync(wsRoot);
check("exactly 30 directories remain", afterEntries.length === 30, `remains: ${afterEntries.length}`);

// 5. Verify the 5 oldest (session-01 ~ session-05) were deleted
const oldestDeleted = !fs.existsSync(path.join(wsRoot, "session-01")) &&
                      !fs.existsSync(path.join(wsRoot, "session-05"));
check("oldest sessions (01-05) deleted", oldestDeleted);

// 6. Verify newest (session-06 ~ session-35) survived
const newestKept = fs.existsSync(path.join(wsRoot, "session-06")) &&
                   fs.existsSync(path.join(wsRoot, "session-35"));
check("newest sessions (06-35) kept", newestKept);

// 7. Test deleteChatWorkspace
deleteChatWorkspace("session-35");
check("deleteChatWorkspace deletes target directory", !fs.existsSync(path.join(wsRoot, "session-35")));

// Cleanup tmp
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}

console.log(`\nWorkspace retention tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
