import React, { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Trash2, Download, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "../store/useChatStore";
import { BottomSheet } from "./BottomSheet";

export const SessionMenu: React.FC = () => {
  const { sessions, currentSessionId, renameSession, deleteSession, messages } = useChatStore(useShallow(st => ({
    sessions: st.sessions, currentSessionId: st.currentSessionId, renameSession: st.renameSession,
    deleteSession: st.deleteSession, messages: st.messages,
  })));
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const session = sessions.find(s => s.id === currentSessionId);

  useEffect(() => { setOpen(false); setAction(null); setError(null); }, [currentSessionId]);
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const pointer = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
      if (e.key === "Tab") setOpen(false);
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", key); };
  }, [open]);

  if (!session) return null;
  const close = () => { if (!saving) setAction(null); };
  const confirm = async () => {
    if (saving || !action || (action === "rename" && !title.trim())) return;
    setSaving(true); setError(null);
    const ok = action === "rename" ? await renameSession(session.id, title.trim()) : await deleteSession(session.id);
    setSaving(false);
    if (ok) setAction(null);
    else setError(useChatStore.getState().lastError || "저장하지 못했습니다. 다시 시도해 주세요.");
  };
  const exportMarkdown = () => {
    let markdown = `# ${session.title}\n\n`;
    for (const message of messages) {
      if (message.role === "user") markdown += `## 사용자\n\n${message.content}\n\n`;
      if (message.role === "assistant") {
        if (message.thought) markdown += `> **생각 정리**\n> ${message.thought.replace(/\n/g, "\n> ")}\n\n`;
        markdown += `## OpenChat\n\n${message.content}\n\n`;
      }
    }
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${session.title.replace(/[^a-zA-Z0-9가-힣_-]/g, "_")}.md`; link.click();
    URL.revokeObjectURL(url); setOpen(false); triggerRef.current?.focus();
  };
  const menuItem = "flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left hover:bg-[var(--surface-soft)] cursor-pointer";

  return <>
    <div ref={rootRef} className="relative">
      <button ref={triggerRef} className="ui-icon-button" data-session-menu-trigger title="대화 메뉴" aria-label="대화 메뉴" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><MoreHorizontal className="size-5" /></button>
      {open && <div data-session-menu role="menu" aria-label="대화 관리" className="absolute right-0 top-full mt-2 w-52 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl shadow-black/10 z-50">
        <button role="menuitem" tabIndex={-1} className={menuItem} onClick={() => { setTitle(session.title); setError(null); setAction("rename"); setOpen(false); }}><Pencil className="size-4 text-muted" />이름 변경</button>
        <button role="menuitem" tabIndex={-1} className={menuItem} onClick={exportMarkdown}><Download className="size-4 text-muted" />대화 내보내기</button>
        <div className="border-t border-[var(--border)] my-1" />
        <button role="menuitem" tabIndex={-1} className={menuItem + " text-rose-600 dark:text-rose-400"} onClick={() => { setAction("delete"); setError(null); setOpen(false); }}><Trash2 className="size-4" />삭제</button>
      </div>}
    </div>
    {action && <BottomSheet title={action === "rename" ? "대화 이름 변경" : "대화 삭제"} compact onClose={close} returnFocus={triggerRef.current} footer={<div className="flex justify-end gap-2"><button className="ui-button" disabled={saving} onClick={close}>취소</button><button className={`ui-button ${action === "delete" ? "ui-button-danger" : "ui-button-primary"}`} disabled={saving || (action === "rename" && !title.trim())} onClick={confirm}>{saving && <Loader2 className="size-4 animate-spin" />}{saving ? "처리 중…" : action === "delete" ? "삭제" : "저장"}</button></div>}>
      <div data-rename-dialog={action === "rename" || undefined} className="px-6 pb-5">
        {action === "rename" ? <><label htmlFor="conversation-title" className="block text-sm font-medium mb-2">이름</label><input id="conversation-title" data-autofocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); confirm(); } }} onFocus={e => e.target.select()} className="ui-field" disabled={saving} /></> : <p className="text-sm leading-6 text-muted"><strong className="text-[var(--ink)] break-words">{session.title}</strong> 대화와 작업 폴더를 삭제합니다. 삭제한 내용은 되돌릴 수 없습니다.</p>}
        {error && <p role="alert" className="mt-4 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
    </BottomSheet>}
  </>;
};
