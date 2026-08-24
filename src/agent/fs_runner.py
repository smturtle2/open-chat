import sys
import json
import os


def _resolve(p):
    """Map a tool 'path' onto the sandbox filesystem.

    The container IS the security boundary — the host filesystem is not
    visible from inside, so file tools may act anywhere within the sandbox
    (bash/python always could). Relative paths resolve against /workspace,
    the session root; absolute paths are used verbatim ('/opt/skills/...');
    '~' expands to the container home.
    """
    if not isinstance(p, str) or not p.strip():
        raise ValueError("a non-empty path is required")
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join("/workspace", p)
    return os.path.normpath(p)


def _display(p):
    """Show workspace paths relatively; anything else verbatim."""
    rel = os.path.relpath(p, "/workspace")
    return p if rel.startswith("..") else rel


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
    rel = _display(p)

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
