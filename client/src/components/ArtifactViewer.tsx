import React, { useState } from "react";
import { X, Copy, Download, Code, Eye, ExternalLink, Check, Sparkles } from "lucide-react";
import { useChatStore } from "../store/useChatStore";
import { MarkdownView } from "./MarkdownView";

export const ArtifactViewer: React.FC = () => {
  const { activeArtifact, closeArtifact } = useChatStore();
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [copied, setCopied] = useState(false);

  if (!activeArtifact) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(activeArtifact.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    let extension = ".txt";
    if (activeArtifact.type === "html") extension = ".html";
    else if (activeArtifact.type === "svg") extension = ".svg";
    else if (activeArtifact.type === "markdown") extension = ".md";
    else if (activeArtifact.type === "react") extension = ".tsx";
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

  const handleOpenNewTab = () => {
    if (activeArtifact.type === "html" || activeArtifact.type === "svg") {
      const blob = new Blob([activeArtifact.content], {
        type: activeArtifact.type === "html" ? "text/html" : "image/svg+xml",
      });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    }
  };

  const isPreviewable = ["html", "svg", "markdown"].includes(activeArtifact.type);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#18181b] border-l border-zinc-200 dark:border-zinc-800 shadow-2xl z-20 overflow-hidden">
      {/* Header Toolbar */}
      <div className="h-12 px-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between flex-shrink-0 bg-zinc-50/70 dark:bg-zinc-900/70 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <Sparkles className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100 truncate">
            {activeArtifact.title || "Live Artifact"}
          </span>
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-medium">
            {activeArtifact.type}
          </span>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Preview / Code mode toggle */}
          {isPreviewable && (
            <div className="flex rounded-lg bg-zinc-200/80 dark:bg-zinc-800 p-0.5 mr-1">
              <button
                onClick={() => setViewMode("preview")}
                className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition-all cursor-pointer ${
                  viewMode === "preview"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-xs"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                }`}
                title="Interactive Preview"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>미리보기</span>
              </button>
              <button
                onClick={() => setViewMode("code")}
                className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition-all cursor-pointer ${
                  viewMode === "code"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-xs"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                }`}
                title="View Code"
              >
                <Code className="w-3.5 h-3.5" />
                <span>코드</span>
              </button>
            </div>
          )}

          {(activeArtifact.type === "html" || activeArtifact.type === "svg") && (
            <button
              onClick={handleOpenNewTab}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              title="새 탭에서 열기"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={handleCopy}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="코드 복사"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
          </button>

          <button
            onClick={handleDownload}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="파일 다운로드"
          >
            <Download className="w-4 h-4" />
          </button>

          <button
            onClick={closeArtifact}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer ml-1"
            title="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Artifact Render Container */}
      <div className="flex-1 min-h-0 relative overflow-auto bg-zinc-50 dark:bg-[#121212]">
        {viewMode === "preview" && isPreviewable ? (
          activeArtifact.type === "markdown" ? (
            <div className="p-6 max-w-3xl mx-auto">
              <MarkdownView content={activeArtifact.content} />
            </div>
          ) : activeArtifact.type === "svg" ? (
            <div
              className="w-full h-full flex items-center justify-center p-6 bg-zinc-100 dark:bg-zinc-900/60 overflow-auto"
              dangerouslySetInnerHTML={{ __html: activeArtifact.content }}
            />
          ) : (
            <iframe
              srcDoc={activeArtifact.content}
              sandbox="allow-scripts allow-modals allow-same-origin"
              className="w-full h-full border-0 bg-white"
              title="Live Artifact Preview"
            />
          )
        ) : (
          <div className="p-4">
            <pre className="p-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs font-mono text-zinc-800 dark:text-zinc-200 leading-relaxed overflow-x-auto whitespace-pre-wrap selection:bg-zinc-200 dark:selection:bg-zinc-700">
              {activeArtifact.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
