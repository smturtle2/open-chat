#!/usr/bin/env python3
"""Install an agent skill from a git repo into the skills root (/opt/skills).

Ported from OpenAI Codex's skill-installer (install-skill-from-github.py),
adapted for OpenChat: destination defaults to /opt/skills, and a --list mode
recursively discovers SKILL.md candidates under the target scope without any
layout assumptions.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

DEFAULT_REF = "main"


class Args:
    url: str | None = None
    repo: str | None = None
    path: list[str] | None = None
    ref: str = DEFAULT_REF
    dest: str | None = None
    name: str | None = None
    method: str = "auto"
    list_only: bool = False
    force: bool = False


class Source:
    def __init__(self, owner: str, repo: str, ref: str, paths: list[str], repo_url: str | None = None):
        self.owner = owner
        self.repo = repo
        self.ref = ref
        self.paths = paths
        self.repo_url = repo_url


class InstallError(Exception):
    pass


def _request(url: str) -> bytes:
    headers = {"User-Agent": "openchat-skill-install"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def _parse_github_url(url: str, default_ref: str) -> tuple[str, str, str, str | None]:
    parsed = urllib.parse.urlparse(url)
    if parsed.netloc != "github.com":
        raise InstallError("Only GitHub URLs are supported for download mode.")
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        raise InstallError("Invalid GitHub URL.")
    owner, repo = parts[0], parts[1]
    ref = default_ref
    subpath = ""
    if len(parts) > 2:
        if parts[2] in ("tree", "blob"):
            if len(parts) < 4:
                raise InstallError("GitHub URL missing ref or path.")
            ref = parts[3]
            subpath = "/".join(parts[4:])
        else:
            subpath = "/".join(parts[2:])
    return owner, repo, ref, subpath or None


def _download_repo_zip(owner: str, repo: str, ref: str, dest_dir: str) -> str:
    zip_url = f"https://codeload.github.com/{owner}/{repo}/zip/{ref}"
    zip_path = os.path.join(dest_dir, "repo.zip")
    try:
        payload = _request(zip_url)
    except urllib.error.HTTPError as exc:
        raise InstallError(f"Download failed: HTTP {exc.code}") from exc
    with open(zip_path, "wb") as file_handle:
        file_handle.write(payload)
    with zipfile.ZipFile(zip_path, "r") as zip_file:
        _safe_extract_zip(zip_file, dest_dir)
        top_levels = {name.split("/")[0] for name in zip_file.namelist() if name}
    if not top_levels:
        raise InstallError("Downloaded archive was empty.")
    if len(top_levels) != 1:
        raise InstallError("Unexpected archive layout.")
    return os.path.join(dest_dir, next(iter(top_levels)))


def _run_git(args: list[str]) -> None:
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise InstallError(result.stderr.strip() or "Git command failed.")


def _safe_extract_zip(zip_file: zipfile.ZipFile, dest_dir: str) -> None:
    dest_root = os.path.realpath(dest_dir)
    for info in zip_file.infolist():
        extracted_path = os.path.realpath(os.path.join(dest_dir, info.filename))
        if extracted_path == dest_root or extracted_path.startswith(dest_root + os.sep):
            continue
        raise InstallError("Archive contains files outside the destination.")
    zip_file.extractall(dest_dir)


def _validate_relative_path(path: str) -> None:
    if os.path.isabs(path) or os.path.normpath(path).startswith(".."):
        raise InstallError("Skill path must be a relative path inside the repo.")


def _validate_skill_name(name: str) -> None:
    if not name or os.path.sep in name or (os.altsep and os.altsep in name):
        raise InstallError("Skill name must be a single path segment.")
    if name in (".", ".."):
        raise InstallError("Invalid skill name.")


def _git_sparse_checkout(repo_url: str, ref: str, paths: list[str], dest_dir: str) -> str:
    repo_dir = os.path.join(dest_dir, "repo")
    try:
        _run_git(
            ["git", "clone", "--filter=blob:none", "--depth", "1", "--sparse",
             "--single-branch", "--branch", ref, repo_url, repo_dir]
        )
    except InstallError:
        _run_git(
            ["git", "clone", "--filter=blob:none", "--depth", "1", "--sparse",
             "--single-branch", repo_url, repo_dir]
        )
    _run_git(["git", "-C", repo_dir, "sparse-checkout", "set", *paths])
    _run_git(["git", "-C", repo_dir, "checkout", ref])
    return repo_dir


def _check_symlinks(skill_path: str, repo_root: str) -> None:
    resolved_repo_root = os.path.realpath(repo_root)
    resolved_path = os.path.realpath(skill_path)
    try:
        inside_repo = os.path.commonpath([resolved_repo_root, resolved_path]) == resolved_repo_root
    except ValueError:
        inside_repo = False
    if not inside_repo:
        raise InstallError("Skill path must be inside the repo.")

    relative_path = os.path.relpath(skill_path, repo_root)
    current_path = repo_root
    for component in relative_path.split(os.path.sep):
        current_path = os.path.join(current_path, component)
        if os.path.islink(current_path):
            raise InstallError(f"Symbolic links are not allowed in skills: {os.path.relpath(current_path, repo_root)}")

    if not os.path.isdir(skill_path):
        raise InstallError(f"Skill path not found: {skill_path}")

    for root, directories, files in os.walk(skill_path):
        for name in directories + files:
            entry_path = os.path.join(root, name)
            relative_entry = os.path.relpath(entry_path, repo_root)
            if os.path.islink(entry_path):
                resolved_entry = os.path.realpath(entry_path)
                try:
                    inside_skill = os.path.commonpath([resolved_path, resolved_entry]) == resolved_path
                except ValueError:
                    inside_skill = False
                if not inside_skill or not os.path.isfile(resolved_entry):
                    raise InstallError(f"Unsupported symbolic link in skill: {relative_entry}")
                continue
            if not os.path.isdir(entry_path) and not os.path.isfile(entry_path):
                raise InstallError(f"Unsupported file type in skill: {relative_entry}")


def _require_skill_md(path: str) -> None:
    skill_md = os.path.join(path, "SKILL.md")
    if not os.path.isfile(skill_md):
        raise InstallError(f"SKILL.md not found in {path}. Use --list to discover candidates.")


def _copy_skill(src: str, dest_dir: str) -> None:
    os.makedirs(os.path.dirname(dest_dir), exist_ok=True)
    shutil.copytree(src, dest_dir)


def _build_repo_url(owner: str, repo: str) -> str:
    return f"https://github.com/{owner}/{repo}.git"


def _build_repo_ssh(owner: str, repo: str) -> str:
    return f"git@github.com:{owner}/{repo}.git"


def _prepare_repo(source: Source, method: str, tmp_dir: str) -> str:
    if method in ("download", "auto"):
        try:
            return _download_repo_zip(source.owner, source.repo, source.ref, tmp_dir)
        except InstallError as exc:
            if method == "download":
                raise
            if any(code in str(exc) for code in ("HTTP 401", "HTTP 403", "HTTP 404")):
                pass
            else:
                raise
    if method in ("git", "auto"):
        repo_url = source.repo_url or _build_repo_url(source.owner, source.repo)
        try:
            return _git_sparse_checkout(repo_url, source.ref, source.paths or [""], tmp_dir)
        except InstallError:
            try:
                return _git_sparse_checkout(_build_repo_url(source.owner, source.repo), source.ref, source.paths or [""], tmp_dir)
            except InstallError:
                return _git_sparse_checkout(_build_repo_ssh(source.owner, source.repo), source.ref, source.paths or [""], tmp_dir)
    raise InstallError("Unsupported method.")


def _resolve_source(args: Args) -> Source:
    if args.url:
        owner, repo, ref, url_path = _parse_github_url(args.url, args.ref)
        paths = list(args.path) if args.path is not None else ([url_path] if url_path else [])
        return Source(owner=owner, repo=repo, ref=ref, paths=paths)

    if not args.repo:
        raise InstallError("Provide --url or --repo.")
    if "://" in args.repo:
        return _resolve_source(Args(url=args.repo, path=args.path, ref=args.ref))
    repo_parts = [p for p in args.repo.split("/") if p]
    if len(repo_parts) != 2:
        raise InstallError("--repo must be in owner/repo format.")
    return Source(owner=repo_parts[0], repo=repo_parts[1], ref=args.ref, paths=list(args.path or []))


def _parse_frontmatter(raw: str) -> dict[str, str]:
    import re

    m = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", raw)
    out: dict[str, str] = {}
    if not m:
        return out
    for line in m.group(1).splitlines():
        kv = re.match(r"^(name|description)\s*:\s*(.*)$", line)
        if not kv:
            continue
        v = kv.group(2).strip().strip("\"'")
        if v in (">", ">-", "|", "|-", ">", "|+"):  # block scalar indicator — value on following lines, skip
            v = ""
        out[kv.group(1)] = v[:300]
    return out


def _discover_candidates(repo_root: str, scope_rel: str | None) -> list[dict[str, str]]:
    """Recursively find SKILL.md under scope; no layout assumptions."""
    base = os.path.join(repo_root, scope_rel) if scope_rel else repo_root
    if not os.path.isdir(base):
        raise InstallError(f"Scope path not found in repo: {scope_rel}")
    candidates: list[dict[str, str]] = []
    for root, directories, files in os.walk(base):
        # skip vendored / hidden trees
        directories[:] = [d for d in directories if not d.startswith(".") and d != "node_modules"]
        if "SKILL.md" in files:
            rel_dir = os.path.relpath(root, repo_root).replace(os.sep, "/")
            try:
                with open(os.path.join(root, "SKILL.md"), encoding="utf-8", errors="replace") as fh:
                    fm = _parse_frontmatter(fh.read())
            except OSError:
                fm = {}
            candidates.append(
                {
                    "name": os.path.basename(root),
                    "frontmatter_name": fm.get("name", ""),
                    "description": fm.get("description", ""),
                    "path": "" if rel_dir == "." else rel_dir,
                }
            )
    candidates.sort(key=lambda c: c["path"])
    return candidates


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Install a skill from a git repo.")
    parser.add_argument("--url", help="https://github.com/owner/repo[/tree/ref/path]")
    parser.add_argument("--repo", help="owner/repo")
    parser.add_argument("--path", nargs="+", help="Path(s) to skill(s) inside the repo")
    parser.add_argument("--ref", default=DEFAULT_REF)
    parser.add_argument("--dest", help=f"Destination skills directory (default /opt/skills)")
    parser.add_argument("--name", help="Destination skill name (defaults to basename of path)")
    parser.add_argument("--method", choices=["auto", "download", "git"], default="auto")
    parser.add_argument("--list", action="store_true", help="Only discover and print candidate skills as JSON lines")
    parser.add_argument("--force", action="store_true", help="Replace an existing installed skill directory")
    args = parser.parse_args(argv, namespace=Args())

    try:
        source = _resolve_source(args)
        source.ref = source.ref or args.ref
        dest_root = args.dest or "/opt/skills"

        # --list needs at least one fetchable scope; empty paths means whole repo.
        if not args.list and not source.paths:
            raise InstallError("No skill paths provided. Use --list to discover candidates first.")

        for p in source.paths or []:
            _validate_relative_path(p)

        tmp_dir = tempfile.mkdtemp(prefix="skill-install-")
        try:
            repo_root = _prepare_repo(source, args.method, tmp_dir)

            if args.list:
                scopes = source.paths or [None]
                seen: set[str] = set()
                for scope in scopes:
                    for cand in _discover_candidates(repo_root, scope):
                        key = cand["path"]
                        if key in seen:
                            continue
                        seen.add(key)
                        print(json.dumps(cand))
                return 0

            installed = []
            for path in source.paths or []:
                _check_symlinks(os.path.join(repo_root, path), repo_root)
                _require_skill_md(os.path.join(repo_root, path))
                skill_name = args.name if len(source.paths) == 1 else None
                skill_name = skill_name or os.path.basename(path.rstrip("/"))
                _validate_skill_name(skill_name)
                dest_dir = os.path.join(dest_root, skill_name)
                if os.path.exists(dest_dir):
                    if not args.force:
                        raise InstallError(f"Destination already exists: {dest_dir} (use --force to replace)")
                    shutil.rmtree(dest_dir)
                _copy_skill(os.path.join(repo_root, path), dest_dir)
                installed.append((skill_name, dest_dir))
        finally:
            if os.path.isdir(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)

        for skill_name, dest_dir in installed:
            print(f"Installed {skill_name} to {dest_dir}")
        return 0
    except InstallError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
