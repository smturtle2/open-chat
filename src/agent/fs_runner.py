import sys
import json
import os


def _resolve(rel):
    """Map a tool 'path' onto the sandbox workspace.

    Tool paths are RELATIVE by contract. os.path.join would silently accept
    absolute targets ('/opt/skills', '/etc/...') and let file tools act on the
    shared skills volume or anywhere else in the container — enforce strict
    containment instead.
    """
    if not isinstance(rel, str) or not rel.strip():
        raise ValueError("a non-empty path relative to the workspace root is required")
    if os.path.isabs(rel) or rel.startswith("~"):
        raise ValueError(f"path must be RELATIVE to the workspace root, got '{rel}'")
    p = os.path.normpath(os.path.join("/workspace", rel))
    ws = os.path.realpath("/workspace")
    rp = os.path.realpath(p)
    if rp != ws and not rp.startswith(ws + os.sep):
        raise ValueError(f"path escapes the workspace: '{rel}'")
    return p


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(f"Error: invalid request ({e})")
        return

    op = req.get("op", "")
    try:
        p = _resolve(req.get("path", ""))
    except ValueError as e:
        print(f"Error: {e}")
        return
    rel = os.path.relpath(p, "/workspace")

    try:
        if op == "read":
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            total = len(lines)
            try:
                start = int(req.get("offset") or 1)
            except (TypeError, ValueError):
                start = 1
            start = max(start, 1)
            if start > total and total > 0:
                print(f"Error: offset {start} is beyond end of file ({total} lines)")
                return
            lim_raw = req.get("limit")
            try:
                limit = int(lim_raw) if lim_raw else 0
            except (TypeError, ValueError):
                limit = 0
            end = total + 1 if limit <= 0 else min(total + 1, start + limit)
            sys.stdout.write("".join(lines[start - 1 : end - 1]))
            if end - 1 < total:
                print(f"\n[showing lines {start}-{end - 1} of {total} total; use offset={end} for next page]")

        elif op == "write":
            content = req.get("content", "")
            d = os.path.dirname(p)
            if d:
                os.makedirs(d, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)
            print(f'File "{rel}" successfully created/updated ({len(content.encode("utf-8"))} bytes).')

        elif op == "patch":
            target = req.get("target", "")
            replacement = req.get("replacement", "")
            if not os.path.exists(p):
                print(f"Error: File not found: {rel}")
                return
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                cur = f.read()
            n = cur.count(target)
            if n == 0:
                print(f'Error: Target string not found in "{rel}". Verify exact characters and whitespace.')
            elif n > 1:
                print(f'Error: Target string matched {n} times in "{rel}". Provide more surrounding context to make the replacement unique.')
            else:
                with open(p, "w", encoding="utf-8") as f:
                    f.write(cur.replace(target, replacement))
                print(f'File "{rel}" patched successfully.')

        else:
            print(f"Error: unknown operation: {op}")

    except FileNotFoundError:
        print(f"Error: File not found: {rel}")
    except IsADirectoryError:
        print(f"Error: {rel} is a directory")
    except Exception as e:
        print(f"Error: {e}")


main()
