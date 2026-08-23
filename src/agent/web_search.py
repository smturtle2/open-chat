import sys
import json
from urllib.parse import urlparse, parse_qs, unquote


def unwrap_url(href: str) -> str:
    # DDG wraps result links as /l/?uddg=<encoded-real-url>
    try:
        q = parse_qs(urlparse(href).query).get("uddg", [None])[0]
        if q:
            return unquote(q)
    except Exception:
        pass
    return href


def page_html(page) -> str:
    if hasattr(page, "body") and page.body:
        encoding = getattr(page, "encoding", "utf-8") or "utf-8"
        return page.body.decode(encoding, errors="replace")
    if hasattr(page, "html_content") and page.html_content:
        return str(page.html_content)
    return str(getattr(page, "text", "") or "")


def parse_html(html: str):
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    out = []
    for el in soup.select("div.web-result") or soup.select("div.result"):
        a = el.select_one("a.result__a")
        if not a or not a.get("href"):
            continue
        sn = el.select_one("a.result__snippet")
        out.append({
            "title": a.get_text(" ", strip=True),
            "url": unwrap_url(a["href"]),
            "snippet": sn.get_text(" ", strip=True) if sn else "",
        })
    return out


def parse_lite(html: str):
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    out = []
    for a in soup.select("a.result-link"):
        if not a.get("href"):
            continue
        td = a.find_parent("tr")
        snippet = ""
        if td:
            nxt = td.find_next_sibling("tr")
            if nxt:
                sn = nxt.select_one(".result-snippet")
                if sn:
                    snippet = sn.get_text(" ", strip=True)
        out.append({
            "title": a.get_text(" ", strip=True),
            "url": unwrap_url(a["href"]),
            "snippet": snippet,
        })
    return out


def run(query: str, limit: int):
    from scrapling.fetchers import Fetcher, StealthyFetcher

    results = []

    # 1) plain HTTP fetch of DDG html endpoint
    try:
        page = Fetcher.get(f"https://html.duckduckgo.com/html/?q={query}", timeout=25)
        results = parse_html(page_html(page))
    except Exception:
        results = []

    # 2) stealth browser (bypasses anomaly/captcha pages)
    if len(results) < 1:
        try:
            page = StealthyFetcher.fetch(
                f"https://html.duckduckgo.com/html/?q={query}",
                headless=True,
                network_idle=True,
                timeout=45000,
            )
            results = parse_html(page_html(page))
        except Exception:
            pass

    # 3) lite endpoint as last resort
    if len(results) < 1:
        try:
            page = Fetcher.get(f"https://lite.duckduckgo.com/lite/?q={query}", timeout=25)
            results = parse_lite(page_html(page))
        except Exception:
            pass

    return [r for r in results if r["url"]][:limit]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python web_search.py '<query>' [limit]")
        sys.exit(1)

    q = sys.argv[1]
    lim = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    print(json.dumps(run(q, lim), ensure_ascii=False))
