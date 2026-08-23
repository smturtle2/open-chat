import React, { useMemo } from "react";
import { marked, Renderer } from "marked";
import hljs from "highlight.js";
import katex from "katex";
import { useChatStore } from "../store/useChatStore";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";

interface MarkdownViewProps {
  content: string;
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content }) => {
  const { currentSessionId } = useChatStore();

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

      const titleAttr = title ? ` title="${title}"` : "";
      return `<a href="${resolvedHref}" target="_blank" rel="noopener noreferrer"${titleAttr} class="text-zinc-900 dark:text-zinc-100 font-medium underline underline-offset-4 decoration-zinc-400 dark:decoration-zinc-500 hover:decoration-zinc-900 dark:hover:decoration-zinc-100 transition-colors break-all cursor-pointer">${text}</a>`;
    };

    // 3. Syntax-highlighted code blocks with Copy button
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

      return `
        <div class="code-container my-2.5 rounded-lg overflow-hidden border border-zinc-800 bg-[#18181b] font-mono text-[13px]">
          <div class="flex items-center justify-between px-3 py-1.5 bg-[#202023] text-zinc-400 text-xs select-none">
            <span class="font-medium text-[11px] text-zinc-300">${language}</span>
            <button
              class="copy-code-btn px-1.5 py-0.5 rounded text-[11px] hover:text-white hover:bg-zinc-700 transition-colors cursor-pointer"
              data-code="${encodedCode}"
              onclick="
                navigator.clipboard.writeText(decodeURIComponent(this.getAttribute('data-code')));
                this.innerText = 'Copied!';
                setTimeout(() => { this.innerText = 'Copy'; }, 2000);
              "
            >
              <span>Copy</span>
            </button>
          </div>
          <pre class="p-3 overflow-x-auto leading-relaxed text-zinc-200"><code class="hljs language-${language}">${highlighted}</code></pre>
        </div>
      `;
    };

    return marked.parse(processed, { renderer, gfm: true, breaks: true }) as string;
  }, [content, currentSessionId]);

  return (
    <div
      className="markdown-content text-sm leading-relaxed text-zinc-900 dark:text-zinc-100 space-y-2"
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
};
