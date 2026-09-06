import React, { useState, useEffect, useRef } from "react";
import { Pencil, RotateCcw, ChevronDown, ChevronRight, Sparkles, Code2, FileText, Lightbulb, ArrowDown, Copy, Check, Paperclip, Loader2, AlertCircle, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore, Message } from "../store/useChatStore";
import { MarkdownView } from "./MarkdownView";
import { StepEntry } from "./Steps";
import { StepSheet } from "./StepSheet";
import { copyText } from "../clipboard";

type TurnSegment =
  | { type: "steps"; entries: StepEntry[]; live?: boolean }
  | { type: "text"; content: string };

interface ConsolidatedTurn {
  userMsg: Message | null;
  segments: TurnSegment[];
}

export const ChatView: React.FC = () => {
  const {
    currentSessionId,
    messages,
    currentThought,
    currentContent,
    activeToolCalls,
    isGenerating,
    isSessionLoading,
    isSubmitting,
    editMessage,
    regenerateMessage,
    lastError,
    clearError,
  } = useChatStore(useShallow(st => ({
    currentSessionId: st.currentSessionId, messages: st.messages, currentThought: st.currentThought,
    currentContent: st.currentContent, activeToolCalls: st.activeToolCalls, isGenerating: st.isGenerating,
    isSessionLoading: st.isSessionLoading, isSubmitting: st.isSubmitting,
    editMessage: st.editMessage, regenerateMessage: st.regenerateMessage, lastError: st.lastError, clearError: st.clearError,
  })));
  const setDraft = useChatStore(st => st.setDraft);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [copiedTurn, setCopiedTurn] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  // Sticky auto-scroll: follow the stream only while the user is already at
  // the bottom. Scrolling up detaches until they return near the bottom.
  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setShowJump(!stickToBottomRef.current);
  };

  // Re-attach to bottom when switching sessions
  useEffect(() => {
    stickToBottomRef.current = true;
    setShowJump(false); setEditingMsgId(null); setSheetKey(null);
  }, [currentSessionId]);

  const isEmpty = messages.length === 0 && !isGenerating && !isSessionLoading;

  // Build tool observations lookup map (plus image URLs for view_image results)
  const toolObservations = React.useMemo(() => {
    const map: Record<string, string> = {};
    const imageUrls: Record<string, string> = {};
    const statuses: Record<string, Message["tool_status"]> = {};
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        map[msg.tool_call_id] = msg.content;
        if (msg.imageUrl) imageUrls[msg.tool_call_id] = msg.imageUrl;
        statuses[msg.tool_call_id] = msg.tool_status;
      }
    }
    return { map, imageUrls, statuses };
  }, [messages]);

  // Persisted content only.
  const turns: ConsolidatedTurn[] = React.useMemo(() => {
    const result: ConsolidatedTurn[] = [];
    let currentUserMsg: Message | null = null;
    let turnAssistantMsgs: Message[] = [];

    const flushTurn = () => {
      if (!currentUserMsg && turnAssistantMsgs.length === 0) return;
      const segments: TurnSegment[] = [];
      let pendingEntries: StepEntry[] = [];

      const flushPending = () => {
        if (pendingEntries.length === 0) return;
        segments.push({ type: "steps", entries: [...pendingEntries] });
        pendingEntries = [];
      };

      for (const msg of turnAssistantMsgs) {
        if (msg.thought) {
          pendingEntries.push({ item: { kind: "think", text: msg.thought } });
        }

        let rawCalls: any[] = [];
        if (msg.tool_calls) {
          if (typeof msg.tool_calls === "string") {
            try {
              const parsed = JSON.parse(msg.tool_calls);
              if (Array.isArray(parsed)) rawCalls = parsed;
            } catch {}
          } else if (Array.isArray(msg.tool_calls)) {
            rawCalls = msg.tool_calls;
          }
        }

        for (const tc of rawCalls) {
          const name = tc.name || tc.function?.name || "tool";
          let args = tc.arguments || tc.function?.arguments || {};
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = { raw: args };
            }
          }
          const obs = toolObservations.map[tc.id];
          const activeStatus = activeToolCalls.find((a) => a.id === tc.id)?.status;
          pendingEntries.push({
            item: { kind: "tool", id: tc.id, name, args, obs, imageUrl: toolObservations.imageUrls[tc.id], status: toolObservations.statuses[tc.id] },
            running: activeStatus === "running",
          });
        }

        // If this assistant message contains text content, flush pending steps first
        if (msg.content && msg.content.trim()) {
          flushPending();
          segments.push({ type: "text", content: msg.content });
        }
      }

      flushPending();

      result.push({ userMsg: currentUserMsg, segments });
    };

    for (const msg of messages) {
      if (msg.role === "user") {
        flushTurn();
        currentUserMsg = msg;
        turnAssistantMsgs = [];
      } else if (msg.role === "assistant") {
        turnAssistantMsgs.push(msg);
      }
    }

    flushTurn();
    return result;
  }, [messages, toolObservations, activeToolCalls]);

  const displayTurns: ConsolidatedTurn[] = React.useMemo(() => {
    if (!isGenerating || turns.length === 0) {
      return turns;
    }

    const lastIdx = turns.length - 1;
    const last = turns[lastIdx];
    const segments = [...last.segments];

    const existingToolIds = new Set<string>();
    for (const seg of segments) {
      if (seg.type !== "steps") continue;
      for (const e of seg.entries) {
        if (e.item.kind === "tool") existingToolIds.add(e.item.id);
      }
    }

    const liveEntries: StepEntry[] = [];
    if (currentThought.trim()) {
      liveEntries.push({ item: { kind: "think", text: currentThought }, streaming: true });
    }
    for (const t of activeToolCalls) {
      if (existingToolIds.has(t.id)) continue;
      liveEntries.push({
        item: { kind: "tool", id: t.id, name: t.name, args: t.args, obs: t.observation, status: t.tool_status },
        running: t.status === "running",
      });
    }

    const shownEntries = liveEntries;

    if (shownEntries.length > 0) {
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.type === "steps" && !lastSeg.live) {
        segments[segments.length - 1] = {
          type: "steps",
          entries: [...lastSeg.entries, ...shownEntries],
          live: true,
        };
      } else {
        segments.push({ type: "steps", entries: shownEntries, live: true });
      }
    }

    const patchedLast: ConsolidatedTurn = { ...last, segments };
    return [...turns.slice(0, lastIdx), patchedLast];
  }, [turns, isGenerating, currentThought, activeToolCalls]);

  // Follow the stream only when stuck to bottom.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [displayTurns, currentContent, isGenerating, lastError, isSessionLoading]);

  const [sheetKey, setSheetKey] = useState<string | null>(null);

  const handleStartEdit = (msg: Message) => {
    setEditingMsgId(msg.id);
    setEditingContent(msg.content);
  };

  const handleSaveEdit = async (msgId: string) => {
    if (!editingContent.trim()) return;
    if (await editMessage(msgId, editingContent.trim())) setEditingMsgId(null);
  };

  let sheetEntries: StepEntry[] | null = null;
  let sheetLive = false;
  if (sheetKey) {
    for (let i = 0; i < displayTurns.length; i++) {
      const turn = displayTurns[i];
      const turnKey = turn.userMsg ? turn.userMsg.id : "__live__";
      let ord = -1;
      for (let j = 0; j < turn.segments.length; j++) {
        const seg = turn.segments[j];
        if (seg.type === "steps") {
          ord++;
          if (`${turnKey}_g${ord}` === sheetKey) {
            sheetEntries = seg.entries;
            sheetLive = Boolean(seg.live);
            break;
          }
        }
      }
      if (sheetEntries) break;
    }
  }

  return (
    <div className="relative w-full h-full">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto px-4 md:px-8 py-6 md:py-8"
        style={{ touchAction: "pan-y" }}
      >
        <div className="chat-width space-y-9 pb-5">
          {isSessionLoading ? (
            <div data-session-loading role="status" className="py-20 flex flex-col items-center gap-3 text-sm text-muted"><Loader2 className="size-6 animate-spin text-indigo-500" />대화를 불러오는 중…</div>
          ) : isEmpty ? (
            <div className="min-h-[44dvh] py-6 sm:py-12 flex flex-col items-center justify-center text-center">
              <div className="size-14 sm:size-16 rounded-[22px] bg-[var(--accent-soft)] text-indigo-600 dark:text-indigo-300 flex items-center justify-center mb-6"><Sparkles className="size-7" /></div>
              <h2 className="text-[27px] sm:text-4xl leading-tight font-semibold tracking-tight">무엇을 함께 해볼까요?</h2>
              <p className="mt-3 text-sm sm:text-base text-muted leading-relaxed">질문을 적거나 파일을 첨부해 대화를 시작하세요.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 mt-8 sm:mt-10 w-full max-w-2xl text-left">
                {[
                  { icon: Code2, title: "코드 살펴보기", detail: "문제를 찾고 더 나은 방법으로", prompt: "이 코드를 검토하고 개선할 부분을 알려줘.\n\n" },
                  { icon: FileText, title: "내용 정리하기", detail: "긴 글에서 핵심만 명확하게", prompt: "아래 내용의 핵심과 다음 할 일을 정리해줘.\n\n" },
                  { icon: Lightbulb, title: "아이디어 구체화", detail: "막연한 생각을 실행 계획으로", prompt: "아이디어를 구체적인 계획으로 만들고 싶어. 먼저 필요한 질문을 해줘." },
                ].map(({ icon: Icon, title, detail, prompt }) => <button key={title} onClick={() => { setDraft(prompt); document.querySelector<HTMLTextAreaElement>('textarea[aria-label="메시지 입력"]')?.focus(); }} className="flex sm:flex-col items-center sm:items-start gap-3 sm:gap-4 px-4 py-3.5 sm:p-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-indigo-300 dark:hover:border-indigo-500 hover:bg-[var(--accent-soft)] transition-colors cursor-pointer group">
                  <Icon className="size-5 shrink-0 text-muted group-hover:text-indigo-500 dark:group-hover:text-indigo-300" /><span><span className="block text-sm font-medium">{title}</span><span className="block mt-1 text-xs text-muted">{detail}</span></span>
                </button>)}
              </div>
            </div>
          ) : (
            <>
              {displayTurns.map((turn, turnIdx) => {
                const isLastTurn = turnIdx === displayTurns.length - 1;
                const showStreamTail = isGenerating && isLastTurn;
                const isEditing = turn.userMsg ? editingMsgId === turn.userMsg.id : false;
                const turnKey = turn.userMsg ? turn.userMsg.id : "__live__";

                return (
                  <div key={turnKey} className="space-y-5">
                    {/* 1. User Message Block */}
                    {turn.userMsg && (
                      <div className="flex w-full justify-end">
                        <div className="max-w-[92%] sm:max-w-[80%] min-w-0 space-y-1 flex flex-col items-end">
                          {isEditing ? (
                            <div className="w-full min-w-0 sm:min-w-[360px] bg-[var(--surface)] p-4 rounded-2xl border border-indigo-300 dark:border-indigo-500 shadow-sm space-y-3">
                              <textarea
                                value={editingContent}
                                onChange={(e) => setEditingContent(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.nativeEvent.isComposing) return;
                                  const isTouch = typeof window !== "undefined" && (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
                                  if (e.key === "Enter") {
                                    if (e.ctrlKey || e.metaKey) {
                                      e.preventDefault();
                                      handleSaveEdit(turn.userMsg!.id);
                                      return;
                                    }
                                    if (!isTouch && !e.shiftKey) {
                                      e.preventDefault();
                                      handleSaveEdit(turn.userMsg!.id);
                                    }
                                  }
                                  if (e.key === "Escape") {
                                    setEditingMsgId(null);
                                  }
                                }}
                                rows={3}
                                aria-label="메시지 수정"
                                disabled={isSubmitting}
                                className="w-full bg-transparent text-sm text-zinc-900 dark:text-zinc-100 outline-none resize-none"
                                autoFocus
                              />
                              <div className="flex items-center justify-end gap-2 text-xs">
                                <button
                                  onClick={() => setEditingMsgId(null)}
                                  disabled={isSubmitting}
                                  className="ui-button"
                                >
                                  취소
                                </button>
                                <button
                                  onClick={() => handleSaveEdit(turn.userMsg!.id)}
                                  disabled={isSubmitting || !editingContent.trim()}
                                  className="ui-button ui-button-primary"
                                >
                                  {isSubmitting ? "전송 중…" : "수정 후 보내기"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {turn.userMsg.attachments && turn.userMsg.attachments.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 justify-end">
                                  {turn.userMsg.attachments.map((a) =>
                                    a.kind === "image" ? (
                                      <a
                                        key={a.path}
                                        href={`/api/sessions/${currentSessionId}/files/${a.path}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="block rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-700 hover:opacity-90 transition-opacity"
                                      >
                                        <img src={`/api/sessions/${currentSessionId}/files/${a.path}`} alt={a.name} className="max-h-44 max-w-[220px] object-cover" />
                                      </a>
                                    ) : a.kind === "skill" ? null : (
                                      <a key={a.path} href={`/api/sessions/${currentSessionId}/files/${a.path}`} download={a.name} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs max-w-full hover:border-indigo-300"><Paperclip className="size-3.5 shrink-0" /><span className="truncate">{a.name}</span><span className="text-muted shrink-0">{(a.size / 1024).toFixed(0)} KB</span></a>
                                    )
                                  )}
                                </div>
                              )}
                              <div className="bg-[var(--surface-soft)] border border-[var(--border)] px-4 sm:px-5 py-3 rounded-[20px] rounded-br-md text-[15px] leading-relaxed min-w-0 max-w-full">
                                <MarkdownView
                                  content={(() => {
                                    const c = turn.userMsg.content;
                                    const m = c.match(/^\/([a-z0-9][a-z0-9_-]*)(?=\s|$)/);
                                    if (!m) return c;
                                    const rest = c.slice(m[0].length).replace(/^\s+/, "");
                                    return `<span class="skill-token">${m[1]}</span>${rest ? " " + rest : ""}`;
                                  })()}
                                />
                              </div>

                              {/* Action Buttons below User Bubble */}
                              <div className="flex items-center gap-2 text-muted pr-1 pt-1">
                                {turn.userMsg.sending && <span className="text-xs">전송 중…</span>}
                                <button
                                  onClick={() => handleStartEdit(turn.userMsg!)}
                                  className="ui-icon-button size-8!"
                                  title="메시지 수정"
                                  aria-label="메시지 수정"
                                  disabled={isGenerating}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 2. Assistant Turn Segments — minimal inline step text + text */}
                    {(turn.segments.length > 0 || showStreamTail) && (
                      <div className="flex w-full justify-start">
                        <div className="w-full min-w-0 space-y-4 text-[15px] leading-7">
                          <div className="flex items-center gap-2 text-sm font-semibold select-none"><span className="size-7 rounded-lg bg-[var(--accent-soft)] text-indigo-600 dark:text-indigo-300 flex items-center justify-center"><Sparkles className="size-3.5" /></span>OpenChat</div>
                          {turn.segments.map((seg, segIdx) => {
                            if (seg.type === "steps") {
                              let ord = -1;
                              for (let k = 0; k <= segIdx; k++) {
                                if (turn.segments[k].type === "steps") ord++;
                              }
                              const segKey = `${turnKey}_g${ord}`;
                              const totalSteps = seg.entries.length;
                              const isSheetOpen = sheetKey === segKey;
                              const hasActivity = seg.entries.some((e) => e.streaming || e.running);
                              const activeEntry = seg.entries.find((e) => e.running || e.streaming);
                              const failedCount = seg.entries.filter(e => e.item.kind === "tool" && e.item.status?.ok === false).length;

                              // Live active text while running, clean 'N steps' when finished
                              let summaryLabel = `${totalSteps}개 단계`;
                              if (activeEntry) {
                                summaryLabel = activeEntry.item.kind === "think" ? "생각을 정리하는 중…" : `${activeEntry.item.name} 실행 중…`;
                              }
                              if (failedCount) summaryLabel += ` · ${failedCount}개 실패`;

                              return (
                                <div key={segKey} className="py-0.5">
                                  <button
                                    data-steps-trigger
                                    onClick={() => setSheetKey(sheetKey === segKey ? null : segKey)}
                                    aria-haspopup="dialog"
                                    aria-expanded={isSheetOpen}
                                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs cursor-pointer select-none transition-colors group ${failedCount ? "border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/20" : "border-[var(--border)] text-muted hover:bg-[var(--surface-soft)]"}`}
                                  >
                                    {seg.live && hasActivity && (
                                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse flex-shrink-0" />
                                    )}
                                    <span className="font-medium">
                                      {summaryLabel}
                                    </span>
                                    {isSheetOpen ? (
                                      <ChevronDown className="w-3 h-3 text-zinc-400" />
                                    ) : (
                                      <ChevronRight className="w-3 h-3 text-zinc-400" />
                                    )}
                                  </button>
                                </div>
                              );
                            }

                            if (seg.type === "text") {
                              return (
                                <MarkdownView key={`${turnKey}_txt_${segIdx}`} content={seg.content} />
                              );
                            }

                            return null;
                          })}

                          {/* Streaming answer tail for the generating turn */}
                          {showStreamTail && currentContent && (
                            <div className="space-y-1">
                              <MarkdownView content={currentContent} />
                              <span className="cursor-blink text-zinc-400 dark:text-zinc-500" />
                            </div>
                          )}

                          {/* Working indicator: continuous through all
                              generation phases until prose starts streaming */}
                          {showStreamTail && !currentContent && !turn.segments.some((s) => s.type === "text") && (
                            <div className="flex items-center gap-1.5 py-1 px-0.5 text-zinc-400 dark:text-zinc-500 select-none">
                              <span className="typing-dot-wave" />
                              <span className="typing-dot-wave" />
                              <span className="typing-dot-wave" />
                            </div>
                          )}
                          {!showStreamTail && turn.segments.some(s => s.type === "text") && <div className="flex items-center gap-1 text-muted pt-1">
                            <button className="ui-icon-button size-8!" title={copiedTurn === turnKey ? "복사됨" : "답변 복사"} aria-label="답변 복사" onClick={async () => { const ok = await copyText(turn.segments.filter((s): s is Extract<TurnSegment, { type: "text" }> => s.type === "text").map(s => s.content).join("\n\n")); setCopiedTurn(ok ? turnKey : null); setCopyError(ok ? null : turnKey); if (ok) setTimeout(() => setCopiedTurn(null), 2000); }}>{copiedTurn === turnKey ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}</button>
                            {turn.userMsg && <button className="ui-icon-button size-8!" title="답변 다시 생성" aria-label="답변 다시 생성" disabled={isGenerating} onClick={() => regenerateMessage(turn.userMsg!.id)}><RotateCcw className="size-4" /></button>}
                            {copyError === turnKey && <span role="status" className="text-xs text-amber-600 dark:text-amber-400">복사 권한을 확인하거나 내용을 직접 선택해 주세요.</span>}
                          </div>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* Task failure notice — surfaced instead of failing silently */}
          {lastError && (
            <div
              data-error-notice
              role="alert"
              className="flex items-start justify-between gap-3 rounded-xl border border-red-300/70 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="size-4 shrink-0 mt-1" />
              <div className="leading-relaxed flex-1 min-w-0"><p className="font-semibold mb-0.5">요청을 완료하지 못했습니다</p><p className="break-words">{lastError}</p>{messages.length === 0 && <button className="text-xs font-medium underline underline-offset-4 mt-2 cursor-pointer" onClick={() => currentSessionId ? useChatStore.getState().selectSession(currentSessionId) : useChatStore.getState().fetchSessions()}>다시 불러오기</button>}</div>
              <button
                onClick={clearError}
                title="오류 알림 닫기"
                aria-label="오류 알림 닫기"
                className="flex-shrink-0 rounded px-1.5 text-red-400 hover:text-red-600 dark:hover:text-red-200 transition-colors cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
        </div>
      </div>
      {showJump && <button className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-lg text-xs font-medium cursor-pointer hover:bg-[var(--surface-soft)] z-20" onClick={() => { const el = scrollContainerRef.current; if (el) { stickToBottomRef.current = true; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); } }}><ArrowDown className="size-4" />최근 메시지로</button>}

      {/* Bottom sheet with the steps details of the toggled group */}
      {sheetEntries && (
        <StepSheet
          entries={sheetEntries}
          live={sheetLive}
          sessionId={currentSessionId ?? undefined}
          onClose={() => setSheetKey(null)}
        />
      )}
    </div>
  );
};
