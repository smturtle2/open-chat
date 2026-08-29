import React, { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, ChevronUp, Check, Paperclip, X } from "lucide-react";
import { useChatStore, type ModelGroup } from "../store/useChatStore";
import { BottomSheet } from "./BottomSheet";

export const PromptInput: React.FC = () => {
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentSessionId = useChatStore((st) => st.currentSessionId);
  const {
    isGenerating,
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
  } = useChatStore();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

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

  const handleSubmit = () => {
    if (!content.trim() || isGenerating || uploading) return;
    sendMessage(content);
    setContent("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const [isDragging, setIsDragging] = useState(false);

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
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
    // Enter to submit, Shift+Enter for newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSelectModel = (modelId: string, providerId: string) => {
    setSelectedModel(modelId, providerId);
    closeModelMenu();
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
  const displayModel = selectedModel.length > 28 ? selectedModel.slice(0, 28) + "…" : selectedModel;

  return (
    <div className="w-full max-w-3xl mx-auto px-4 pb-4">
      <div
        className={`relative flex flex-col bg-white dark:bg-[#1e1e1e] rounded-2xl border shadow-xs transition-all ${
          isDragging
            ? "border-violet-500 bg-violet-50/50 dark:bg-violet-950/20 ring-2 ring-violet-400/30"
            : "border-zinc-300 dark:border-zinc-700/80 focus-within:border-zinc-400 dark:focus-within:border-zinc-500"
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
              Drop files here to attach
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
                {s.description && <div className="text-[11px] text-zinc-400 truncate">{s.description}</div>}
              </button>
            ))}
          </div>
        )}

        {/* Attachment chips */}
        {(hasAttachments || uploading) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pendingAttachments.map((a) => (
              <div key={a.id} className="group relative flex items-center gap-1.5 pl-1.5 pr-6 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-[11px] font-mono text-zinc-600 dark:text-zinc-300 max-w-[220px]">
                {a.kind === "image" ? (
                  <img src={`/api/sessions/${currentSessionId}/files/${a.path}`} alt="" className="w-6 h-6 rounded object-cover flex-shrink-0" />
                ) : (
                  <Paperclip className="w-3 h-3 flex-shrink-0" />
                )}
                <span className="truncate">{a.name}</span>
                <button
                  onClick={() => a.id && removePendingAttachment(a.id)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
                  title="Remove"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {uploading && <div className="px-2 py-1 text-[11px] font-mono text-zinc-400 animate-pulse">uploading…</div>}
          </div>
        )}

        {/* Textarea */}
        <div className="flex items-end gap-2 p-2 pl-3.5">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message OpenChat... (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 bg-transparent text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 text-sm leading-relaxed outline-none resize-none max-h-44 py-0.5 font-sans"
          />

          {isGenerating ? (
            <button
              onClick={stopGeneration}
              className="size-9 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-black flex items-center justify-center hover:opacity-85 transition-all cursor-pointer flex-shrink-0"
              title="Stop generating"
            >
              <Square className="w-3 h-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!hasText}
              className={`size-9 rounded-full flex items-center justify-center transition-all flex-shrink-0 ${
                hasText
                  ? "bg-zinc-900 dark:bg-white text-white dark:text-black hover:opacity-85 cursor-pointer"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-300 dark:text-zinc-600 cursor-not-allowed"
              }`}
              title="Send (Enter)"
            >
              <ArrowUp className="w-[18px] h-[18px] stroke-[2.5]" />
            </button>
          )}
        </div>

        {/* Bottom bar with model selector trigger */}
        <div className="flex items-center px-3 pb-2 pt-0">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating || uploading || hasAttachments && pendingAttachments.length >= 8}
            className="mr-1 p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Attach files or images"
          >
            <Paperclip className="w-4 h-4" />
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
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-mono text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer select-none"
          >
            <span>{displayModel}</span>
            <ChevronUp className={`w-3 h-3 transition-transform ${modelMenuOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {/* Model selector bottom sheet */}
      {modelMenuOpen && (
        <BottomSheet onClose={closeModelMenu}>
          <div data-model-sheet className="pb-2">
            <div className="px-4 pb-2">
              <input
                ref={filterRef}
                type="text"
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                placeholder="Search models..."
                className="w-full bg-zinc-50 dark:bg-zinc-900 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 outline-none focus:border-zinc-400 dark:focus:border-zinc-500 font-mono"
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter" && totalFiltered > 0) {
                    const g = filteredGroups[0];
                    handleSelectModel(g.models[0].id, g.provider_id);
                  }
                }}
              />
            </div>

            <div className="max-h-[52dvh] overflow-y-auto border-t border-zinc-100 dark:border-zinc-800 py-1.5 px-1.5">
              {totalFiltered === 0 ? (
                <div className="px-3 py-3 text-sm text-zinc-400 text-center">
                  {modelGroups.length === 0 ? "프로바이더를 먼저 설정해 주세요" : "No models found"}
                </div>
              ) : (
                filteredGroups.map((g) => (
                  <div key={g.provider_id} className="mb-1">
                    <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      {g.provider_name}
                    </div>
                    {g.models.map((m) => {
                      const isActive = m.id === selectedModel && g.provider_id === selectedProvider;
                      return (
                        <button
                          key={`${g.provider_id}:${m.id}`}
                          onClick={() => handleSelectModel(m.id, g.provider_id)}
                          className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-mono text-left rounded-xl transition-colors cursor-pointer ${
                            isActive
                              ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
                              : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                          }`}
                        >
                          <span className="truncate">
                            {m.id}
                            {m.name && m.name !== m.id && (
                              <span className="ml-2 font-sans text-[11px] text-zinc-400">{m.name}</span>
                            )}
                          </span>
                          {isActive && <Check className="w-4 h-4 text-zinc-500 flex-shrink-0 ml-2" />}
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
