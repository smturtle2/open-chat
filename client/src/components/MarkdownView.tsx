import React, { useEffect, useMemo, useRef } from "react";
import { marked, Renderer } from "marked";
import hljs from "highlight.js";
import katex from "katex";
import DOMPurify from "dompurify";
import { useChatStore } from "../store/useChatStore";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";

interface MarkdownViewProps {
  content: string;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content }) => {
  const { currentSessionId } = useChatStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const renderedHtml = useMemo(() => {
    if (!content) return "";

    // 1. Math formulas rendering ($$...$$ and $...$)
    let processed = content.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
      try {
        return `<div class="katex-display-block my-2 p-2 text-center overflow-x-auto bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/80 dark:border-zinc-700/60 rounded-lg text-sm">${katex.renderToString(
          math.trim(),
          { displayMode: true, throwOnError: false }
        )}</div>`;
      } catch {
        return `$$${math}$$`;
      }
    });

    processed = processed.replace(/\$([^\$\n\s][^\$\n]*?[^\$\n\s]|\S)\$/g, (_, math) => {
      // Ignore plain dollar amounts like $10 or $25.50
      if (/^\d+(\.\d+)?$/.test(math.trim())) {
        return `$${math}$`;
      }
      try {
        return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
      } catch {
        return `$${math}$`;
      }
    });

    const renderer = new Renderer();

    // 2. Clickable Links with automatic workspace file resolution
    renderer.link = ({ href, title, text }: any) => {
      let resolvedHref = href;
      if (
        !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("#") &&
        !href.startsWith("/")
      ) {
        if (currentSessionId) {
          resolvedHref = `/api/sessions/${currentSessionId}/files/${encodeURIComponent(href)}`;
        }
      }

      const titleAttr = title ? ` title="${escapeAttr(String(title))}"` : "";
      return `<a href="${escapeAttr(resolvedHref)}" target="_blank" rel="noopener noreferrer"${titleAttr} class="text-zinc-900 dark:text-zinc-100 font-medium underline underline-offset-4 decoration-zinc-400 dark:decoration-zinc-500 hover:decoration-zinc-900 dark:hover:decoration-zinc-100 transition-colors break-all cursor-pointer">${text}</a>`;
    };

    // 2.1. Inline Image renderer for charts and diagrams
    renderer.image = ({ href, title, text }: any) => {
      let resolvedHref = href;
      if (
        !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("data:") &&
        !href.startsWith("/")
      ) {
        if (currentSessionId) {
          resolvedHref = `/api/sessions/${currentSessionId}/files/${encodeURIComponent(href)}`;
        }
      }
      const titleAttr = title ? ` title="${escapeAttr(String(title))}"` : "";
      const altAttr = text ? ` alt="${escapeAttr(String(text))}"` : ' alt="image"';
      return `<div class="my-3"><a href="${escapeAttr(resolvedHref)}" target="_blank" rel="noreferrer" class="block group"><img src="${escapeAttr(resolvedHref)}"${altAttr}${titleAttr} class="max-h-96 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm hover:opacity-95 transition-opacity" loading="lazy" /></a></div>`;
    };

    // 3. Syntax-highlighted code blocks with Copy & Open Artifact buttons
    renderer.code = (token: any) => {
      const text = token.text || "";
      const lang = token.lang || "plaintext";
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      let highlighted = text;
      try {
        highlighted = hljs.highlight(text, { language }).value;
      } catch {
        highlighted = text;
      }

      const encodedCode = encodeURIComponent(text);
      const isArtifactType = ["html", "svg", "jsx", "tsx", "react", "mermaid", "markdown", "javascript", "typescript", "python"].includes(lang.toLowerCase());
      let artifactKind = "code";
      if (lang.toLowerCase() === "html") artifactKind = "html";
      else if (lang.toLowerCase() === "svg") artifactKind = "svg";
      else if (lang.toLowerCase() === "mermaid") artifactKind = "mermaid";
      else if (["jsx", "tsx", "react"].includes(lang.toLowerCase())) artifactKind = "react";
      else if (lang.toLowerCase() === "markdown") artifactKind = "markdown";

      const artifactTitle = `${lang.toUpperCase()} Component`;

      return `
        <div class="code-container my-2.5 rounded-xl overflow-hidden border border-zinc-200/80 dark:border-zinc-800 bg-[#18181b] font-mono text-[13px] shadow-xs">
          <div class="flex items-center justify-between px-3 py-1.5 bg-[#202023] text-zinc-400 text-xs select-none">
            <span class="font-medium text-[11px] text-zinc-300">${escapeAttr(language)}</span>
            <div class="flex items-center gap-1.5">
              ${
                isArtifactType
                  ? `<button
                      type="button"
                      class="open-artifact-btn px-2 py-0.5 rounded text-[11px] font-medium text-amber-400 hover:text-amber-300 hover:bg-zinc-700/60 transition-colors cursor-pointer flex items-center gap-1"
                      data-artifact-title="${escapeAttr(artifactTitle)}"
                      data-artifact-type="${escapeAttr(artifactKind)}"
                      data-artifact-code="${encodedCode}"
                    >
                      <span>⚡ Open Artifact</span>
                    </button>`
                  : ""
              }
              <button
                type="button"
                class="copy-code-btn px-1.5 py-0.5 rounded text-[11px] hover:text-white hover:bg-zinc-700 transition-colors cursor-pointer"
                data-code="${encodedCode}"
              >
                <span>Copy</span>
              </button>
            </div>
          </div>
          <pre class="p-3 overflow-x-auto leading-relaxed text-zinc-200"><code class="hljs language-${language}">${highlighted}</code></pre>
        </div>
      `;
    };

    const rawHtml = marked.parse(processed, { renderer, gfm: true, breaks: true }) as string;

    // Final gate: strip scripts/event handlers/javascript: URLs from model-
    // or web-sourced HTML before it ever touches the DOM.
    return DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ["data-code", "data-artifact-title", "data-artifact-type", "data-artifact-code", "target", "loading"],
      FORBID_TAGS: ["style", "form", "iframe"],
    });
  }, [content, currentSessionId]);

  // Delegated click handler for copy & open artifact buttons
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // 1. Copy button
      const copyBtn = target.closest?.(".copy-code-btn") as HTMLButtonElement | null;
      if (copyBtn) {
        navigator.clipboard.writeText(decodeURIComponent(copyBtn.getAttribute("data-code") || ""));
        const label = copyBtn.querySelector("span") || copyBtn;
        const originalText = label.textContent || "Copy";
        label.textContent = "Copied!";
        setTimeout(() => {
          label.textContent = originalText;
        }, 2000);
        return;
      }

      // 2. Open Artifact button
      const artifactBtn = target.closest?.(".open-artifact-btn") as HTMLButtonElement | null;
      if (artifactBtn) {
        const title = artifactBtn.getAttribute("data-artifact-title") || "Artifact";
        const type = (artifactBtn.getAttribute("data-artifact-type") || "code") as any;
        const code = decodeURIComponent(artifactBtn.getAttribute("data-artifact-code") || "");
        useChatStore.getState().openArtifact({
          id: `art_${Date.now()}`,
          title,
          type,
          content: code,
        });
      }
    };

    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return (
    <div
      ref={containerRef}
      className="markdown-content text-sm leading-relaxed text-zinc-900 dark:text-zinc-100 space-y-2"
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
};

