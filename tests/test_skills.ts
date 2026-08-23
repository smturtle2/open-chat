// Unit tests for the skills module: discovery, frontmatter parsing, confined
// body reads, and prepareMessages enrichment (slash-invoked skill injection).
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
const { listSkills, readSkillBody } = await import("../src/agent/skills");
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
  check("body: base dir points at skill root", body!.dir === path.join(skillsRoot, "alpha-test"));

  check("confinement: unknown skill rejected", (await readSkillBody("does-not-exist")) === null);
  check("confinement: traversal rejected", (await readSkillBody("..")) === null && (await readSkillBody("etc-passwd")) === null);
  check("confinement: bad charset rejected", (await readSkillBody("Alpha-Test")) === null);
}

// -- prompt enrichment (slash-invoked skill rides the user turn) ------------
{
  const sid = "chat_sk1lltest";
  db.createSession(sid, "skill test");
  try {
    const uid = "msg_sk1llu1d";
    db.addMessage({ id: uid, session_id: sid, role: "user", content: "알파 실행해줘" });
    db.createAttachment({ id: "att_skl00d1", session_id: sid, kind: "skill", name: "alpha-test", mime: "text/markdown", size: 10, path: "alpha-test" });
    db.createAttachment({ id: "att_img00d2", session_id: sid, kind: "image", name: "pic.png", mime: "image/png", size: 2048, path: "uploads/pic.png" });
    db.claimAttachments(uid, sid, ["att_skl00d1", "att_img00d2"]);

    const records = db.getMessages(sid) as any[];
    const msgs = await (harness as any).prepareMessages(records, path.join(os.tmpdir(), "ws-x"));

    const sys = msgs[0].content as string;
    check("prompt: available_skills section present", sys.includes("<available_skills>") && sys.includes("<name>alpha-test</name>"));
    check("prompt: writable install hint present", sys.includes("/opt/skills"));

    const user = msgs.find((m: any) => m.role === "user");
    check("enrich: transcript text untouched in DB", records[0].content === "알파 실행해줘");
    check("enrich: skill content injected", user.content.includes('<skill_content name="alpha-test">') && user.content.includes("# Alpha workflow"));
    check("enrich: attachment marker coexists", user.content.includes("[첨부 이미지: uploads/pic.png · 2KB]"));
    check("enrich: order = text → markers → skill block", user.content.indexOf("알파") < user.content.indexOf("[첨부 이미지") && user.content.indexOf("[첨부 이미지") < user.content.indexOf("<skill_content"));

    // missing skill degrades visibly
    db.createAttachment({ id: "att_sklbad3", session_id: sid, kind: "skill", name: "vanished", mime: "text/markdown", size: 0, path: "vanished" });
    db.claimAttachments(uid, sid, ["att_sklbad3"]);
    const msgs2 = await (harness as any).prepareMessages(db.getMessages(sid) as any[], "/tmp/x");
    const u2 = msgs2.find((m: any) => m.role === "user");
    check("enrich: vanished skill degrades to notice", u2.content.includes("[스킬 유실: vanished]"));
  } finally {
    db.deleteSession(sid);
  }
}

console.log(process.exitCode ? "\n>>> FAILED" : "\n>>> ALL PASSED");
