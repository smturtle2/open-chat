import React, { lazy, Suspense, useEffect, useRef } from "react";
import { PanelLeft, Loader2, WifiOff, Sparkles, Folder } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "./store/useChatStore";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { PromptInput } from "./components/PromptInput";
import { SessionMenu } from "./components/SessionMenu";
import { initTheme } from "./theme";
import { BottomSheet } from "./components/BottomSheet";
import { useMediaQuery } from "./hooks/useMediaQuery";
const ArtifactViewer = lazy(() => import("./components/ArtifactViewer").then((m) => ({ default: m.ArtifactViewer })));

export const App: React.FC = () => {
  const { fetchSessions, fetchModels, sidebarOpen, setSidebarOpen, activeArtifact, closeArtifact, isGenerating, isStopping, connection } = useChatStore(useShallow(st => ({
    fetchSessions: st.fetchSessions, fetchModels: st.fetchModels, sidebarOpen: st.sidebarOpen,
    setSidebarOpen: st.setSidebarOpen, activeArtifact: st.activeArtifact, closeArtifact: st.closeArtifact,
    isGenerating: st.isGenerating, isStopping: st.isStopping, connection: st.connection,
  })));
  const session = useChatStore(st => st.sessions.find(s => s.id === st.currentSessionId));
  const wide = useMediaQuery("(min-width: 1024px)");
  const mobile = useMediaQuery("(max-width: 767px)");
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) { initialized.current = true; fetchSessions(); fetchModels(); }
    return initTheme();
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const fit = () => {
      if (viewport.scale === 1) document.documentElement.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      else document.documentElement.style.removeProperty("--app-height");
    };
    fit(); viewport.addEventListener("resize", fit);
    return () => { viewport.removeEventListener("resize", fit); document.documentElement.style.removeProperty("--app-height"); };
  }, []);

  return (
    <div className="app-shell w-full h-full flex overflow-hidden font-sans antialiased">
      <Sidebar />

      {/* Main Chat Area */}
      <div inert={mobile && sidebarOpen} className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
        {/* Header */}
        <header className="h-16 flex items-center justify-between gap-3 px-3 md:px-6 shrink-0 z-10 border-b border-[var(--border)]">
          <div className="flex items-center gap-2.5 min-w-0">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                aria-label="사이드바 열기"
                className="ui-icon-button shrink-0"
              >
                <PanelLeft className="size-5" />
              </button>
            )}
            <div className="min-w-0">
              <h1 data-session-title className="truncate text-sm font-semibold tracking-tight">{session?.title === "New Chat" ? "새 대화" : session?.title === "New Agent" ? "새 에이전트" : session?.title || "OpenChat"}</h1>
              <span className="text-xs text-muted flex items-center gap-1 mt-0.5 truncate">
                {session?.mode === "agent" ? <><Folder className="size-3 shrink-0" /><span className="truncate">{session.workdir}</span></> : <><Sparkles className="size-3" />채팅</>}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-3 shrink-0">
            {connection === "reconnecting" ? (
              <span role="status" className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"><WifiOff className="size-3.5" /><span className="hidden sm:inline">재연결 중</span></span>
            ) : isGenerating && (
              <span role="status" className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-300"><Loader2 className="size-3.5 animate-spin" />{isStopping ? "중단 중" : "응답 중"}</span>
            )}
            <SessionMenu />
          </div>
        </header>

        <div className="flex-1 min-h-0 w-full overflow-hidden">
          <ChatView />
        </div>

        <div className="w-full shrink-0">
          <PromptInput />
        </div>
      </div>

      {/* Live Artifacts Panel: Side-by-Side on desktop, Fullscreen drawer on mobile */}
      {activeArtifact && (wide ? (
        <aside className="artifact-panel" aria-label="미리보기">
          <Suspense fallback={<div role="status" className="p-6 text-sm text-muted">미리보기를 준비하는 중…</div>}><ArtifactViewer key={activeArtifact.id} /></Suspense>
        </aside>
      ) : (
        <BottomSheet title="미리보기" fullScreen hideHeader onClose={closeArtifact}>
          <Suspense fallback={<div role="status" className="p-6 text-sm text-muted">미리보기를 준비하는 중…</div>}><ArtifactViewer key={activeArtifact.id} /></Suspense>
        </BottomSheet>
      ))}
    </div>
  );
};
