---
name: skill-installer
description: Install OpenChat skills from a git repository URL or owner/repo path. Use when the user shares a repo or repo-folder link and wants to install/use that skill, asks to install a skill from GitHub, or wants to see what skills a repository contains.
metadata:
  short-description: Install skills from any git repo URL
---

# Skill Installer

Installs skills into `/opt/skills` — the writable skills root mounted in your
sandbox. An installed skill becomes available on your NEXT turn; always tell
the user this after installing.

## Scripts

All work happens through one script (network required):

- `scripts/install_skill.py --url https://github.com/<owner>/<repo>[/tree/<ref>/<path>] [--name <n>] [--force]`
- `scripts/install_skill.py --repo <owner>/<repo> --path <p1> [<p2> ...] [--ref main]`
- Add `--list` to either form to only discover and print candidates.

## Workflow

1. Relay the user's address as `--url` (it may be a repo root or any folder
   inside it — both work). Use `--repo` + `--path` instead when you already
   know the exact skill path(s); multiple `--path` values install in one run.
2. If the target scope is ambiguous (repo root with no specific folder) or
   you are not sure which folder is the actual skill, run with `--list`
   first: it recursively locates every `SKILL.md` under the target scope and
   prints one JSON line per candidate:
   `{"name": "...", "frontmatter_name": "...", "description": "...", "path": "skills/pdf"}`
   There are no layout assumptions — whatever contains a SKILL.md is listed.
3. Pick with the user when several candidates match the request, then install
   the chosen path(s). A single candidate can be installed directly.
4. Installation refuses to overwrite an existing skill directory unless you
   pass `--force`. Confirm with the user before using `--force`.
5. After success (`Installed <name> to /opt/skills/<name>`), confirm to the
   user that the new skill is usable on their next message.

## Communication

When showing candidates, print them as a numbered list:

"""
Skills found in {address}:
1. pdf — PDF processing: extract text/tables, merge, split, forms (skills/pdf)
2. docx — Word document creation and editing (skills/docx)
Which would you like installed?
"""

## Notes

- Download method tries codeload zip first and falls back to git sparse
  checkout (HTTPS, then SSH), so any reachable public repo works regardless
  of host quirks.
- Private repos need `GITHUB_TOKEN` or `GH_TOKEN` set in the sandbox
  environment for download mode, or working git credentials for fallback.
- Safety checks reject path traversal, symbolic links, and non-regular files;
  the skill name is derived from the folder basename (override with `--name`).
- If frontmatter `name` differs from the folder name, the folder name wins
  (a warning is printed).
