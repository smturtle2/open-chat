import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { CONFIG } from "./config.js";
import { db } from "./db/database.js";
import { syncBuiltinSkills } from "./agent/skills.js";
import { seedBootstrapProvider } from "./agent/providers.js";
import { pruneWorkspaces, purgeWorkspaceTrash } from "./agent/sessionPaths.js";
import { cleanupAllContainers } from "./agent/exec.js";

syncBuiltinSkills();
seedBootstrapProvider();
// Stop stale commands owned by this database before releasing run protection.
await cleanupAllContainers(db.listSessions().map(session => session.id));
db.recoverInterruptedRuns();
pruneWorkspaces();
purgeWorkspaceTrash();
setInterval(() => {
  db.pruneToolOutputs();
  pruneWorkspaces();
  purgeWorkspaceTrash();
}, 24 * 3600_000).unref();

serve({ fetch: app.fetch, port: CONFIG.PORT, hostname: CONFIG.HOST }, () => {
  console.log("[OpenChat] Listening on port " + CONFIG.PORT);
});
