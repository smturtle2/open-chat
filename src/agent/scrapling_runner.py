import sys
import json
from bs4 import BeautifulSoup
import markdownify

def run_scrapling(url: str, mode: str = "http", selector: str = None, extract_format: str = "markdown"):
    from scrapling.fetchers import Fetcher, StealthyFetcher, DynamicFetcher

    try:
        if mode == "stealth":
            page = StealthyFetcher.fetch(url, headless=True, network_idle=True, timeout=30000)
        elif mode == "dynamic":
            page = DynamicFetcher.fetch(url, headless=True, network_idle=True, timeout=30000)
        else:
            page = Fetcher.get(url, timeout=20)

        # Get full decoded HTML content from Scrapling response
        if hasattr(page, "body") and page.body:
            encoding = getattr(page, "encoding", "utf-8") or "utf-8"
            html_content = page.body.decode(encoding, errors="replace")
        elif hasattr(page, "html_content") and page.html_content:
            html_content = str(page.html_content)
        else:
            html_content = str(page.text or "")

        if selector and selector.strip():
            elements = page.css(selector.strip())
            if not elements:
                return f"[Scrapling] No elements matched CSS selector '{selector}' on {url} (Status: {page.status})"
            html_content = "\n".join([e.prettify() if hasattr(e, "prettify") else str(e) for e in elements])

        if not html_content.strip():
            return f"[Scrapling] Fetched empty content from {url} (Status: {page.status})"

        if extract_format == "html":
            return html_content[:12000]

        elif extract_format == "text":
            soup = BeautifulSoup(html_content, "lxml")
            for tag in soup(["script", "style", "nav", "footer", "noscript"]):
                tag.decompose()
            text = soup.get_text(separator=" ", strip=True)
            return text[:10000]

        elif extract_format == "links":
            soup = BeautifulSoup(html_content, "lxml")
            links = []
            for a in soup.find_all("a", href=True):
                t = a.get_text(strip=True)
                h = a["href"]
                if t and h:
                    links.append(f"- [{t}]({h})")
            return "\n".join(links[:60]) or "No links found"

        else:  # markdown (default)
            soup = BeautifulSoup(html_content, "lxml")
            for tag in soup(["script", "style", "noscript"]):
                tag.decompose()
            md = markdownify.markdownify(str(soup), heading_style="ATX")
            lines = [line.strip() for line in md.split("\n") if line.strip()]
            cleaned = "\n\n".join(lines)
            return cleaned[:10000] or "[Scrapling] Extracted empty text from page."

    except Exception as e:
        return f"[Scrapling Error]: {type(e).__name__}: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scrapling_runner.py '<json_args>'")
        sys.exit(1)

    try:
        args = json.loads(sys.argv[1])
        url = args.get("url", "")
        mode = args.get("mode", "http")
        selector = args.get("css_selector")
        extract_format = args.get("extract_format", "markdown")
        result = run_scrapling(url, mode, selector, extract_format)
        print(result)
    except Exception as err:
        print(f"Error parsing arguments: {err}")
        sys.exit(1)
