import { create } from "zustand";

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  thought?: string;
  tool_calls?: any;
  tool_call_id?: string;
  name?: string;
  created_at: string;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  status: "idle" | "running";
  created_at: string;
  updated_at: string;
}

export interface ActiveToolCall {
  id: string;
  name: string;
  args: any;
  status: "running" | "completed" | "error";
  observation?: string;
}

export interface ModelInfo {
  id: string;
  object: string;
  owned_by?: string;
}

interface ChatState {
  sessions: Session[];
  currentSessionId: string | null;
  messages: Message[];
  isGenerating: boolean;
  currentThought: string;
  currentContent: string;
  activeToolCalls: ActiveToolCall[];
  sidebarOpen: boolean;
  theme: "light" | "dark";
  eventSource: EventSource | null;
  models: ModelInfo[];
  selectedModel: string;

  // Actions
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
  setSidebarOpen: (open: boolean) => void;
  fetchSessions: () => Promise<void>;
  fetchModels: () => Promise<void>;
  createSession: () => Promise<string>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  setSelectedModel: (model: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  connectSSE: (sessionId: string, afterEventId?: number) => void;
}

const DEFAULT_MODEL = "muse-spark-1.2-contributor";

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  isGenerating: false,
  currentThought: "",
  currentContent: "",
  activeToolCalls: [],
  sidebarOpen: true,
  theme: (localStorage.getItem("openchat_theme") as "light" | "dark") || "light",
  eventSource: null,
  models: [],
  selectedModel: localStorage.getItem("openchat_model") || DEFAULT_MODEL,

  setTheme: (theme) => {
    localStorage.setItem("openchat_theme", theme);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    set({ theme });
  },

