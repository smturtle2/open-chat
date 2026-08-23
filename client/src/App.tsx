import React, { useEffect } from "react";
import { PanelLeft, Sun, Moon } from "lucide-react";
import { useChatStore } from "./store/useChatStore";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { PromptInput } from "./components/PromptInput";

export const App: React.FC = () => {
  const { theme, toggleTheme, fetchSessions, fetchModels, sidebarOpen, setSidebarOpen } = useChatStore();

  useEffect(() => {
    fetchSessions();
    fetchModels();
  }, []);

  return (
    <div className="w-full h-full flex overflow-hidden bg-white dark:bg-[#121212] text-zinc-900 dark:text-zinc-100 font-sans antialiased">
      <Sidebar />

      <div className="flex-1 flex flex-col h-full w-full min-w-0 overflow-hidden relative">
        {/* Header */}
        <header className="h-11 border-b border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between px-4 flex-shrink-0 bg-white dark:bg-[#121212] z-10">
          <div className="flex items-center gap-2">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-1 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <PanelLeft className="w-4 h-4" />
              </button>
            )}
            <span className="font-semibold text-sm text-zinc-900 dark:text-white">OpenChat</span>
          </div>

          <button
            onClick={toggleTheme}
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title={theme === "light" ? "Dark mode" : "Light mode"}
          >
            {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </button>
        </header>

        <div className="flex-1 min-h-0 w-full overflow-hidden">
          <ChatView />
        </div>

        <div className="w-full flex-shrink-0 bg-white dark:bg-[#121212]">
          <PromptInput />
        </div>
      </div>
    </div>
  );
};
