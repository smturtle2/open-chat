import React from "react";
import type { Message } from "../store/useChatStore";
import { Terminal, Globe, FileCode, Brain, Maximize2, Minimize2, Loader2 } from "lucide-react";

export type StepItem =
  | { kind: "think"; text: string }
  | { kind: "tool"; id: string; name: string; args: any; obs?: string; imageUrl?: string; status?: Message["tool_status"] };

export type StepEntry = { item: StepItem; streaming?: boolean; running?: boolean };

export const getToolIcon = (name: string) => {
  switch (name) {
    case "bash":
    case "execute_bash":
    case "terminal":
    case "shell":
      return <Terminal className="w-3.5 h-3.5" />;
    case "web_search":
    case "web_fetch":
    case "web_crawl":
    case "crawl":
    case "spider":
    case "fetch_webpage":
    case "scrape_webpage":
    case "search":
      return <Globe className="w-3.5 h-3.5" />;
    default:
      return <FileCode className="w-3.5 h-3.5" />;
  }
};

export const StepListItem: React.FC<{ entry: StepEntry; idx: number; sessionId?: string }> = ({ entry, idx, sessionId }) => {
  const { item, streaming, running } = entry;
  const isThink = item.kind === "think";
  const active = Boolean(streaming || running);
  const status = !isThink ? item.status : undefined;
  const failed = status?.ok === false;

  // Fold view: truncated observations reference their archived full copy.
  const archiveId = !isThink && item.obs ? item.obs.match(/archived as output #(\d+)/)?.[1] : undefined;
  const [full, setFull] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const toggleFull = async () => {
    if (full !== null || !archiveId || !sessionId) {
      setFull(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/outputs/${archiveId}`);
      if (!res.ok) throw new Error("출력을 불러오지 못했습니다.");
      const data = await res.json();
      setFull(typeof data.content === "string" ? data.content : "출력이 없습니다.");
    } catch {
      setFull("출력을 불러오지 못했습니다. 다시 시도해 주세요.");
    }
    setLoading(false);
  };

  return (
    <div key={isThink ? `think_${idx}` : `t_${item.id || idx}`} className={`space-y-3 p-4 rounded-2xl border ${failed ? "border-amber-300 dark:border-amber-800" : "border-[var(--border)]"}`}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2 font-medium min-w-0">
          {isThink ? (
            <>
              <Brain className={`w-3.5 h-3.5 ${streaming ? "animate-pulse" : ""}`} />
              <span>생각 정리</span>
            </>
          ) : (
            <>
              {getToolIcon(item.name)}
              <span className="font-mono truncate">{item.name}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {archiveId && (
            <button
              onClick={toggleFull}
              title={full !== null ? "전체 출력 접기" : "전체 출력 보기"}
              className="ui-icon-button size-8!"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : full !== null ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          <span className={`px-2 py-0.5 rounded-md text-xs shrink-0 ${active ? "bg-[var(--accent-soft)] text-indigo-600 dark:text-indigo-300" : failed ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300" : "bg-[var(--surface-soft)] text-muted"}`}>{active ? "진행 중" : status?.interrupted ? "중단됨" : status?.timedOut ? "시간 초과" : failed ? `실패${status.exitCode !== undefined ? ` · ${status.exitCode}` : ""}` : "완료"}</span>
        </div>
      </div>

      <pre
        className={`p-3 rounded-xl bg-[var(--surface-soft)] text-xs leading-6 font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-60 overflow-y-auto ${
          isThink && streaming ? "border-dashed" : ""
        }`}
      >
        {isThink
          ? item.text
          : typeof item.args === "object"
            ? JSON.stringify(item.args, null, 2)
            : String(item.args)}
      </pre>

      {!isThink && item.imageUrl && (
        <a href={item.imageUrl} target="_blank" rel="noreferrer" className="block">
          <img src={item.imageUrl} alt="도구에서 확인한 이미지" className="max-h-56 rounded-lg border border-zinc-800" />
        </a>
      )}

      {!isThink && item.obs && (
        <pre className="p-3 rounded-xl bg-zinc-900 text-zinc-200 text-xs font-mono leading-6 overflow-auto max-h-60 border border-zinc-800 whitespace-pre-wrap break-words">
          {item.obs}
        </pre>
      )}

      {!isThink && full !== null && (
        <pre className="p-3 rounded-xl bg-zinc-950 text-zinc-300 text-xs font-mono leading-6 overflow-auto max-h-80 border border-zinc-800 whitespace-pre-wrap break-words">
          {full}
        </pre>
      )}
    </div>
  );
};
