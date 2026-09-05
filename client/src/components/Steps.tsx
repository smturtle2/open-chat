import React from "react";
import { Terminal, Globe, FileCode, Brain, Maximize2, Minimize2, Loader2 } from "lucide-react";

export type StepItem =
  | { kind: "think"; text: string }
  | { kind: "tool"; id: string; name: string; args: any; obs?: string; imageUrl?: string };

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
      const data = await res.json();
      setFull(typeof data.content === "string" ? data.content : "…unavailable");
    } catch {
      setFull("…failed to load");
    }
    setLoading(false);
  };

  return (
    <div key={isThink ? `think_${idx}` : `t_${item.id || idx}`} className="space-y-1 py-0.5">
      <div className="flex items-center justify-between font-mono">
        <div className="flex items-center gap-1.5 font-semibold text-zinc-900 dark:text-zinc-100">
          {isThink ? (
            <>
              <Brain className={`w-3.5 h-3.5 ${streaming ? "animate-pulse" : ""}`} />
              <span>think</span>
            </>
          ) : (
            <>
              {getToolIcon(item.name)}
              <span>{item.name}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {archiveId && (
            <button
              onClick={toggleFull}
              title={full !== null ? "Hide full output" : "Show full output"}
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer"
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
          {active && (
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse flex-shrink-0" />
          )}
        </div>
      </div>

      <pre
        className={`p-2 rounded bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 text-[11px] font-mono text-zinc-700 dark:text-zinc-300 overflow-x-auto whitespace-pre-wrap max-h-52 overflow-y-auto ${
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
          <img src={item.imageUrl} alt="view_image result" className="max-h-56 rounded-lg border border-zinc-800" />
        </a>
      )}

      {!isThink && item.obs && (
        <pre className="p-2.5 rounded bg-zinc-900 text-zinc-200 text-[11px] font-mono leading-relaxed overflow-x-auto max-h-52 border border-zinc-800 whitespace-pre-wrap">
          {item.obs}
        </pre>
      )}

      {!isThink && full !== null && (
        <pre className="p-2.5 rounded bg-zinc-950 text-zinc-300 text-[11px] font-mono leading-relaxed overflow-x-auto max-h-72 overflow-y-auto border border-zinc-800 whitespace-pre-wrap">
          {full}
        </pre>
      )}
    </div>
  );
};
