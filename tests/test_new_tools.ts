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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-new-tools-"));
fs.writeFileSync(path.join(tmp, "app.py"), "import os\nprint('hello from python')\n# calculate total revenue");
fs.writeFileSync(path.join(tmp, "data.csv"), "month,revenue\njan,100\nfeb,200\nmar,300");
fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
fs.writeFileSync(path.join(tmp, "docs", "guide.md"), "# System Guide\nThis is OpenChat documentation.");

const { searchFilesOp, listFilesOp } = await import("../src/agent/filesys.js");
const { eventBus } = await import("../src/agent/eventBus.js");
const { tools } = await import("../src/agent/tools.js");

async function main() {
  // 1. searchFilesOp
  const res1 = await searchFilesOp(tmp, { query: "revenue" });
  check("search_files keyword match", res1.includes("app.py") && res1.includes("data.csv"));

  const res2 = await searchFilesOp(tmp, { query: "print\\([a-z' ]+\\)", isRegex: true });
  check("search_files regex match", res2.includes("app.py:2:"));

  const res3 = await searchFilesOp(tmp, { query: "nonexistent_query_xyz" });
  check("search_files not found", res3.includes("No matches found"));

  // 2. listFilesOp
  const listRes = await listFilesOp(tmp, { depth: 2 });
  check("list_files directory listing", listRes.includes("app.py") && listRes.includes("docs/") && listRes.includes("guide.md"));

  // 3. Tool registry schemas
  const schemas = tools.getSchemas("chat");
  const toolNames = schemas.map((s) => s.function.name);
  check("search_files in schemas", toolNames.includes("search_files"));
  check("list_files in schemas", toolNames.includes("list_files"));

  // 4. EventBus pub/sub
  let received = false;
  const unsub = eventBus.subscribe("test-session-123", (ev) => {
    if (ev.type === "test_event" && ev.payload === "hello") {
      received = true;
    }
  });

  eventBus.publish("test-session-123", {
    id: 1,
    session_id: "test-session-123",
    type: "test_event",
    payload: "hello",
    created_at: new Date().toISOString(),
  });

  check("eventBus push delivered", received === true);
  unsub();

  console.log(`\nNew tools test: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();

