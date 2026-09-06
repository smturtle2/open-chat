import React, { useEffect, useRef, useState } from "react";
import { Bot, MessageCircle, PanelLeftClose, Plus, Trash2, Edit3, Settings, X, Search, SquarePen, Sparkles, ChevronRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore, type Session } from "../store/useChatStore";
import { BottomSheet } from "./BottomSheet";
import { SettingsSheet } from "./SettingsSheet";

const W = 272; // drawer width (px)
const SLOP = 10; // px before the axis locks (vaul-style)
const REVEAL_X = 64; // exposed action strip width
const PANEL_EASE = "translate 180ms cubic-bezier(0.32, 0.72, 0.3, 1)";
const ROW_EASE = "transform 180ms ease";
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const Sidebar: React.FC = () => {
  const {
    sessions,
    currentSessionId,
    sidebarOpen,
    setSidebarOpen,
    createSession,
    selectSession,
    deleteSession,
    renameSession,
  } = useChatStore(useShallow(st => ({
    sessions: st.sessions, currentSessionId: st.currentSessionId, sidebarOpen: st.sidebarOpen,
    setSidebarOpen: st.setSidebarOpen, createSession: st.createSession, selectSession: st.selectSession,
    deleteSession: st.deleteSession, renameSession: st.renameSession,
  })));

  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [revealId, setRevealId] = useState<string | null>(null);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const asideRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);

  // Mirrors for the document-level recognizer, which binds once and never
  // re-registers — it reads these instead of closing over stale props.
  const openRef = useRef(sidebarOpen);
  openRef.current = sidebarOpen;
  const revealRef = useRef(revealId);
  revealRef.current = revealId;

  useEffect(() => {
    if (!sidebarOpen) setRevealId(null);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen || window.innerWidth >= 768) return;
    const previous = document.activeElement as HTMLElement | null;
    asideRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") { e.preventDefault(); setSidebarOpen(false); }
      if (e.key !== "Tab") return;
      const controls = Array.from(asideRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') || []).filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [sidebarOpen, setSidebarOpen]);

  // ------------------------------------------------------------------
  // Gesture recognizer, modeled on vaul's pointer-drag implementation:
  //   · single document-level recognizer; regions decided by coordinates,
  //     never by hit-blocking overlay divs
  //   · zero React state while dragging — DOM nodes are painted directly
  //     (translate / transform / opacity), coalesced through rAF
  //   · release commits by distance-fraction OR recent-window flick
  //     velocity, then settles with restored CSS transitions
  //   · eligibility rules: touch-only opening over selectable chat text,
  //     active text selections abort, inputs/code blocks are no-drag
  // ------------------------------------------------------------------
  useEffect(() => {
    type Mode = "none" | "open" | "close" | "reveal";
    interface G {
      id: number;
      touch: boolean;
      x0: number; y0: number;
      axis: "?" | "x" | "y";
      mode: Mode;
      row: string | null;
      val: number;
      samples: { t: number; x: number }[];
    }
    let g: G | null = null;
    let raf = 0;
    let pending: { x: number; y: number } | null = null;
    let lpTimer: ReturnType<typeof setTimeout> | undefined;
    let settleToken = 0;

    const rowContent = (id: string) =>
      document.querySelector(`[data-row="${id}"] [data-row-content]`) as HTMLElement | null;

    const paintPanel = (x: number) => {
      const el = asideRef.current;
      if (el) {
        el.style.transitionDuration = "0ms";
        el.style.translate = `${x}px 0`;
      }
      const bd = backdropRef.current;
      if (bd) bd.style.opacity = String(clamp(1 + x / W, 0, 1));
    };
    const paintRow = (id: string, x: number) => {
      const el = rowContent(id);
      if (el) {
        el.style.transitionDuration = "0ms";
        el.style.transform = `translateX(${x}px)`;
      }
    };

    /** Restore transitions, paint the committed position; once the settle
     *  animation is done, clear inline styles so declarative ones govern. */
    const settle = (fn: () => void) => {
      const token = ++settleToken;
      fn();
      setTimeout(() => {
        if (token !== settleToken) return;
        if (asideRef.current) {
          asideRef.current.style.transitionDuration = "";
          asideRef.current.style.translate = "";
        }
        if (backdropRef.current) backdropRef.current.style.opacity = "";
        document.querySelectorAll<HTMLElement>("[data-row-content]").forEach((n) => {
          n.style.transitionDuration = "";
        });
      }, 210);
    };

    const velocity = (s: { t: number; x: number }[]) => {
      if (s.length < 2) return 0;
      const last = s[s.length - 1];
      let first = s[0];
      for (let i = s.length - 1; i >= 0; i--) {
        if (last.t - s[i].t <= 120) first = s[i]; // recent window only (iOS-style)
        else break;
      }
      const dt = last.t - first.t;
      return dt > 0 ? (last.x - first.x) / dt : 0;
    };

    const noDragTarget = (t: EventTarget | null) =>
      !!(t as HTMLElement | null)?.closest?.(
        "pre, code, input, textarea, select, table, .katex, [contenteditable], [data-no-drag], [data-artifact-viewer]"
      );

    const onDown = (e: PointerEvent) => {
      if (g) return;
      if (document.querySelector("dialog[open]")) return;
      if (useChatStore.getState().activeArtifact) return;
      clearTimeout(lpTimer);
      suppressClick.current = false;

      const target = e.target as HTMLElement;
      // Opening lives over fully-selectable chat content: touch pointers
      // Restrict all gesture interception to touch pointers
      if (e.pointerType !== "touch") return;
      // vaul rule: never steal a gesture while text is selected.
      if (window.getSelection()?.toString()) return;
      if (noDragTarget(target)) return;

      const rowEl = target.closest?.("[data-row]") as HTMLElement | null;
      g = {
        id: e.pointerId,
        touch: true,
        x0: e.clientX,
        y0: e.clientY,
        axis: "?",
        mode: "none",
        row: rowEl?.getAttribute("data-row") ?? null,
        val: 0,
        samples: [{ t: performance.now(), x: e.clientX }],
      };

      // Long-press exposes a row's actions (~500ms with 10px tolerance) on touch only.
      if (openRef.current && g.row) {
        const id = g.row;
        lpTimer = setTimeout(() => {
          if (g && g.axis === "?" && g.row === id) {
            suppressClick.current = true;
            setRevealId(id);
          }
        }, 480);
      }
    };

    const step = () => {
      raf = 0;
      if (!g || !pending) return;
      const { x, y } = pending;
      const dx = x - g.x0;
      const dy = y - g.y0;

      if (g.axis === "?") {
        if (Math.hypot(dx, dy) < SLOP) return;
        clearTimeout(lpTimer);
        if (Math.abs(dy) >= Math.abs(dx)) {
          g.axis = "y"; // vertical → native scrolling owns this gesture
          return;
        }
        g.axis = "x";
        suppressClick.current = true; // a locked horizontal drag is never a tap
        if (!openRef.current) {
          // Open zone: rightward drag starting in the outer left edge (<= 28px).
          g.mode = dx > 0 && g.touch && g.x0 <= 28 ? "open" : "none";
        } else if (g.row) {
          g.mode = "reveal"; // left exposes actions, right collapses them
        } else if (dx < 0) {
          g.mode = "close"; // header, footer, list gaps, backdrop, chat side
        } else {
          g.mode = "none";
        }
        if (g.mode === "none") return;
      }

      if (g.mode === "open") {
        g.val = clamp(dx - W, -W, 0);
        paintPanel(g.val);
      } else if (g.mode === "close") {
        g.val = clamp(dx, -W, 0);
        paintPanel(g.val);
      } else if (g.mode === "reveal" && g.row) {
        g.val = clamp((revealRef.current === g.row ? -REVEAL_X : 0) + dx, -REVEAL_X - 8, 8);
        paintRow(g.row, g.val);
      }

      g.samples.push({ t: performance.now(), x });
      while (g.samples.length > 2 && g.samples[g.samples.length - 1].t - g.samples[0].t > 120) {
        g.samples.shift();
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(step);
    };

    const finish = (e: PointerEvent, cancelled = false) => {
      if (!g || e.pointerId !== g.id) return;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
      clearTimeout(lpTimer);
      const s = g;
      g = null;
      if (s.axis !== "x" || s.mode === "none") return;
      const vx = velocity(s.samples);

      if (s.mode === "open") {
        // A browser-cancelled gesture never commits — it settles back.
        const commit = !cancelled && (s.val > -W * 0.72 || vx > 0.35);
        if (commit) {
          setSidebarOpen(true);
          settle(() => {
            const el = asideRef.current;
            if (el) { el.style.transitionDuration = ""; el.style.translate = "0px 0"; }
            if (backdropRef.current) backdropRef.current.style.opacity = "";
          });
        } else {
          settle(() => {
            const el = asideRef.current;
            if (el) { el.style.transitionDuration = ""; el.style.translate = `${-W}px 0`; }
            if (backdropRef.current) backdropRef.current.style.opacity = "0";
          });
        }
      } else if (s.mode === "close") {
        const commit = !cancelled && (s.val < -W * 0.28 || vx < -0.35);
        if (commit) {
          setSidebarOpen(false);
          setRevealId(null);
          settle(() => {
            const el = asideRef.current;
            if (el) { el.style.transitionDuration = ""; el.style.translate = `${-W}px 0`; }
            if (backdropRef.current) backdropRef.current.style.opacity = "0";
          });
        } else {
          settle(() => {
            const el = asideRef.current;
            if (el) { el.style.transitionDuration = ""; el.style.translate = "0px 0"; }
            if (backdropRef.current) backdropRef.current.style.opacity = "";
          });
        }
      } else if (s.mode === "reveal" && s.row) {
        const commit = !cancelled && (s.val < -REVEAL_X / 2 || vx < -0.25);
        setRevealId(commit ? s.row : null);
        const el = rowContent(s.row);
        if (el) {
          el.style.transitionDuration = "";
          el.style.transform = `translateX(${commit ? -REVEAL_X : 0}px)`;
        }
      }
    };

    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointermove", onMove, { capture: true } as any);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel, true);
    };
  }, []);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleStartRename = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const handleSaveRename = async (id: string, e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    if (editingTitle.trim()) {
      if (!await renameSession(id, editingTitle.trim())) return;
    }
    setEditingId(null);
    setRevealId(null);
  };

  const handleConfirmDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await deleteSession(id)) return;
    setDeletingId(null);
    setRevealId(null);
  };

  const renderRow = (s: Session, icon?: React.ReactNode) => {
    const isSelected = s.id === currentSessionId;
    const isEditing = editingId === s.id;
    const isDeleting = deletingId === s.id;
    const revealed = revealId === s.id;

    return (
      <div key={s.id} data-row={s.id} className="relative rounded-xl overflow-hidden group">
        {/* Action layer underneath */}
        <div
          className={`session-actions absolute z-10 inset-y-0 right-0 flex items-center gap-0.5 pl-1 pr-1 rounded-xl bg-[var(--surface-soft)] ${revealed ? "opacity-100" : "opacity-0 pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:group-focus-within:opacity-100 md:group-focus-within:pointer-events-auto"}`}
        >
          {!isEditing && !isDeleting && (
            <>
              <button
                onClick={(e) => handleStartRename(s.id, s.title, e)}
                className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
                title="이름 변경"
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingId(s.id);
                }}
                className="p-1.5 text-zinc-400 hover:text-rose-500 cursor-pointer"
                title="삭제"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>

        {/* Sliding row content */}
        <div
          data-row-content
          role={!isEditing && !isDeleting ? "button" : undefined}
          tabIndex={!isEditing && !isDeleting ? 0 : undefined}
          aria-current={isSelected ? "page" : undefined}
          onKeyDown={(e) => { if (!isEditing && !isDeleting && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectSession(s.id); if (window.innerWidth < 768) setSidebarOpen(false); } }}
          onClick={() => {
            if (suppressClick.current) return;
            selectSession(s.id);
            setRevealId(null);
            if (window.innerWidth < 768) setSidebarOpen(false);
          }}
          style={{
            transition: ROW_EASE,
            transform: `translateX(${revealed ? -REVEAL_X : 0}px)`,
          }}
          className={`relative flex items-center justify-between px-3 py-3 rounded-xl text-[13px] cursor-pointer select-none min-h-11 ${
            isSelected
              ? "bg-[var(--accent-soft)] text-indigo-800 dark:text-indigo-100 font-medium"
              : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
          }`}
        >
          <div className="truncate flex-1 mr-1 flex items-center gap-1.5">
            {icon}
            {isEditing ? (
              <input
                type="text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => handleSaveRename(s.id, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveRename(s.id, e);
                  if (e.key === "Escape") setEditingId(null);
                }}
                autoFocus
                className="w-full bg-white dark:bg-zinc-900 border border-zinc-400 rounded px-1.5 py-0.5 text-xs outline-none"
              />
            ) : isDeleting ? (
              <div className="flex items-center justify-between w-full" onClick={(e) => e.stopPropagation()}>
                <span className="text-xs text-rose-500 font-medium truncate">삭제할까요?</span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={(e) => handleConfirmDelete(s.id, e)}
                    className="px-2 py-0.5 rounded bg-rose-500 text-white text-[11px] font-medium hover:bg-rose-600 cursor-pointer"
                  >
                    삭제
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingId(null);
                    }}
                    className="px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-[11px] hover:bg-zinc-300 dark:hover:bg-zinc-600 cursor-pointer"
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <><span className="truncate">{s.title === "New Chat" ? "새 대화" : s.title === "New Agent" ? "새 에이전트" : s.title}</span>
                {s.status === "running" && <span className="size-1.5 rounded-full bg-indigo-500 animate-pulse shrink-0" aria-label="응답 중" />}
                {s.workspace_state === "archived" && <span className="text-[10px] text-zinc-400 shrink-0" title="접근하면 보관된 작업폴더를 복원합니다.">보관됨</span>}
                {s.workspace_state === "missing" && <span className="text-[10px] text-zinc-400 shrink-0" title="작업폴더가 없습니다. 대화 기록은 남아 있습니다.">폴더 없음</span>}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const sectionHeader = (label: string, count: number, onCreate: () => void) => (
    <div className="flex items-center justify-between pl-3 pr-1 pt-4 pb-1.5">
      <span className="text-xs font-medium text-muted flex items-center gap-1.5">
        {label}
        {count > 0 && <span className="font-mono font-normal text-zinc-300 dark:text-zinc-600">{count}</span>}
      </span>
      <button
        onClick={onCreate}
        title={`${label} 새로 만들기`}
        className="ui-icon-button size-8!"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  const filteredSessions = sessions.filter(
    (s) =>
      (s.title?.toLowerCase() ?? "").includes(searchQuery.toLowerCase()) ||
      (s.workdir && s.workdir.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const agentSessions = filteredSessions.filter((s) => s.mode === "agent");
  const chatSessions = filteredSessions.filter((s) => s.mode !== "agent");

  return (
    <>
      {/* Backdrop — always mounted on mobile so the recognizer can fade it
          in imperatively while the drawer is being dragged open. */}
      <div
        ref={backdropRef}
        onClick={() => sidebarOpen && setSidebarOpen(false)}
        style={{ touchAction: "none" }}
        className={`fixed inset-0 bg-black/30 z-30 md:hidden transition-opacity duration-150 ${
          sidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      <aside
        ref={asideRef}
        inert={!sidebarOpen}
        aria-label="대화 목록"
        style={{ transition: PANEL_EASE, touchAction: "pan-y" }}
        className={`fixed md:static inset-y-0 left-0 z-40 w-[272px] shrink-0 bg-[#f5f6f9] dark:bg-[#15181f] border-r border-[var(--border)] flex flex-col ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:-translate-x-full md:w-0 md:border-none overflow-hidden"
        }`}
      >
        {/* Top Header */}
        <div className="px-4 pt-3 pb-1 flex-shrink-0">
          <div className="flex items-center justify-between h-10 mb-4">
            <span className="font-semibold text-[17px] tracking-tight flex items-center gap-2.5"><span className="size-8 rounded-xl bg-indigo-600 dark:bg-indigo-400 text-white dark:text-slate-950 flex items-center justify-center"><Sparkles className="size-4" /></span>OpenChat</span>
            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="사이드바 닫기"
              className="ui-icon-button"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </div>
          <button className="ui-button ui-button-primary w-full justify-start!" onClick={() => createSession("chat")}><SquarePen className="size-4" />새 대화</button>

          {/* Search Box */}
          <div className="pt-3">
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-muted">
              <Search className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
              <input
                type="text"
                placeholder="대화 검색"
                aria-label="대화 검색"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent outline-none text-[13px] placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  aria-label="검색 지우기"
                  className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Session lists — agent section first, chat below */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 space-y-1 pb-4" style={{ touchAction: "pan-y" }}>
          {sectionHeader("에이전트", agentSessions.length, () => setAgentDialogOpen(true))}
          {agentSessions.map((s) => renderRow(s, <Bot className="w-3.5 h-3.5 flex-shrink-0 text-violet-500 dark:text-violet-400" />))}

          {sectionHeader("채팅", chatSessions.length, () => createSession("chat"))}
          {chatSessions.map((s) => renderRow(s, <MessageCircle className="w-3.5 h-3.5 flex-shrink-0 text-zinc-300 dark:text-zinc-600" />))}
          {searchQuery && !filteredSessions.length && <p className="px-3 py-8 text-sm text-muted text-center">일치하는 대화가 없습니다.</p>}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[var(--border)] shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={() => setSettingsOpen(true)}
            data-settings-trigger
            title="설정"
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-muted hover:bg-[var(--surface-soft)] cursor-pointer"
          >
            <Settings className="size-4" /><span className="flex-1 text-left">설정</span><ChevronRight className="size-4" />
          </button>
        </div>
      </aside>

      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}

      {/* New-agent working directory dialog */}
      {agentDialogOpen && (
        <NewAgentSheet
          onClose={() => setAgentDialogOpen(false)}
          onCreate={async (workdir) => {
            const id = await createSession("agent", workdir);
            if (id) {
              setAgentDialogOpen(false);
              if (window.innerWidth < 768) setSidebarOpen(false);
            }
            return !!id;
          }}
        />
      )}
    </>
  );
};

// ------------------------------------------------------------- new-agent sheet

interface ValidateResult {
  ok: boolean;
  real_path?: string;
  error?: string;
}

const NewAgentSheet: React.FC<{ onClose: () => void; onCreate: (workdir: string) => Promise<boolean> }> = ({ onClose, onCreate }) => {
  const [path, setPath] = useState("");
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = path.trim();
    if (!trimmed) {
      setValidation(null);
      setChecking(false);
      return;
    }
    const controller = new AbortController();
    setChecking(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/workdir/validate?path=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        setValidation(await res.json());
      } catch {
        if (!controller.signal.aborted) setValidation({ ok: false, error: "폴더를 확인하지 못했습니다." });
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      controller.abort();
    };
  }, [path]);

  const canCreate = validation?.ok && !checking && !creating;
  const create = async () => { if (!canCreate) return; setCreating(true); if (!await onCreate(validation!.real_path!)) setCreating(false); };
  const inputCls =
    "ui-field font-mono";

  return (
    <BottomSheet title="새 에이전트" compact onClose={onClose}>
      <div className="pb-5 px-5" data-new-agent-sheet>
        <p className="pb-4 text-sm leading-relaxed text-muted">
          선택한 폴더의 파일을 읽고 호스트에서 직접 명령을 실행합니다.
        </p>

        <label htmlFor="agent-workdir" className="block text-sm font-medium mb-2">프로젝트 폴더</label>
        <input
          id="agent-workdir"
          data-autofocus
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/home/user/my-project"
          spellCheck={false}
          autoComplete="off"
          className={`${inputCls} ${
            !validation || checking
              ? "border-zinc-200 dark:border-zinc-700"
              : validation.ok
                ? "border-emerald-500/60"
                : "border-rose-400/70"
          }`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCreate) {
              create();
            }
          }}
        />

        <div className="min-h-[18px] pt-1.5 text-[11px]">
          {checking && <span className="text-zinc-400">확인 중…</span>}
          {!checking && validation?.ok && (
            <span className="text-emerald-600 dark:text-emerald-400">✓ {validation.real_path}</span>
          )}
          {!checking && validation && !validation.ok && (
            <span className="text-rose-500">{validation.error}</span>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="ui-button"
          >
            취소
          </button>
          <button
            disabled={!canCreate}
            onClick={create}
            className="ui-button ui-button-primary"
          >
            {creating ? "생성 중…" : "에이전트 시작"}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
};
