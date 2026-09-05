import React, { lazy, Suspense, useEffect } from "react";
import { PanelLeft, LogOut } from "lucide-react";
import { useChatStore } from "./store/useChatStore";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { PromptInput } from "./components/PromptInput";
import { SessionMenu } from "./components/SessionMenu";
import { apiFetch } from "./api";
import { initTheme } from "./theme";
const ArtifactViewer = lazy(() => import("./components/ArtifactViewer").then((m) => ({ default: m.ArtifactViewer })));

export const App: React.FC = () => {
  const { fetchSessions, fetchModels, sidebarOpen, setSidebarOpen, activeArtifact } = useChatStore();

  useEffect(() => {
    fetchSessions();
    fetchModels();
    return initTheme();
  }, []);

  return (
    <div className="w-full h-full flex overflow-hidden bg-white dark:bg-[#121212] text-zinc-900 dark:text-zinc-100 font-sans antialiased">
      <Sidebar />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
        {/* Header */}
        <header className="h-11 border-b border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between px-4 flex-shrink-0 bg-white dark:bg-[#121212] z-10">
          <div className="flex items-center gap-2">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                aria-label="사이드바 열기"
                className="p-1 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <PanelLeft className="w-4 h-4" />
              </button>
            )}
            <span className="font-semibold text-sm text-zinc-900 dark:text-white">OpenChat</span>
          </div>

          <div className="flex items-center gap-2"><SessionMenu />
            <button title="로그아웃" aria-label="로그아웃" className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white" onClick={async () => {
              await apiFetch("/api/auth/logout", { method: "POST" });
              window.dispatchEvent(new Event("openchat:auth-required"));
            }}><LogOut className="w-4 h-4" /></button>
          </div>
        </header>

        <div className="flex-1 min-h-0 w-full overflow-hidden">
          <ChatView />
        </div>

        <div className="w-full flex-shrink-0 bg-white dark:bg-[#121212]">
          <PromptInput />
        </div>
      </div>

      {/* Live Artifacts Panel: Side-by-Side on desktop, Fullscreen drawer on mobile */}
      {activeArtifact && (
        <div className="fixed inset-0 z-50 md:static md:z-auto md:w-[45%] lg:w-[42%] max-w-2xl h-full flex-shrink-0 relative">
          <Suspense fallback={<div className="p-6 text-sm text-zinc-500">불러오는 중…</div>}><ArtifactViewer /></Suspense>
        </div>
      )}
    </div>
  );
};
