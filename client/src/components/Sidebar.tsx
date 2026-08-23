import React, { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Edit3, Check, X, PanelLeftClose, Sun, Moon } from "lucide-react";
import { useChatStore } from "../store/useChatStore";

const W = 240; // drawer width (px)
const SLOP = 10; // px before the axis locks (vaul-style)
const REVEAL_X = 64; // exposed action strip width
const PANEL_EASE = "translate 180ms cubic-bezier(0.32, 0.72, 0.3, 1)";
const ROW_EASE = "transform 180ms ease";
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const Sidebar: React.FC = () => {
  const {
    theme,
    toggleTheme,
    sessions,
    currentSessionId,
    sidebarOpen,
    setSidebarOpen,
    createSession,
    selectSession,
    deleteSession,
    renameSession,
    selectedModel,
  } = useChatStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [revealId, setRevealId] = useState<string | null>(null);

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
        "pre, code, input, textarea, select, [contenteditable], [data-no-drag]"
      );

    const onDown = (e: PointerEvent) => {
      if (g) return;
      clearTimeout(lpTimer);
      suppressClick.current = false;

      const target = e.target as HTMLElement;
      // Opening lives over fully-selectable chat content: touch pointers
      // only, so mouse text-selection is never hijacked.
      if (!openRef.current && e.pointerType !== "touch") return;
      // vaul rule: never steal a gesture while text is selected.
      if (window.getSelection()?.toString()) return;
      if (noDragTarget(target)) return;

      const rowEl = target.closest?.("[data-row]") as HTMLElement | null;
      g = {
        id: e.pointerId,
        touch: e.pointerType === "touch",
        x0: e.clientX,
        y0: e.clientY,
        axis: "?",
        mode: "none",
        row: rowEl?.getAttribute("data-row") ?? null,
        val: 0,
        samples: [{ t: performance.now(), x: e.clientX }],
      };

      // Long-press exposes a row's actions (~500ms with 10px tolerance).
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
      pending = null;
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
          // Open zone: rightward drag starting in the left half of the screen.
          g.mode = dx > 0 && g.touch && g.x0 <= window.innerWidth * 0.5 ? "open" : "none";
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

  const handleStartRename = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const handleSaveRename = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (editingTitle.trim()) {
      renameSession(id, editingTitle.trim());
    }
    setEditingId(null);
    setRevealId(null);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteSession(id);
    setRevealId(null);
  };

  const shortModel = selectedModel.length > 24 ? selectedModel.slice(0, 24) + "…" : selectedModel;

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
        style={{ transition: PANEL_EASE, touchAction: "pan-y" }}
        className={`fixed md:static inset-y-0 left-0 z-40 w-[240px] bg-[#f9f9fb] dark:bg-[#141416] border-r border-zinc-200/70 dark:border-zinc-800 flex flex-col ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:-translate-x-full md:w-0 md:border-none"
        }`}
      >
        {/* Top Header */}
        <div className="p-3 space-y-2.5 flex-shrink-0">
          <div className="flex items-center justify-between px-1">
            <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 tracking-tight">
              OpenChat
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={() => {
              createSession();
              setRevealId(null);
              if (window.innerWidth < 768) setSidebarOpen(false);
            }}
            className="w-full flex items-center justify-between px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 rounded-lg text-xs font-medium transition-all cursor-pointer"
          >
            <div className="flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>New chat</span>
            </div>
            <kbd className="text-[9px] font-mono opacity-70">⌘K</kbd>
          </button>
        </div>

        {/* Chat List */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2 space-y-0.5" style={{ touchAction: "pan-y" }}>
          {sessions.map((s) => {
            const isSelected = s.id === currentSessionId;
            const isEditing = editingId === s.id;
            const revealed = revealId === s.id;

            return (
              <div key={s.id} data-row={s.id} className="relative rounded-lg overflow-hidden group">
                {/* Action layer underneath */}
                <div
                  className={`absolute inset-y-0 right-0 flex items-center gap-1 pl-10 pr-2.5 rounded-lg ${
                    isSelected ? "bg-zinc-200 dark:bg-zinc-800" : "bg-[#f9f9fb] dark:bg-[#141416]"
                  } ${revealed ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                >
                  {!isEditing && (
                    <>
                      <button
                        onClick={(e) => handleStartRename(s.id, s.title, e)}
                        className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => handleDelete(s.id, e)}
                        className="p-1.5 text-zinc-400 hover:text-rose-500"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>

                {/* Sliding row content */}
                <div
                  data-row-content
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
                  className={`relative flex items-center justify-between px-3 py-2 rounded-lg text-[13px] cursor-pointer select-none ${
                    isSelected
                      ? "bg-zinc-200/80 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-100 font-medium"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
                  }`}
                >
                  <div className="truncate flex-1 mr-1">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveRename(s.id, e as any);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        autoFocus
                        className="w-full bg-white dark:bg-zinc-900 border border-zinc-400 rounded px-1.5 py-0.5 text-xs outline-none"
                      />
                    ) : (
                      <span className="truncate">{s.title}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-2.5 border-t border-zinc-200/70 dark:border-zinc-800 flex items-center justify-between text-[11px] text-zinc-400 flex-shrink-0">
          <span className="font-mono truncate" title={selectedModel}>{shortModel}</span>
          <button
            onClick={toggleTheme}
            className="p-1 rounded hover:bg-zinc-200/60 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
            title={theme === "light" ? "Dark mode" : "Light mode"}
          >
            {theme === "light" ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
          </button>
        </div>
      </aside>
    </>
  );
};
