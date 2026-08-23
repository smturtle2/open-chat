// Unit tests for the skills module: discovery, frontmatter parsing, confined
// body reads, and prompt build (slash hints pass through verbatim; the model
// loads skills itself via load_skill).
// Run: OPENCHAT_SKILLS_DIR is created fresh in tmp — npx tsx tests/test_skills.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-skills-"));
process.env.OPENCHAT_SKILLS_DIR = skillsRoot;

// env must be set before config.js loads → dynamic imports
const { listSkills, readSkillBody, syncBuiltinSkills } = await import("../src/agent/skills");
const { harness } = await import("../src/agent/harness");
const { db } = await import("../src/db/database");

// -- fixtures -------------------------------------------------------------
fs.mkdirSync(path.join(skillsRoot, "alpha-test"), { recursive: true });
fs.writeFileSync(
  path.join(skillsRoot, "alpha-test", "SKILL.md"),
  `---
name: wrong-name
description: "Does alpha things. Use when alpha requested."
license: MIT
---
# Alpha workflow

Step 1: run scripts/go.py
`,
);
fs.mkdirSync(path.join(skillsRoot, "alpha-test", "scripts"), { recursive: true });
fs.writeFileSync(path.join(skillsRoot, "alpha-test", "scripts", "go.py"), "print('go')\n");

fs.mkdirSync(path.join(skillsRoot, "beta-skill"), { recursive: true });
fs.writeFileSync(path.join(skillsRoot, "beta-skill", "SKILL.md"), "---\nname: beta-skill\n---\nNo description here.\n");

// invalid entries that must be ignored
fs.mkdirSync(path.join(skillsRoot, "Not_Kebab"), { recursive: true });
fs.writeFileSync(path.join(skillsRoot, "Not_Kebab", "SKILL.md"), "x\n");
fs.mkdirSync(path.join(skillsRoot, "orphan-dir"), { recursive: true }); // no SKILL.md

// -- discovery -------------------------------------------------------------
{
  const all = listSkills();
  check("discovery: only valid dirs indexed", JSON.stringify(all.map((s) => s.name)) === JSON.stringify(["alpha-test", "beta-skill"]), `${all.map((s) => s.name)}`);
  const a = all.find((s) => s.name === "alpha-test")!;
  check("discovery: dir name canonical (frontmatter mismatch warned)", a.name === "alpha-test");
  check("discovery: description parsed", a.description.includes("alpha things"));
  const b = all.find((s) => s.name === "beta-skill")!;
  check("discovery: missing description tolerated", b.description === "");
}

// -- body loading & confinement -------------------------------------------
{
  const body = await readSkillBody("alpha-test");
  check("body: loaded", !!body);
  check("body: frontmatter stripped", !body!.body.includes("wrong-name") && body!.body.includes("# Alpha workflow"));
  check("body: files listed incl. nested", body!.files.includes("scripts/go.py"), body!.files.join(","));
  check("body: base dir is the container-mapped skill root", body!.dir === "/opt/skills/alpha-test", body!.dir);

  check("confinement: unknown skill rejected", (await readSkillBody("does-not-exist")) === null);
  check("confinement: traversal rejected", (await readSkillBody("..")) === null && (await readSkillBody("etc-passwd")) === null);
  check("confinement: bad charset rejected", (await readSkillBody("Alpha-Test")) === null);
}

// -- builtin sync & precedence ---------------------------------------------
{
  const marker = path.join(skillsRoot, ".builtin", ".fingerprint");
  syncBuiltinSkills();
  check("builtin: synced to .builtin with fingerprint", fs.existsSync(marker) && fs.existsSync(path.join(skillsRoot, ".builtin", "skill-installer", "SKILL.md")));
  const fp1 = fs.readFileSync(marker, "utf8");
  const mdTime = fs.statSync(path.join(skillsRoot, ".builtin", "skill-installer", "SKILL.md")).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  syncBuiltinSkills();
  check("builtin: idempotent (no rewrite when fingerprint matches)", fs.readFileSync(marker, "utf8") === fp1 && fs.statSync(path.join(skillsRoot, ".builtin", "skill-installer", "SKILL.md")).mtimeMs === mdTime);

  const listed = listSkills();
  const inst = listed.find((s) => s.name === "skill-installer");
  check("builtin: merged into listing", !!inst && inst.builtin === true);
  const builtinBody = await readSkillBody("skill-installer");
  check("builtin: body readable via readSkillBody fallback", !!builtinBody && builtinBody.body.includes("# Skill Installer") && builtinBody.files.includes("scripts/install_skill.py"), builtinBody?.files.join(","));

  // user override shadows the builtin
  fs.mkdirSync(path.join(skillsRoot, "skill-installer"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsRoot, "skill-installer", "SKILL.md"),
    "---\nname: skill-installer\ndescription: USER OVERRIDE\n---\nUser copy.\n",
  );
  const overridden = listSkills().find((s) => s.name === "skill-installer")!;
  check("override: user skill wins in listing", overridden.builtin !== true && overridden.description === "USER OVERRIDE");
  const body = await readSkillBody("skill-installer");
  check("override: user copy wins on read", body!.dir === "/opt/skills/skill-installer");
  fs.rmSync(path.join(skillsRoot, "skill-installer"), { recursive: true, force: true });
}

// -- prompt build: slash hints stay verbatim, model self-serves via load_skill --
{
  const sid = "chat_sk1lltest";
  db.createSession(sid, "skill test");
  try {
    const uid = "msg_sk1llu1d";
    db.addMessage({ id: uid, session_id: sid, role: "user", content: "/alpha-test 알파 실행해줘" });
    db.createAttachment({ id: "att_img00d2", session_id: sid, kind: "image", name: "pic.png", mime: "image/png", size: 2048, path: "uploads/pic.png" });
    db.claimAttachments(uid, sid, ["att_img00d2"]);

    const records = db.getMessages(sid) as any[];
    const msgs = await (harness as any).prepareMessages(records, path.join(os.tmpdir(), "ws-x"));

    const sys = msgs[0].content as string;
    check("prompt: available_skills section present", sys.includes("<available_skills>") && sys.includes("<name>alpha-test</name>"));
    check("prompt: writable install hint present", sys.includes("/opt/skills"));
    check("prompt: slash→load_skill hint present", sys.includes("/<name>") && sys.includes("load_skill"));

    const user = msgs.find((m: any) => m.role === "user");
    check("enrich: slash text passes through verbatim", String(user.content).startsWith("/alpha-test 알파 실행해줘"));
    check("enrich: no skill body injected server-side", !String(user.content).includes("<skill_content"));
    check("enrich: attachment marker coexists", String(user.content).includes("[첨부 이미지: uploads/pic.png · 2KB]"));
    check("enrich: order = slash token → markers", String(user.content).indexOf("/alpha-test") < String(user.content).indexOf("[첨부 이미지"));

    // sandbox-path discipline: model-facing surfaces must never leak host paths
    check("prompt: no host paths leaked", !sys.includes("/root/") && sys.includes("/opt/skills/"));
    const { tools } = await import("../src/agent/tools");
    const loaded = await tools.execute("load_skill", { name: "skill-installer" }, sid);
    check("load_skill: base dir is container path", String(loaded).includes("Base directory for this skill: /opt/skills/.builtin/skill-installer"), String(loaded).slice(0, 90));
  } finally {
    db.deleteSession(sid);
  }
}

console.log(process.exitCode ? "\n>>> FAILED" : "\n>>> ALL PASSED");
