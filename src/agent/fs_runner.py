import sys
import json
import os


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(f"Error: invalid request ({e})")
        return

    op = req.get("op", "")
    rel = req.get("path", "")
    p = os.path.join("/workspace", rel)

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
