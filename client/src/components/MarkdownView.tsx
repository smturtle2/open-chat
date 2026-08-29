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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content }) => {
  const { currentSessionId } = useChatStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const renderedHtml = useMemo(() => {
    if (!content) return "";

    // 1. Extract and protect code blocks & inline code so math parser never mangles them
    const codeBlocks: string[] = [];
    const inlineCodes: string[] = [];
    const mathTokens: string[] = [];

    let text = content;

    // 1.1 Fenced code blocks
    text = text.replace(/```[\s\S]*?```/g, (match) => {
      const idx = codeBlocks.length;
      codeBlocks.push(match);
      return `@@OPENCHAT_CODE_BLOCK_${idx}@@`;
    });

    // 1.2 Inline code spans
    text = text.replace(/`[^`\n]+?`/g, (match) => {
      const idx = inlineCodes.length;
      inlineCodes.push(match);
      return `@@OPENCHAT_INLINE_CODE_${idx}@@`;
    });

    // 2. Render Math formulas safely
    // 2.1 Block math ($$...$$)
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
      const idx = mathTokens.length;
      try {
        const rendered = `<div class="katex-display-block my-2 p-2 text-center overflow-x-auto bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/80 dark:border-zinc-700/60 rounded-lg text-sm">${katex.renderToString(
          math.trim(),
          { displayMode: true, throwOnError: false }
        )}</div>`;
        mathTokens.push(rendered);
      } catch {
        mathTokens.push(`$$${escapeHtml(math)}$$`);
      }
      return `@@OPENCHAT_MATH_TOKEN_${idx}@@`;
    });

    // 2.2 Inline math ($...$) - ignore numbers, spaces, or currency figures like $10 or $20
    text = text.replace(/(^|[^\w\$])\$([^\$\n\s][^\$\n]*?[^\$\n\s]|\S)\$([^\w\$]|$)/g, (full, pre, math, post) => {
      // Ignore plain dollar amounts
      if (/^\s*\d+([.,]\d+)?\s*$/.test(math.trim()) || math.includes(" and ") || math.includes(" to ")) {
        return full;
      }
      const idx = mathTokens.length;
      try {
        const rendered = katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
        mathTokens.push(rendered);
        return `${pre}@@OPENCHAT_MATH_TOKEN_${idx}@@${post}`;
      } catch {
        return full;
      }
    });

    // Restore protected code blocks before marked runs
    text = text.replace(/@@OPENCHAT_CODE_BLOCK_(\d+)@@/g, (_, i) => codeBlocks[parseInt(i, 10)]);
    text = text.replace(/@@OPENCHAT_INLINE_CODE_(\d+)@@/g, (_, i) => inlineCodes[parseInt(i, 10)]);

    const renderer = new Renderer();

    // 3. Clickable Links with automatic workspace subpath resolution
    renderer.link = ({ href, title, text: linkText }: any) => {
      let resolvedHref = href;
      if (
        !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("#") &&
        !href.startsWith("/")
      ) {
        if (currentSessionId) {
          const safePath = href.split("/").map((part: string) => encodeURIComponent(part)).join("/");
          resolvedHref = `/api/sessions/${currentSessionId}/files/${safePath}`;
        }
      }

      const titleAttr = title ? ` title="${escapeAttr(String(title))}"` : "";
      return `<a href="${escapeAttr(resolvedHref)}" target="_blank" rel="noopener noreferrer"${titleAttr} class="text-zinc-900 dark:text-zinc-100 font-medium underline underline-offset-4 decoration-zinc-400 dark:decoration-zinc-500 hover:decoration-zinc-900 dark:hover:decoration-zinc-100 transition-colors break-all cursor-pointer">${linkText}</a>`;
    };

    // 3.1. Inline Image renderer for charts and diagrams
    renderer.image = ({ href, title, text: imgText }: any) => {
      let resolvedHref = href;
      if (
        !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("data:") &&
        !href.startsWith("/")
      ) {
        if (currentSessionId) {
          const safePath = href.split("/").map((part: string) => encodeURIComponent(part)).join("/");
          resolvedHref = `/api/sessions/${currentSessionId}/files/${safePath}`;
        }
      }
      const titleAttr = title ? ` title="${escapeAttr(String(title))}"` : "";
      const altAttr = imgText ? ` alt="${escapeAttr(String(imgText))}"` : ' alt="image"';
      return `<div class="my-3"><a href="${escapeAttr(resolvedHref)}" target="_blank" rel="noreferrer" class="block group"><img src="${escapeAttr(resolvedHref)}"${altAttr}${titleAttr} class="max-h-96 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm hover:opacity-95 transition-opacity" loading="lazy" /></a></div>`;
    };

    // 4. Syntax-highlighted code blocks with Copy & Open Artifact buttons
    renderer.code = (token: any) => {
      const textVal = token.text || "";
      const lang = token.lang || "plaintext";
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      let highlighted = "";
      try {
        highlighted = hljs.highlight(textVal, { language }).value;
      } catch {
        highlighted = escapeHtml(textVal);
      }

      const encodedCode = encodeURIComponent(textVal);
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

    let rawHtml = marked.parse(text, { renderer, gfm: true, breaks: true }) as string;

    // Restore rendered math tokens into the HTML without marked mangle
    rawHtml = rawHtml.replace(/@@OPENCHAT_MATH_TOKEN_(\d+)@@/g, (_, i) => mathTokens[parseInt(i, 10)] || "");

    // Final gate: strip scripts/event handlers/javascript: URLs
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