  toggleTheme: () => {
    const next = get().theme === "light" ? "dark" : "light";
    get().setTheme(next);
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  fetchModels: async () => {
    try {
      const res = await fetch("/api/models");
      if (!res.ok) return;
      const data = await res.json();
      const models: ModelInfo[] = (data.data || []).map((m: any) => ({
        id: m.id,
        object: m.object,
        owned_by: m.owned_by,
      }));
      set({ models });
    } catch {}
  },

  fetchSessions: async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data: Session[] = await res.json();
      set({ sessions: data });

      const { currentSessionId } = get();
      if (!currentSessionId && data.length > 0) {
        get().selectSession(data[0].id);
      } else if (data.length === 0) {
        get().createSession();
      }
    } catch {}
  },

  createSession: async () => {
    try {
      const { selectedModel } = get();
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Chat", model: selectedModel }),
      });
      const session: Session = await res.json();
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        messages: [],
        currentThought: "",
        currentContent: "",
        activeToolCalls: [],
        isGenerating: false,
        selectedModel: session.model || selectedModel,
      }));
      get().connectSSE(session.id, 0);
      return session.id;
    } catch {
      return "";
    }
  },

  selectSession: async (id: string) => {
    const { eventSource } = get();
    if (eventSource) {
      eventSource.close();
      set({ eventSource: null });
    }

    set({
      currentSessionId: id,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
      isGenerating: false,
    });

    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) return;
      const data = await res.json();

      if (get().currentSessionId !== id) return;

      const rawMessages: Message[] = (data.messages || []).map((m: any) => ({
        ...m,
        tool_calls: m.tool_calls ? (typeof m.tool_calls === "string" ? JSON.parse(m.tool_calls) : m.tool_calls) : undefined,
      }));

      const isRunning = data.status === "running";
      const sessionModel = data.model || DEFAULT_MODEL;

      set({
        messages: rawMessages,
        isGenerating: isRunning,
        selectedModel: sessionModel,
      });
      localStorage.setItem("openchat_model", sessionModel);

      get().connectSSE(id, data.last_event_id || 0);
    } catch {}
  },

  deleteSession: async (id: string) => {
    try {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      const { sessions, currentSessionId } = get();
      const filtered = sessions.filter((s) => s.id !== id);
      set({ sessions: filtered });

      if (currentSessionId === id) {
        if (filtered.length > 0) {
          get().selectSession(filtered[0].id);
        } else {
          get().createSession();
        }
      }
    } catch {}
  },

  updateSessionTitle: async (id: string, title: string) => {
    try {
      await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
      }));
    } catch {}
  },

  renameSession: async (id: string, title: string) => {
    await get().updateSessionTitle(id, title);
  },

  setSelectedModel: async (model: string) => {
    const { currentSessionId } = get();
    set({ selectedModel: model });
    localStorage.setItem("openchat_model", model);

    // Persist to current session
    if (currentSessionId) {
      try {
        await fetch(`/api/sessions/${currentSessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === currentSessionId ? { ...s, model } : s
          ),
        }));
      } catch {}
    }
  },

  sendMessage: async (content: string) => {
    const { currentSessionId } = get();
    if (!currentSessionId || !content.trim()) return;

    set({
      isGenerating: true,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
    });

    try {
      await fetch(`/api/sessions/${currentSessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } catch {
      set({ isGenerating: false });
    }
  },

  editMessage: async (messageId: string, newContent: string) => {
    const { currentSessionId, messages } = get();
    if (!currentSessionId || !newContent.trim()) return;

    // Keep all messages up to and including the target user message, update its content, and drop subsequent assistant turns
    const targetIdx = messages.findIndex((m) => m.id === messageId);
    const retained = targetIdx !== -1 ? messages.slice(0, targetIdx + 1) : messages;
    const updatedMessages = retained.map((m) => (m.id === messageId ? { ...m, content: newContent } : m));

    set({
      messages: updatedMessages,
      isGenerating: true,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
    });

    try {
      await fetch(`/api/sessions/${currentSessionId}/messages/${messageId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
    } catch {
      set({ isGenerating: false });
    }
  },

  regenerateMessage: async (messageId: string) => {
    const { currentSessionId, messages } = get();
    if (!currentSessionId) return;

    // Keep all messages up to and including the target user message, drop subsequent assistant turns
    const targetIdx = messages.findIndex((m) => m.id === messageId);
    const retained = targetIdx !== -1 ? messages.slice(0, targetIdx + 1) : messages;

    set({
      messages: retained,
      isGenerating: true,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
    });

    try {
      await fetch(`/api/sessions/${currentSessionId}/messages/${messageId}/regenerate`, {
        method: "POST",
      });
    } catch {
      set({ isGenerating: false });
    }
  },

  stopGeneration: async () => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;

    try {
      await fetch(`/api/sessions/${currentSessionId}/stop`, { method: "POST" });
      set({ isGenerating: false });
    } catch {}
  },

  connectSSE: (sessionId: string, afterEventId = 0) => {
    const { eventSource } = get();
    if (eventSource) {
      eventSource.close();
    }

    const url = `/api/sessions/${sessionId}/events?after=${afterEventId}`;
    const es = new EventSource(url);

    es.addEventListener("thought_delta", (e: any) => {
      if (get().currentSessionId !== sessionId) return;
      try {
        const payload = JSON.parse(e.data);
        set((state) => ({ currentThought: state.currentThought + payload.delta }));
      } catch {}
    });

    es.addEventListener("content_delta", (e: any) => {
      if (get().currentSessionId !== sessionId) return;
      try {
        const payload = JSON.parse(e.data);
        set((state) => ({ currentContent: state.currentContent + payload.delta }));
      } catch {}
    });

    es.addEventListener("tool_executing", (e: any) => {
      if (get().currentSessionId !== sessionId) return;
      try {
        const payload = JSON.parse(e.data);
        set((state) => {
          const exists = state.activeToolCalls.find((t) => t.id === payload.id);
          if (exists) return state;
          return {
            activeToolCalls: [
              ...state.activeToolCalls,
              {
                id: payload.id,
                name: payload.name,
                args: payload.args,
                status: "running",
              },
            ],
          };
        });
      } catch {}
    });

    es.addEventListener("tool_observed", (e: any) => {
      if (get().currentSessionId !== sessionId) return;
      try {
        const payload = JSON.parse(e.data);
        set((state) => {
          const updatedActive = state.activeToolCalls.map((t) =>
            t.id === payload.tool_call_id
              ? { ...t, status: "completed" as const, observation: payload.observation }
              : t
          );

          const toolMsg: Message = {
            id: `msg_tool_${payload.tool_call_id}`,
            session_id: sessionId,
            role: "tool",
            tool_call_id: payload.tool_call_id,
            name: payload.name,
            content: payload.observation,
            created_at: new Date().toISOString(),
          };

          const alreadyInMessages = state.messages.some(
            (m) => m.tool_call_id === payload.tool_call_id
          );

          return {
            activeToolCalls: updatedActive,
            messages: alreadyInMessages ? state.messages : [...state.messages, toolMsg],
          };
        });
      } catch {}
    });

    es.addEventListener("user_message", (e: any) => {
      if (get().currentSessionId !== sessionId) return;
      try {
        const payload = JSON.parse(e.data);
        set((state) => {
          if (state.messages.some((m) => m.id === payload.id)) return state;
          return {
            messages: [
              ...state.messages,
              {
                id: payload.id,
                session_id: sessionId,
                role: "user",
                content: payload.content,
                created_at: new Date().toISOString(),
              },
            ],
          };
        });
      } catch {}
    });

    es.addEventListener("assistant_message", (e: any) => {
      if (get().currentSessionId !== sessionId) return;
      try {
        const payload = JSON.parse(e.data);
        set((state) => {
          if (state.messages.some((m) => m.id === payload.id)) return state;
          return {
            messages: [
              ...state.messages,
              {
                id: payload.id,
                session_id: sessionId,
                role: "assistant",
                content: payload.content,
                thought: payload.thought,
                tool_calls: payload.tool_calls,
                created_at: new Date().toISOString(),
              },
            ],
            currentThought: "",
            currentContent: "",
          };
        });
      } catch {}
    });

    es.addEventListener("turn_completed", () => {
      if (get().currentSessionId !== sessionId) return;
      set({
        isGenerating: false,
        currentThought: "",
        currentContent: "",
        activeToolCalls: [],
      });
      get().fetchSessions();
    });

    es.addEventListener("task_interrupted", () => {
      if (get().currentSessionId !== sessionId) return;
      set({
        isGenerating: false,
        currentThought: "",
        currentContent: "",
        activeToolCalls: [],
      });
      get().fetchSessions();
    });

    es.addEventListener("error", () => {
      if (get().currentSessionId !== sessionId) return;
      set({ isGenerating: false });
    });

    set({ eventSource: es });
  },
}));
