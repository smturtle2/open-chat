import React, { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, ChevronUp, Check } from "lucide-react";
import { useChatStore } from "../store/useChatStore";
import { BottomSheet } from "./BottomSheet";

export const PromptInput: React.FC = () => {
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { isGenerating, sendMessage, stopGeneration, models, selectedModel, setSelectedModel } = useChatStore();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
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
    if (!content.trim() || isGenerating) return;
    sendMessage(content);
    setContent("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId);
    closeModelMenu();
  };

  const hasText = content.trim().length > 0;

  // Filtered models
  const filteredModels = modelFilter.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(modelFilter.toLowerCase()))
    : models;

  // Short display name
  const displayModel = selectedModel.length > 28 ? selectedModel.slice(0, 28) + "…" : selectedModel;

  return (
    <div className="w-full max-w-3xl mx-auto px-4 pb-4">
      <div className="relative flex flex-col bg-white dark:bg-[#1e1e1e] rounded-2xl border border-zinc-300 dark:border-zinc-700/80 shadow-xs focus-within:border-zinc-400 dark:focus-within:border-zinc-500 transition-all">
        {/* Textarea */}
        <div className="flex items-end gap-2 p-2 pl-3.5">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message OpenChat... (Ctrl+Enter to send, Enter for newline)"
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
              title="Send (Ctrl+Enter)"
            >
              <ArrowUp className="w-[18px] h-[18px] stroke-[2.5]" />
            </button>
          )}
        </div>

        {/* Bottom bar with model selector trigger */}
        <div className="flex items-center px-3 pb-2 pt-0">
          <button
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
                  if (e.key === "Enter" && filteredModels.length > 0) {
                    handleSelectModel(filteredModels[0].id);
                  }
                }}
              />
            </div>

            <div className="max-h-[52vh] overflow-y-auto border-t border-zinc-100 dark:border-zinc-800 py-1.5 px-1.5">
              {filteredModels.length === 0 ? (
                <div className="px-3 py-3 text-sm text-zinc-400 text-center">No models found</div>
              ) : (
                filteredModels.map((m) => {
                  const isActive = m.id === selectedModel;
                  return (
                    <button
                      key={m.id}
                      onClick={() => handleSelectModel(m.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-mono text-left rounded-xl transition-colors cursor-pointer ${
                        isActive
                          ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
                          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                      }`}
                    >
                      <span className="truncate">{m.id}</span>
                      {isActive && <Check className="w-4 h-4 text-zinc-500 flex-shrink-0 ml-2" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </BottomSheet>
      )}
    </div>
  );
};
