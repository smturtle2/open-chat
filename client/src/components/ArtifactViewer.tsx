import React, { useState, lazy, Suspense } from "react";
import { X, Copy, Download, Code, Eye, Check, Sparkles } from "lucide-react";
import DOMPurify from "dompurify";
import { useChatStore } from "../store/useChatStore";
import { MarkdownView } from "./MarkdownView";
import { copyText } from "../clipboard";

const ReactPreview = lazy(() => import('./ReactPreview'));
const MermaidPreview = lazy(() => import('./MermaidPreview'));

export const ArtifactViewer: React.FC = () => {
  const activeArtifact = useChatStore(st => st.activeArtifact);
  const closeArtifact = useChatStore(st => st.closeArtifact);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  if (!activeArtifact) return null;

  const handleCopy = async () => {
    const ok = await copyText(activeArtifact.content);
    setCopied(ok); setCopyError(!ok);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    let extension = ".txt";
    if (activeArtifact.type === "html") extension = ".html";
    else if (activeArtifact.type === "svg") extension = ".svg";
    else if (activeArtifact.type === "markdown") extension = ".md";
    else if (activeArtifact.type === "react") extension = ".tsx";
    else if (activeArtifact.type === "mermaid") extension = ".mmd";
    else if (activeArtifact.language) extension = `.${activeArtifact.language}`;

    const filename = activeArtifact.title
      ? (activeArtifact.title.includes(".") ? activeArtifact.title : `${activeArtifact.title}${extension}`)
      : `artifact${extension}`;

    const blob = new Blob([activeArtifact.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isPreviewable = ["html", "svg", "markdown", "mermaid", "react"].includes(activeArtifact.type);

  return (
    <div data-artifact-viewer className="h-full w-full min-w-0 flex flex-col bg-[var(--surface)] overflow-hidden">
      {/* Header Toolbar */}
      <div className="h-16 px-3 sm:px-4 flex items-center gap-2 shrink-0 border-b border-[var(--border)] pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <Sparkles className="size-4 text-indigo-500 dark:text-indigo-300 shrink-0" />
          <span className="font-semibold text-sm truncate">
            {activeArtifact.title || "미리보기"}
          </span>
          <span className="text-[11px] font-mono uppercase px-1.5 py-0.5 rounded-md bg-[var(--surface-soft)] text-muted font-medium shrink-0 hidden sm:inline">
            {activeArtifact.type}
          </span>
        </div>

        <button onClick={handleDownload} className="ui-icon-button shrink-0" title="파일 다운로드" aria-label="파일 다운로드"><Download className="size-4" /></button>
        <button onClick={closeArtifact} className="ui-icon-button shrink-0" title="닫기" aria-label="미리보기 닫기"><X className="size-5" /></button>
      </div>

        <div className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 border-b border-[var(--border)] shrink-0 bg-[var(--page)]">
          {/* Preview / Code mode toggle */}
          {isPreviewable && (
            <div className="flex rounded-xl bg-[var(--surface-soft)] p-1" role="group" aria-label="미리보기 표시 방식">
              <button
                onClick={() => setViewMode("preview")}
                aria-pressed={viewMode === "preview"}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                  viewMode === "preview"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-xs"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                }`}
                title="미리보기"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>미리보기</span>
              </button>
              <button
                onClick={() => setViewMode("code")}
                aria-pressed={viewMode === "code"}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                  viewMode === "code"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-xs"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                }`}
                title="코드 보기"
              >
                <Code className="w-3.5 h-3.5" />
                <span>코드</span>
              </button>
            </div>
          )}

          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-2 rounded-lg text-xs text-muted hover:bg-[var(--surface-soft)] cursor-pointer shrink-0"
            title="코드 복사"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
      {copyError && <p role="status" className="px-4 py-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30">복사 권한을 확인하거나 코드 탭에서 내용을 직접 선택해 주세요.</p>}

      {/* Artifact Render Container */}
      <div className="flex-1 min-h-0 min-w-0 relative overflow-auto bg-[var(--page)]">
        {viewMode === "preview" && isPreviewable ? (
          activeArtifact.type === "markdown" ? (
            <div className="p-6 max-w-3xl mx-auto">
              <MarkdownView content={activeArtifact.content} />
            </div>
          ) : activeArtifact.type === "svg" ? (
            <div
              className="w-full h-full flex items-center justify-center p-6 bg-zinc-100 dark:bg-zinc-900/60 overflow-auto"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(activeArtifact.content, { USE_PROFILES: { svg: true, svgFilters: true } }),
              }}
            />
          ) : activeArtifact.type === "mermaid" ? (
            <Suspense fallback={<div className="p-5">다이어그램을 그리는 중…</div>}><MermaidPreview content={activeArtifact.content} /></Suspense>
          ) : activeArtifact.type === "react" ? (
            <Suspense fallback={<div className="p-5">미리보기를 준비하는 중…</div>}><ReactPreview content={activeArtifact.content} /></Suspense>
          ) : (
            <iframe
              srcDoc={activeArtifact.content}
              sandbox="allow-scripts allow-modals"
              className="w-full h-full border-0 bg-white"
              title="Live Artifact Preview"
            />
          )
        ) : (
          <div className="p-4">
            <pre className="p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[13px] font-mono leading-6 overflow-x-auto whitespace-pre selection:bg-zinc-200 dark:selection:bg-zinc-700">
              {activeArtifact.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
