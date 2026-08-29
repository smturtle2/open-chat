import React, { useEffect, useRef, useState } from "react";
import { MoreVertical, Pencil, Trash2, Download } from "lucide-react";
import { useChatStore } from "../store/useChatStore";

/** Top-right kebab menu for the active session: rename + export + delete. */
export const SessionMenu: React.FC = () => {
  const { sessions, currentSessionId, renameSession, deleteSession, messages } = useChatStore();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.id === currentSessionId);

  useEffect(() => {
    setOpen(false);
  }, [currentSessionId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!session) return null;

  const save = () => {
    if (title.trim() && title.trim() !== session.title) {
      renameSession(session.id, title.trim());
    }
    setRenaming(false);
  };

  const exportMarkdown = () => {
    let md = `# ${session.title}\n*Exported from OpenChat on ${new Date().toLocaleString()}*\n\n---\n\n`;
    for (const m of messages) {
      if (m.role === "user") {
        md += `### 👤 User\n\n${m.content}\n\n`;
      } else if (m.role === "assistant") {
        if (m.thought) {
          md += `> **Thinking**:\n> ${m.thought.replace(/\n/g, "\n> ")}\n\n`;
        }
        md += `### 🤖 OpenChat\n\n${m.content}\n\n`;
      }
    }
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.title.replace(/[^a-zA-Z0-9가-힣_-]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          data-session-menu-trigger
          title="세션 메뉴"
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {open && (
          <div
            data-session-menu
            className="absolute right-0 top-full mt-1.5 w-40 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-[#1a1a1c] shadow-lg shadow-black/5 py-1 z-50"
          >
            <button
              onClick={() => {
                setTitle(session.title);
                setRenaming(true);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5 text-zinc-400" />
              이름 변경
            </button>
            <button
              onClick={exportMarkdown}
              className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-zinc-400" />
              대화 내보내기 (.md)
            </button>
            <button
              onClick={() => {
                setOpen(false);
                deleteSession(session.id);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors cursor-pointer border-t border-zinc-100 dark:border-zinc-800/60 mt-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              삭제
            </button>
          </div>
        )}
      </div>

      {renaming && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/30"
          onClick={() => setRenaming(false)}
        >
          <div
            data-rename-dialog
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-[#18181b] p-5 shadow-xl"
          >
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 pb-3">세션 이름 변경</h2>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setRenaming(false);
              }}
              onFocus={(e) => e.target.select()}
              spellCheck={false}
              className="w-full bg-zinc-50 dark:bg-zinc-900 text-sm text-zinc-800 dark:text-zinc-200 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 outline-none focus:border-zinc-400 dark:focus:border-zinc-500"
            />
            <div className="flex justify-end gap-2 pt-4">
              <button
                onClick={() => setRenaming(false)}
                className="px-4 py-2 rounded-xl text-sm text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                취소
              </button>
              <button
                onClick={save}
                disabled={!title.trim()}
                className="px-4 py-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium hover:opacity-85 transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
