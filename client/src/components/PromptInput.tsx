import React, { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, ChevronDown, Check, Paperclip, X, Search, Sparkles, Loader2, RotateCcw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore, type ModelGroup } from "../store/useChatStore";
import { BottomSheet } from "./BottomSheet";
import { useMediaQuery } from "../hooks/useMediaQuery";

export const PromptInput: React.FC = () => {
  const content = useChatStore(st => st.drafts[st.currentSessionId || ""] || "");
  const setContent = useChatStore(st => st.setDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentSessionId = useChatStore((st) => st.currentSessionId);
  const {
    isGenerating,
    isSubmitting,
    isStopping,
    isSessionLoading,
    lastError,
    sendMessage,
    stopGeneration,
    modelGroups,
    selectedModel,
    selectedProvider,
    setSelectedModel,
    pendingAttachments,
    uploading,
    addFiles,
    removePendingAttachment,
  } = useChatStore(useShallow(st => ({
    isGenerating: st.isGenerating, isSubmitting: st.isSubmitting, isStopping: st.isStopping,
    isSessionLoading: st.isSessionLoading, lastError: st.lastError,
    sendMessage: st.sendMessage, stopGeneration: st.stopGeneration, modelGroups: st.modelGroups,
    selectedModel: st.selectedModel, selectedProvider: st.selectedProvider, setSelectedModel: st.setSelectedModel,
    pendingAttachments: st.pendingAttachments, uploading: st.uploading, addFiles: st.addFiles,
    removePendingAttachment: st.removePendingAttachment,
  })));
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const [modelSaving, setModelSaving] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  // Slash-command autocomplete over installed skills.
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);

  // Skills can appear at any time (the model installs them mid-session), so
  // re-fetch whenever the user STARTS a slash query instead of only on mount.
  const refreshSkills = React.useCallback(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setSkills(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshSkills();
  }, [refreshSkills]);
  const slashTyping = content.startsWith("/");
  const wasSlashTyping = useRef(false);
  useEffect(() => {
    if (slashTyping && !wasSlashTyping.current) refreshSkills();
    wasSlashTyping.current = slashTyping;
  }, [slashTyping, refreshSkills]);

  const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(content);
  const token = (slashMatch?.[1] ?? "").toLowerCase();
  const slashCandidates = slashMatch
    ? skills.filter((s) => s.name.toLowerCase().startsWith(token)).slice(0, 8)
    : [];
  const slashOpen =
    !!slashMatch && token !== dismissedToken && slashCandidates.length > 0;

  const handleChange = (v: string) => {
    setDismissedToken(null);
    setSlashIdx(0);
    setContent(v);
  };

  const applySkill = (name: string) => {
    handleChange(`/${name} `);
    textareaRef.current?.focus();
  };

  useEffect(() => {
    const adjustHeight = () => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
      }
    };
    adjustHeight();
    window.addEventListener("resize", adjustHeight);
    return () => window.removeEventListener("resize", adjustHeight);
  }, [content]);

  // Auto-focus filter input when sheet opens
  useEffect(() => {
    if (modelMenuOpen && filterRef.current) {
      filterRef.current.focus();
    }
  }, [modelMenuOpen]);

  const closeModelMenu = () => {
    setModelMenuOpen(false);
    setModelFilter("");
  };

  const isTouch = useMediaQuery("(pointer: coarse)");

  useEffect(() => {
    setModelMenuOpen(false); setModelFilter(""); setDismissedToken(null); setSlashIdx(0);
  }, [currentSessionId]);

  const handleSubmit = () => {
    const hasPending = pendingAttachments.length > 0;
    if ((!content.trim() && !hasPending) || isGenerating || uploading || isSessionLoading) return;
    sendMessage(content);
  };

  const [isDragging, setIsDragging] = useState(false);

  const handlePaste = (e: React.ClipboardEvent) => {
    if (isGenerating || uploading || pendingAttachments.length >= 8) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (isGenerating || uploading || pendingAttachments.length >= 8) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isGenerating || uploading || pendingAttachments.length >= 8) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) addFiles(files);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashCandidates.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applySkill(slashCandidates[slashIdx].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedToken(token);
        return;
      }
    }
    // Enter key handling:
    // Ctrl+Enter or Cmd+Enter always submits
    // Desktop: Enter sends, Shift+Enter newlines
    // Mobile (touch): Enter inserts newline, Send button submits
    if (e.key === "Enter") {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleSubmit();
        return;
      }
      if (!isTouch && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    }
  };

  const handleSelectModel = async (modelId: string, providerId: string) => {
    if (modelSaving) return;
    setModelSaving(providerId + ":" + modelId); setModelError(null);
    const ok = await setSelectedModel(modelId, providerId);
    setModelSaving(null);
    if (ok) closeModelMenu();
    else setModelError(useChatStore.getState().lastError || "모델을 변경하지 못했습니다.");
  };

  const hasText = content.trim().length > 0;
  const hasAttachments = pendingAttachments.length > 0;

  // Unified picker: groups preserved for display; filtering flattens.
  const filteredGroups: ModelGroup[] = modelFilter.trim()
    ? modelGroups
        .map((g) => ({
          ...g,
          models: g.models.filter(
            (m) =>
              m.id.toLowerCase().includes(modelFilter.toLowerCase()) ||
              (m.name || "").toLowerCase().includes(modelFilter.toLowerCase()) ||
              g.provider_name.toLowerCase().includes(modelFilter.toLowerCase())
          ),
        }))
        .filter((g) => g.models.length > 0)
    : modelGroups;
  const totalFiltered = filteredGroups.reduce((n, g) => n + g.models.length, 0);

  // Short display name
  const displayModel = modelGroups.find(g => g.provider_id === selectedProvider)?.models.find(m => m.id === selectedModel)?.name || selectedModel || "모델 선택";

  return (
    <div className="chat-width px-3 sm:px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5">
      <div
        className={`composer relative flex flex-col ${
          isDragging
            ? "border-violet-500 bg-violet-50/50 dark:bg-violet-950/20 ring-2 ring-violet-400/30"
            : ""
        }`}
        onPaste={handlePaste}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-30 rounded-2xl bg-violet-500/10 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
            <span className="text-xs font-medium text-violet-600 dark:text-violet-300">
              파일을 놓아 첨부하세요
            </span>
          </div>
        )}

        {/* Slash skill autocomplete */}
        {slashOpen && (
          <div className="absolute left-3 right-3 bottom-full mb-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-[#1e1e1e] shadow-lg overflow-hidden z-20">
            {slashCandidates.map((s, i) => (
              <button
                key={s.name}
                data-slash-item
                onClick={() => applySkill(s.name)}
                onMouseEnter={() => setSlashIdx(i)}
                className={`w-full text-left px-3 py-2 transition-colors cursor-pointer ${i === slashIdx ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
              >
                <div className="text-sm font-mono text-violet-600 dark:text-violet-400">/{s.name}</div>
                {s.description && <div className="text-xs text-muted truncate mt-0.5">{s.description}</div>}
              </button>
            ))}
          </div>
        )}

        {/* Attachment chips */}
        {(hasAttachments || uploading) && (
          <div className="flex flex-wrap gap-2 px-4 pt-4">
            {pendingAttachments.map((a) => (
              <div key={a.id} className="group relative flex items-center gap-2 pl-2 pr-9 py-2 rounded-xl bg-[var(--surface-soft)] border border-[var(--border)] text-xs max-w-[240px]">
                {a.kind === "image" ? (
                  <img src={`/api/sessions/${currentSessionId}/files/${a.path}`} alt="" className="w-6 h-6 rounded object-cover flex-shrink-0" />
                ) : (
                  <Paperclip className="w-3 h-3 flex-shrink-0" />
                )}
                <span className="truncate">{a.name}</span>
                <button
                  onClick={() => a.id && removePendingAttachment(a.id)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 size-7 flex items-center justify-center rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
                  title="첨부 삭제"
                  aria-label={`${a.name} 첨부 삭제`}
                  disabled={isSubmitting}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {uploading && <div role="status" className="px-2 py-1 text-xs text-muted flex items-center gap-2"><Loader2 className="size-4 animate-spin" />파일 업로드 중…</div>}
          </div>
        )}

        {/* Textarea */}
        <div className="px-4 pt-4 pb-2 sm:px-5 sm:pt-5">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isSessionLoading ? "대화를 불러오는 중…" : "무엇이든 물어보세요. 파일을 첨부해도 좋아요."}
            aria-label="메시지 입력"
            disabled={isSessionLoading || isSubmitting || !currentSessionId}
            rows={2}
            className="w-full min-h-12 bg-transparent placeholder:text-muted text-[16px] leading-7 outline-none resize-none max-h-44 font-sans disabled:opacity-60"
          />
        </div>

        {/* Bottom bar with model selector trigger */}
        <div className="flex items-center gap-1.5 px-2.5 sm:px-3.5 pb-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating || uploading || hasAttachments && pendingAttachments.length >= 8}
            className="ui-icon-button shrink-0"
            title="파일 또는 이미지 첨부"
            aria-label="파일 또는 이미지 첨부"
          >
            <Paperclip className="size-5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            data-model-trigger
            onClick={() => setModelMenuOpen(true)}
            className="flex items-center gap-2 min-w-0 max-w-[70%] sm:max-w-[65%] px-2.5 py-2 rounded-xl text-[13px] font-medium text-muted hover:bg-[var(--surface-soft)] transition-colors cursor-pointer select-none disabled:opacity-50"
            disabled={isGenerating || isSessionLoading}
            aria-haspopup="dialog"
            aria-expanded={modelMenuOpen}
            title={`모델 선택: ${displayModel}`}
          >
            <Sparkles className="size-4 shrink-0 text-indigo-500 dark:text-indigo-300" />
            <span className="truncate">{displayModel}</span>
            <ChevronDown className="size-3.5 shrink-0" />
          </button>
          <div className="flex-1" />
          {isGenerating ? (
            <button onClick={stopGeneration} disabled={isSubmitting || isStopping} className="size-10 sm:size-11 rounded-2xl bg-[var(--ink)] text-[var(--surface)] flex items-center justify-center cursor-pointer shrink-0 disabled:opacity-60" title={isStopping ? "중단 처리 중" : "응답 중단"} aria-label={isStopping ? "중단 처리 중" : "응답 중단"}>
              {isSubmitting || isStopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-3.5 fill-current" />}
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={(!hasText && !hasAttachments) || uploading || isSessionLoading || !currentSessionId} className="size-10 sm:size-11 rounded-2xl bg-indigo-600 text-white dark:bg-indigo-400 dark:text-slate-950 flex items-center justify-center cursor-pointer shrink-0 hover:opacity-90 disabled:opacity-25 disabled:cursor-not-allowed transition-opacity" title={lastError && hasText ? "다시 보내기" : "메시지 보내기"} aria-label={lastError && hasText ? "다시 보내기" : "메시지 보내기"}>
              {lastError && hasText ? <RotateCcw className="size-5" /> : <ArrowUp className="size-5 stroke-[2.5]" />}
            </button>
          )}
        </div>
      </div>
      <div className="hidden sm:flex items-center justify-between px-2 pt-2.5 text-xs text-muted">
        <span>파일을 끌어 놓거나 <kbd className="font-mono">/</kbd>로 스킬을 불러오세요</span>
        <span>{isTouch ? "" : "Enter 전송 · Shift+Enter 줄바꿈"}</span>
      </div>

      {/* Model selector bottom sheet */}
      {modelMenuOpen && (
        <BottomSheet title="모델 선택" description="대화에 사용할 모델을 선택하세요." onClose={closeModelMenu}>
          <div data-model-sheet className="pb-3">
            <div className="px-5 pb-4 relative">
              <Search className="size-4 absolute left-9 top-3.5 text-muted pointer-events-none" />
              <input
                ref={filterRef}
                data-autofocus
                type="text"
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                placeholder="모델 또는 프로바이더 검색"
                aria-label="모델 검색"
                className="ui-field pl-10!"
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter" && totalFiltered > 0) {
                    const g = filteredGroups[0];
                    handleSelectModel(g.models[0].id, g.provider_id);
                  }
                }}
              />
            </div>
            {modelError && <p role="alert" className="mx-5 mb-3 text-sm text-rose-600 dark:text-rose-400">{modelError}</p>}
            <div className="max-h-[52dvh] overflow-y-auto border-t border-[var(--border)] py-2 px-3">
              {totalFiltered === 0 ? (
                <div className="px-3 py-3 text-sm text-zinc-400 text-center">
                  {modelGroups.length === 0 ? "설정에서 프로바이더를 연결하면 모델이 표시됩니다." : "검색 결과가 없습니다. 다른 이름으로 찾아보세요."}
                </div>
              ) : (
                filteredGroups.map((g) => (
                  <div key={g.provider_id} className="mb-1">
                    <div className="px-3 pt-4 pb-2 text-xs font-semibold text-muted flex items-center justify-between">
                      {g.provider_name}<span className="font-normal">{g.models.length}개 모델</span>
                    </div>
                    {g.models.map((m) => {
                      const isActive = m.id === selectedModel && g.provider_id === selectedProvider;
                      return (
                        <button
                          key={`${g.provider_id}:${m.id}`}
                          onClick={() => handleSelectModel(m.id, g.provider_id)}
                          disabled={!!modelSaving}
                          aria-pressed={isActive}
                          className={`w-full flex items-center justify-between gap-3 px-3 py-3 text-sm text-left rounded-xl transition-colors cursor-pointer disabled:opacity-60 ${
                            isActive
                              ? "bg-[var(--accent-soft)] text-indigo-700 dark:text-indigo-200 font-medium"
                              : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{m.name || m.id}</span>
                            {m.name && m.name !== m.id && <span className="block truncate text-xs text-muted mt-0.5 font-mono">{m.id}</span>}
                          </span>
                          {modelSaving === g.provider_id + ":" + m.id ? <Loader2 className="size-4 animate-spin shrink-0" /> : isActive && <Check className="size-4 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </BottomSheet>
      )}
    </div>
  );
};
