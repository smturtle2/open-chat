import sys
import json
import os
import re
from bs4 import BeautifulSoup
import markdownify

def run_fetch(params: dict, workspace_dir: str):
    from scrapling.fetchers import Fetcher, StealthyFetcher, DynamicFetcher

    url = params.get("url", "").strip()
    if not url:
        return "[Scrapling Error] URL is required."

    engine = params.get("engine", "http").lower()
    selector_type = params.get("selector_type", "css").lower()
    selector = params.get("selector")
    extract_format = params.get("extract_format", "markdown").lower()
    wait_for = params.get("wait_for")
    screenshot = params.get("screenshot", False)
    adaptive = params.get("adaptive", False)

    try:
        page = None
        if engine == "stealth":
            fetch_kwargs = {"headless": True, "network_idle": True, "timeout": 30000}
            if wait_for:
                if isinstance(wait_for, (int, float)):
                    fetch_kwargs["timeout"] = int(wait_for) + 30000
                elif isinstance(wait_for, str):
                    fetch_kwargs["wait_selector"] = wait_for
            page = StealthyFetcher.fetch(url, **fetch_kwargs)
        elif engine == "dynamic":
            fetch_kwargs = {"headless": True, "network_idle": True, "timeout": 30000}
            if wait_for:
                if isinstance(wait_for, str):
                    fetch_kwargs["wait_selector"] = wait_for
            page = DynamicFetcher.fetch(url, **fetch_kwargs)
        else:
            page = Fetcher.get(url, timeout=25)

        # Decode HTML content
        if hasattr(page, "body") and page.body:
            encoding = getattr(page, "encoding", "utf-8") or "utf-8"
            html_content = page.body.decode(encoding, errors="replace")
        elif hasattr(page, "html_content") and page.html_content:
            html_content = str(page.html_content)
        else:
            html_content = str(page.text or "")

        # Screenshot support
        screenshot_msg = ""
        if screenshot and hasattr(page, "screenshot"):
            try:
                img_name = f"screenshot_{re.sub(r'[^a-zA-Z0-9]', '_', url)[:30]}.png"
                img_path = os.path.join(workspace_dir, img_name)
                page.screenshot(path=img_path, full_page=True)
                screenshot_msg = f"\n[Screenshot saved to: {img_name}]\n"
            except Exception as ss_err:
                screenshot_msg = f"\n[Screenshot error: {ss_err}]\n"

        # Apply Selectors
        matched_elements = []
        if selector and selector.strip():
            sel = selector.strip()
            if selector_type == "xpath":
                matched_elements = page.xpath(sel)
            elif selector_type == "text":
                matched_elements = page.find_by_text(sel)
            elif selector_type == "regex":
                matched_elements = page.find_by_regex(sel)
            else:  # css (default)
                if adaptive:
                    matched_elements = page.css(sel, adaptive=True)
                else:
                    matched_elements = page.css(sel)

            if not matched_elements:
                return f"[Scrapling] No elements matched {selector_type.upper()} selector '{sel}' on {url} (HTTP {page.status}){screenshot_msg}"

            html_content = "\n".join([e.prettify() if hasattr(e, "prettify") else str(e) for e in matched_elements])

        if not html_content.strip():
            return f"[Scrapling] Empty content returned from {url} (HTTP {page.status}){screenshot_msg}"

        # Formatting
        if extract_format == "html":
            return (html_content[:15000] + screenshot_msg)

        elif extract_format == "text":
            soup = BeautifulSoup(html_content, "lxml")
            for tag in soup(["script", "style", "nav", "footer", "noscript"]):
                tag.decompose()
            text = soup.get_text(separator=" ", strip=True)
            return (text[:12000] + screenshot_msg)

        elif extract_format == "links":
            soup = BeautifulSoup(html_content, "lxml")
            links = []
            for a in soup.find_all("a", href=True):
                t = a.get_text(strip=True)
                h = a["href"]
                if t and h:
                    links.append(f"- [{t}]({h})")
            res = "\n".join(links[:80]) or "No links found"
            return (res + screenshot_msg)

        elif extract_format == "json":
            soup = BeautifulSoup(html_content, "lxml")
            title = soup.title.string.strip() if soup.title else ""
            headings = [h.get_text(strip=True) for h in soup.find_all(["h1", "h2", "h3"]) if h.get_text(strip=True)]
            paragraphs = [p.get_text(strip=True) for p in soup.find_all("p") if p.get_text(strip=True)]
            links = [{"text": a.get_text(strip=True), "href": a["href"]} for a in soup.find_all("a", href=True) if a.get_text(strip=True)]
            data = {
                "url": url,
                "status": getattr(page, "status", 200),
                "title": title,
                "headings": headings[:15],
                "paragraphs": paragraphs[:20],
                "links": links[:30],
            }
            return (json.dumps(data, ensure_ascii=False, indent=2)[:15000] + screenshot_msg)

        else:  # markdown (default)
            soup = BeautifulSoup(html_content, "lxml")
            for tag in soup(["script", "style", "noscript"]):
                tag.decompose()
            md = markdownify.markdownify(str(soup), heading_style="ATX")
            lines = [line.strip() for line in md.split("\n") if line.strip()]
            cleaned = "\n\n".join(lines)
            return (cleaned[:12000] or "[Scrapling] Extracted empty text from page.") + screenshot_msg

    except Exception as e:
        return f"[Scrapling Error]: {type(e).__name__}: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python scrapling_fetch.py '<json_args>' '<workspace_dir>'")
        sys.exit(1)

    try:
        json_args = json.loads(sys.argv[1])
        ws_dir = sys.argv[2]
        result = run_fetch(json_args, ws_dir)
        print(result)
    except Exception as err:
        print(f"Error executing fetch: {err}")
        sys.exit(1)
