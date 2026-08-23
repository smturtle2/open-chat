import sys
import json
import os
import re
import asyncio
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup
import markdownify

async def crawl_worker(queue: asyncio.Queue, visited: set, results: list, css_selector: str, link_pattern: str, base_domain: str, max_pages: int, lock: asyncio.Lock):
    from scrapling.fetchers import AsyncFetcher

    fetcher = AsyncFetcher()

    while True:
        try:
            url, depth = await asyncio.wait_for(queue.get(), timeout=3.0)
        except asyncio.TimeoutError:
            break

        async with lock:
            if len(results) >= max_pages:
                queue.task_done()
                break

        try:
            res = await fetcher.get(url, timeout=20)
            if hasattr(res, "body") and res.body:
                encoding = getattr(res, "encoding", "utf-8") or "utf-8"
                html = res.body.decode(encoding, errors="replace")
            else:
                html = str(res.html_content or res.text or "")

            soup = BeautifulSoup(html, "lxml")
            title = soup.title.string.strip() if soup.title else url

            # Extract content
            if css_selector and css_selector.strip():
                matched = soup.select(css_selector.strip())
                content_html = "\n".join([str(m) for m in matched]) if matched else html
            else:
                content_html = html

            for tag in soup(["script", "style", "noscript", "nav", "footer"]):
                tag.decompose()

            cleaned_md = markdownify.markdownify(content_html, heading_style="ATX")
            lines = [line.strip() for line in cleaned_md.split("\n") if line.strip()]
            summary_text = "\n".join(lines)[:3000]

            item = {
                "url": url,
                "status": getattr(res, "status", 200),
                "title": title,
                "depth": depth,
                "content_preview": summary_text,
            }

            async with lock:
                if len(results) < max_pages:
                    results.append(item)

            # Discover more links if depth < 3
            if depth < 3:
                for a in soup.find_all("a", href=True):
                    raw_href = a["href"].split("#")[0].strip()
                    if not raw_href or raw_href.startswith("mailto:") or raw_href.startswith("javascript:"):
                        continue
                    full_url = urljoin(url, raw_href)
                    parsed = urlparse(full_url)
                    if parsed.netloc == base_domain:
                        if link_pattern:
                            if not re.search(link_pattern, full_url):
                                continue
                        async with lock:
                            if full_url not in visited and len(visited) < max_pages * 3:
                                visited.add(full_url)
                                await queue.put((full_url, depth + 1))

        except Exception as e:
            item = {"url": url, "error": str(e), "depth": depth}
            async with lock:
                results.append(item)
        finally:
            queue.task_done()

async def run_crawler_async(start_urls: list, crawl_type: str, link_pattern: str, css_selector: str, max_pages: int, concurrency: int, output_file: str, workspace_dir: str):
    from scrapling.fetchers import AsyncFetcher

    queue = asyncio.Queue()
    visited = set()
    results = []
    lock = asyncio.Lock()

    if not start_urls:
        return "[Scrapling Error] start_urls is required."

    base_domain = urlparse(start_urls[0]).netloc

    # Sitemap mode
    if crawl_type == "sitemap":
        fetcher = AsyncFetcher()
        sitemap_urls = []
        for s_url in start_urls:
            target_sitemap = s_url if s_url.endswith(".xml") else urljoin(s_url, "/sitemap.xml")
            try:
                res = await fetcher.get(target_sitemap, timeout=15)
                xml_content = res.body.decode("utf-8", errors="replace") if hasattr(res, "body") else res.text
                found_urls = re.findall(r"<loc>(https?://[^<]+)</loc>", xml_content)
                for u in found_urls:
                    if u not in visited:
                        visited.add(u)
                        sitemap_urls.append(u)
            except Exception:
                pass

        if sitemap_urls:
            for u in sitemap_urls[:max_pages]:
                await queue.put((u, 1))
        else:
            for u in start_urls:
                visited.add(u)
                await queue.put((u, 0))
    else:
        for u in start_urls:
            visited.add(u)
            await queue.put((u, 0))

    workers = [
        asyncio.create_task(crawl_worker(queue, visited, results, css_selector, link_pattern, base_domain, max_pages, lock))
        for _ in range(min(concurrency, 8))
    ]

    await asyncio.gather(*workers, return_exceptions=True)

    # Save output file in workspace
    out_filename = output_file or "crawl_results.json"
    full_out_path = os.path.join(workspace_dir, out_filename)

    with open(full_out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    total_crawled = len(results)
    success_count = sum(1 for r in results if "error" not in r)

    output_lines = [
        f"### Scrapling Spider Crawl Complete",
        f"- **Crawled Pages**: {total_crawled} (Success: {success_count})",
        f"- **Output File Saved**: [{out_filename}]({out_filename}) ({os.path.getsize(full_out_path)} bytes)",
        f"\n**Sample Pages Collected:**"
    ]

    for idx, r in enumerate(results[:5]):
        if "error" in r:
            output_lines.append(f"{idx + 1}. [{r['url']}]({r['url']}) - Error: {r['error']}")
        else:
            output_lines.append(f"{idx + 1}. **{r.get('title', 'Untitled')}** - [{r['url']}]({r['url']})")

    return "\n".join(output_lines)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python scrapling_crawl.py '<json_args>' '<workspace_dir>'")
        sys.exit(1)

    try:
        json_args = json.loads(sys.argv[1])
        ws_dir = sys.argv[2]
        start_urls = json_args.get("start_urls", [])
        if isinstance(start_urls, str):
            start_urls = [start_urls]
        crawl_type = json_args.get("crawl_type", "follow_links")
        link_pattern = json_args.get("link_pattern", "")
        css_selector = json_args.get("css_selector", "")
        max_pages = min(int(json_args.get("max_pages", 10)), 50)
        concurrency = min(int(json_args.get("concurrency", 4)), 8)
        output_file = json_args.get("output_file", "crawl_results.json")

        summary = asyncio.run(run_crawler_async(
            start_urls, crawl_type, link_pattern, css_selector, max_pages, concurrency, output_file, ws_dir
        ))
        print(summary)
    except Exception as err:
        print(f"Error executing crawler: {err}")
        sys.exit(1)
