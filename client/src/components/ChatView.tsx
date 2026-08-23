import React, { useState, useEffect, useRef } from "react";
import { Pencil, RotateCcw, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { useChatStore, Message } from "../store/useChatStore";
import { MarkdownView } from "./MarkdownView";
import { StepEntry } from "./Steps";
import { StepSheet } from "./StepSheet";

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
    editMessage,
    regenerateMessage,
    lastError,
    clearError,
  } = useChatStore();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // Which steps group is open in the bottom sheet ("{turnKey}_g{ordinal}")
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");

  // Sticky auto-scroll: follow the stream only while the user is already at
  // the bottom. Scrolling up detaches until they return near the bottom.
  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  // Re-attach to bottom when switching sessions
  useEffect(() => {
    stickToBottomRef.current = true;
    setSheetKey(null);
    liveSnapshotRef.current = null;
    snapshotOwnerRef.current = null;
  }, [currentSessionId]);

  const isEmpty = messages.length === 0 && !isGenerating;

  // Build tool observations lookup map (plus image URLs for view_image results)
  const toolObservations = React.useMemo(() => {
    const map: Record<string, string> = {};
    const imageUrls: Record<string, string> = {};
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        map[msg.tool_call_id] = msg.content;
        if (msg.imageUrl) imageUrls[msg.tool_call_id] = msg.imageUrl;
      }
    }
    return { map, imageUrls };
  }, [messages]);

  // Persisted content only.
  const turns: ConsolidatedTurn[] = React.useMemo(() => {
    const result: ConsolidatedTurn[] = [];
    let currentUserMsg: Message | null = null;
    let turnAssistantMsgs: Message[] = [];

    const flushTurn = () => {
      if (!currentUserMsg) return;
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
          rawCalls =
            typeof msg.tool_calls === "string" ? JSON.parse(msg.tool_calls) : msg.tool_calls;
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
          pendingEntries.push({ item: { kind: "tool", id: tc.id, name, args, obs, imageUrl: toolObservations.imageUrls[tc.id] } });
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
  }, [messages, toolObservations]);

  // While generating, fold the in-flight thought/tools into ONE live steps
  // group appended to the last turn's trailing steps group (deduped by tool
  // id), so the generating iteration always shows as a single toggle. A
  // snapshot keeps the group visible through silent gaps between rounds
  // (thought cleared / tools already persisted).
  const liveSnapshotRef = useRef<StepEntry[] | null>(null);
  const snapshotOwnerRef = useRef<string | null>(null);

  const displayTurns: ConsolidatedTurn[] = React.useMemo(() => {
    if (!isGenerating || turns.length === 0) {
      liveSnapshotRef.current = null;
      return turns;
    }

    const lastIdx = turns.length - 1;
    const last = turns[lastIdx];
    const segments = [...last.segments];

    const ownerKey = last.userMsg?.id ?? "__live__";
    if (snapshotOwnerRef.current !== ownerKey) {
      snapshotOwnerRef.current = ownerKey;
      liveSnapshotRef.current = null;
    }

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
        item: { kind: "tool", id: t.id, name: t.name, args: t.args },
        running: t.status === "running",
      });
    }

    if (liveEntries.length > 0) {
      liveSnapshotRef.current = liveEntries.map((e) => ({ ...e }));
    }
    const shownEntries =
      liveEntries.length > 0 ? liveEntries : liveSnapshotRef.current ?? [];

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
  }, [displayTurns, currentContent, isGenerating, sheetKey]);

  const handleStartEdit = (msg: Message) => {
    setEditingMsgId(msg.id);
    setEditingContent(msg.content);
  };

  const handleSaveEdit = (msgId: string) => {
    if (!editingContent.trim()) return;
    editMessage(msgId, editingContent.trim());
    setEditingMsgId(null);
  };

  // Resolve the open sheet's entries from the rendered turns
  let sheetEntries: StepEntry[] | null = null;
  let sheetLive = false;
  if (sheetKey) {
    outer: for (const turn of displayTurns) {
      // Ordinal must count steps groups PER TURN — same scheme the inline
      // toggles use when building their keys.
      let ord = -1;
      for (const seg of turn.segments) {
        if (seg.type !== "steps") continue;
        ord++;
        const key = `${turn.userMsg?.id ?? "__live__"}_g${ord}`;
        if (key === sheetKey) {
          sheetEntries = seg.entries;
          sheetLive = Boolean(seg.live);
          break outer;
        }
      }
    }
  }

  const toggleSheet = (key: string) => setSheetKey((prev) => (prev === key ? null : key));

  return (
    <div className="relative w-full h-full">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto px-4 md:px-8 py-6"
        style={{ touchAction: "pan-y" }}
      >
        <div className="w-full max-w-3xl mx-auto space-y-8 pb-8">
          {isEmpty ? (
            <div className="py-20 flex flex-col items-center justify-center text-center space-y-1 select-none">
              <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">
                What can I help with?
              </h1>
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
                        <div className="max-w-[85%] sm:max-w-[75%] space-y-1 flex flex-col items-end">
                          {isEditing ? (
                            <div className="w-full min-w-[280px] sm:min-w-[360px] bg-white dark:bg-zinc-800 p-2.5 rounded-xl border border-zinc-300 dark:border-zinc-600 shadow-sm space-y-2">
                              <textarea
                                value={editingContent}
                                onChange={(e) => setEditingContent(e.target.value)}
                                rows={3}
                                className="w-full bg-transparent text-sm text-zinc-900 dark:text-zinc-100 outline-none resize-none"
                                autoFocus
                              />
                              <div className="flex items-center justify-end gap-2 text-xs">
                                <button
                                  onClick={() => setEditingMsgId(null)}
                                  className="px-2.5 py-1 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => handleSaveEdit(turn.userMsg!.id)}
                                  className="px-2.5 py-1 rounded-md bg-zinc-900 dark:bg-white text-white dark:text-black font-medium hover:opacity-85 transition-opacity cursor-pointer"
                                >
                                  Save & Submit
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
                                    ) : a.kind === "skill" ? (
                                      <span key={a.path} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-violet-100 dark:bg-violet-950 text-[11px] font-mono text-violet-700 dark:text-violet-300">
                                        <Zap className="w-3 h-3" /> {a.name}
                                      </span>
                                    ) : (
                                      <span key={a.path} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-[11px] font-mono text-zinc-600 dark:text-zinc-300">
                                        {a.name} · {(a.size / 1024).toFixed(0)}KB
                                      </span>
                                    )
                                  )}
                                </div>
                              )}
                              <div className="bg-[#f4f4f5] dark:bg-[#27272a] text-zinc-900 dark:text-zinc-100 px-4 py-2.5 rounded-2xl text-[15px] leading-relaxed whitespace-pre-wrap">
                                <MarkdownView content={turn.userMsg.content} />
                              </div>

                              {/* Action Buttons below User Bubble */}
                              <div className="flex items-center gap-2.5 text-zinc-400 dark:text-zinc-500 pr-1 pt-0.5">
                                <button
                                  onClick={() => handleStartEdit(turn.userMsg!)}
                                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                                  title="Edit this message"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => regenerateMessage(turn.userMsg!.id)}
                                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                                  title="Regenerate response from this message"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 2. Assistant Turn Segments — inline step toggles + text */}
                    {(turn.segments.length > 0 || (showStreamTail && !currentContent)) && (
                      <div className="flex w-full justify-start">
                        <div className="w-full max-w-full space-y-3 text-zinc-900 dark:text-zinc-100 text-[15px] leading-relaxed">
                          {turn.segments.map((seg, segIdx) => {
                            if (seg.type === "steps") {
                              // A group's ordinal within its turn never changes
                              // (new groups only append), keeping keys stable.
                              let ord = -1;
                              for (let k = 0; k <= segIdx; k++) {
                                if (turn.segments[k].type === "steps") ord++;
                              }
                              const segKey = `${turnKey}_g${ord}`;
                              const totalSteps = seg.entries.length;
                              const isSheetOpen = sheetKey === segKey;
                              const hasActivity = seg.entries.some(
                                (e) => e.streaming || e.running
                              );

                              return (
                                <div key={segKey} className="space-y-1">
                                  <button
                                    onClick={() => toggleSheet(segKey)}
                                    className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 cursor-pointer select-none py-0.5 transition-colors"
                                  >
                                    {seg.live && hasActivity && (
                                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse flex-shrink-0" />
                                    )}
                                    <span className="font-mono text-[11.5px]">
                                      {totalSteps} step{totalSteps > 1 ? "s" : ""}
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
                          {showStreamTail && !currentContent && (
                            <div className="flex items-center gap-1.5 py-1 px-0.5 text-zinc-400 dark:text-zinc-500 select-none">
                              <span className="typing-dot-wave" />
                              <span className="typing-dot-wave" />
                              <span className="typing-dot-wave" />
                            </div>
                          )}
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
              className="flex items-start justify-between gap-3 rounded-xl border border-red-300/70 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300"
            >
              <span className="leading-relaxed">
                <span className="font-semibold">Task failed: </span>
                {lastError}
              </span>
              <button
                onClick={clearError}
                title="Dismiss"
                className="flex-shrink-0 rounded px-1.5 text-red-400 hover:text-red-600 dark:hover:text-red-200 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom sheet with the steps details of the toggled group */}
      {sheetEntries && (
        <StepSheet entries={sheetEntries} live={sheetLive} sessionId={currentSessionId ?? undefined} onClose={() => setSheetKey(null)} />
      )}
    </div>
  );
};
