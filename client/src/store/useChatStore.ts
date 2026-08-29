import { create } from "zustand";
import { applyTheme, readThemePreference, writeThemePreference, type ThemePreference } from "../theme";

export interface AttachmentMeta {
  id?: string;
  kind: "image" | "file" | "skill";
  name: string;
  path: string;
  size: number;
  mime?: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  thought?: string;
  tool_calls?: any;
  tool_call_id?: string;
  name?: string;
  attachments?: AttachmentMeta[];
  imageUrl?: string;
  created_at: string;
}

export type SessionMode = "chat" | "agent";

export interface Session {
  id: string;
  title: string;
  model: string;
  provider: string | null;
  mode: SessionMode;
  workdir: string | null;
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
  name?: string;
}

export interface ModelGroup {
  provider_id: string;
  provider_name: string;
  models: ModelInfo[];
}

export interface Artifact {
  id: string;
  title: string;
  type: "html" | "react" | "markdown" | "svg" | "mermaid" | "code";
  content: string;
  language?: string;
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
  activeArtifact: Artifact | null;
  theme: ThemePreference;
  eventSource: EventSource | null;
  modelGroups: ModelGroup[];
  selectedProvider: string;
  selectedModel: string;
  lastError: string | null;
  pendingAttachments: AttachmentMeta[];
  uploading: boolean;

  // Actions
  openArtifact: (artifact: Artifact) => void;
  closeArtifact: () => void;
  addFiles: (files: File[] | FileList) => Promise<void>;
  removePendingAttachment: (id: string) => void;
  setTheme: (theme: ThemePreference) => void;
  setSidebarOpen: (open: boolean) => void;
  fetchSessions: () => Promise<void>;
  fetchModels: () => Promise<void>;
  createSession: (mode?: SessionMode, workdir?: string) => Promise<string>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  clearError: () => void;
  setSelectedModel: (model: string, provider?: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  connectSSE: (sessionId: string, afterEventId?: number) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  isGenerating: false,
  currentThought: "",
  currentContent: "",
  activeToolCalls: [],
  sidebarOpen: true,
  activeArtifact: null,
  theme: readThemePreference(),
  eventSource: null,
  modelGroups: [],
  selectedProvider: localStorage.getItem("openchat_provider") || "",
  selectedModel: localStorage.getItem("openchat_model") || "",
  lastError: null,
  pendingAttachments: [],
  uploading: false,

  openArtifact: (artifact) => set({ activeArtifact: artifact }),
  closeArtifact: () => set({ activeArtifact: null }),


  addFiles: async (files) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;
    const targetSessionId = currentSessionId;
    const list = Array.from(files);
    if (list.length === 0) return;
    set({ uploading: true });
    const added: AttachmentMeta[] = [];
    for (const file of list) {
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/sessions/${targetSessionId}/attachments`, { method: "POST", body: form });
        if (res.ok) {
          added.push(await res.json());
        } else {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          if (get().currentSessionId === targetSessionId) {
            set({ lastError: err.error || "Upload failed" });
          }
        }
      } catch {
        if (get().currentSessionId === targetSessionId) {
          set({ lastError: "Upload failed" });
        }
      }
    }
    if (get().currentSessionId === targetSessionId) {
      set((state) => ({ pendingAttachments: [...state.pendingAttachments, ...added].slice(0, 8), uploading: false }));
    } else {
      set({ uploading: false });
    }
  },

  removePendingAttachment: (id) => {
    set((state) => ({ pendingAttachments: state.pendingAttachments.filter((a) => a.id !== id) }));
  },

  setTheme: (theme) => {
    writeThemePreference(theme);
    applyTheme(theme);
    set({ theme });
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  clearError: () => set({ lastError: null }),

  fetchModels: async () => {
    try {
      const res = await fetch("/api/models");
      if (!res.ok) return;
      const data = await res.json();
      const groups: ModelGroup[] = (data.groups || []).map((g: any) => ({
        provider_id: g.provider_id,
        provider_name: g.provider_name,
        models: (g.models || []).map((m: any) => ({ id: m.id, name: m.name })),
      }));
      set((state) => {
        // Adopt the platform default only while the user has not picked a
        // (provider, model) pair that exists in the catalog.
        const storedUsable =
          state.selectedProvider &&
          state.selectedModel &&
          groups.some(
            (g) =>
              g.provider_id === state.selectedProvider &&
              g.models.some((m) => m.id === state.selectedModel)
          );
        if (storedUsable || groups.length === 0) return { modelGroups: groups };
        const def = data.default;
        if (def?.provider && def?.model) {
          localStorage.setItem("openchat_provider", def.provider);
          localStorage.setItem("openchat_model", def.model);
          return { modelGroups: groups, selectedProvider: def.provider, selectedModel: def.model };
        }
        const first = groups[0];
        return first
          ? {
              modelGroups: groups,
              selectedProvider: first.provider_id,
              selectedModel: first.models[0]?.id ?? "",
            }
          : { modelGroups: groups };
      });
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

  createSession: async (mode: SessionMode = "chat", workdir?: string) => {
    try {
      const { selectedModel, selectedProvider } = get();
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: mode === "agent" ? "New Agent" : "New Chat",
          model: selectedModel,
          provider: selectedProvider || undefined,
          mode,
          workdir,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to create session" }));
        set({ lastError: err.error || "Failed to create session" });
        return "";
      }
      const session: Session = await res.json();
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        messages: [],
        currentThought: "",
        currentContent: "",
        activeToolCalls: [],
        isGenerating: false,
        selectedProvider: session.provider || state.selectedProvider,
        selectedModel: session.model || state.selectedModel,
      }));
      get().connectSSE(session.id, 0);
      return session.id;
    } catch {
      return "";
    }
  },

  selectSession: async (id: string) => {
    set({ lastError: null });
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
      pendingAttachments: [],
    });

    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) return;
      const data = await res.json();

      if (get().currentSessionId !== id) return;

      const rawMessages: Message[] = (data.messages || []).map((m: any) => {
        let parsedToolCalls = undefined;
        if (m.tool_calls) {
          if (typeof m.tool_calls === "string") {
            try {
              parsedToolCalls = JSON.parse(m.tool_calls);
            } catch {}
          } else {
            parsedToolCalls = m.tool_calls;
          }
        }
        const msg: Message = {
          ...m,
          tool_calls: parsedToolCalls,
        };
        // Image observations are stored as envelopes; render via file route.
        if (msg.role === "tool" && typeof m.content === "string" && m.content.startsWith("{")) {
          try {
            const parsed = JSON.parse(m.content);
            if (parsed && parsed.__obs__ === "image" && typeof parsed.path === "string") {
              msg.content = `[이미지 · ${parsed.text}]`;
              msg.imageUrl = `/api/sessions/${id}/files/${parsed.path}`;
            }
          } catch {}
        }
        return msg;
      });

      const isRunning = data.status === "running";
      const sessionModel = data.model || get().selectedModel;
      const sessionProvider = data.provider || "";

      set({
        messages: rawMessages,
        isGenerating: isRunning,
        selectedModel: sessionModel,
        selectedProvider: sessionProvider,
      });
      if (sessionProvider) localStorage.setItem("openchat_provider", sessionProvider);
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

  setSelectedModel: async (model: string, provider?: string) => {
    const { currentSessionId, selectedProvider } = get();
    const nextProvider = provider ?? selectedProvider;
    set({ selectedModel: model, selectedProvider: nextProvider });
    localStorage.setItem("openchat_model", model);
    localStorage.setItem("openchat_provider", nextProvider);

    // Persist to current session
    if (currentSessionId) {
      try {
        await fetch(`/api/sessions/${currentSessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, provider: nextProvider || null }),
        });
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === currentSessionId ? { ...s, model, provider: nextProvider || null } : s
          ),
        }));
      } catch {}
    }
  },

  sendMessage: async (content: string) => {
    const { currentSessionId, pendingAttachments, messages } = get();
    if (!currentSessionId) return;
    const promptText = content.trim();
    if (!promptText && pendingAttachments.length === 0) return;

    const attachmentIds = pendingAttachments.map((a) => a.id).filter(Boolean) as string[];
    const userMsgId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tempUserMsg: Message = {
      id: userMsgId,
      session_id: currentSessionId,
      role: "user",
      content: promptText || "첨부된 파일 확인 및 분석",
      attachments: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
      created_at: new Date().toISOString(),
    };

    set({
      messages: [...messages, tempUserMsg],
      isGenerating: true,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
      lastError: null,
      pendingAttachments: [],
    });

    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: userMsgId, content: promptText, attachmentIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Message failed" }));
        set({ isGenerating: false, lastError: err.error || "Failed to send message" });
      }
    } catch {
      set({ isGenerating: false, lastError: "Network error occurred" });
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
      lastError: null,
    });

    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/messages/${messageId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Edit failed" }));
        set({ isGenerating: false, lastError: err.error || "Failed to edit message" });
      }
    } catch {
      set({ isGenerating: false, lastError: "Network error occurred" });
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
      lastError: null,
    });

    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/messages/${messageId}/regenerate`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Regeneration failed" }));
        set({ isGenerating: false, lastError: err.error || "Failed to regenerate message" });
      }
    } catch {
      set({ isGenerating: false, lastError: "Network error occurred" });
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

    // Shared plumbing: session guard + JSON parse for every data event.
    const on = (type: string, fn: (payload: any) => void) =>
      es.addEventListener(type, (e: any) => {
        if (get().currentSessionId !== sessionId) return;
        try {
          fn(JSON.parse(e.data));
        } catch {}
      });

    const resetStreamState = () => ({
      isGenerating: false,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
    });

    on("thought_delta", ({ delta }) =>
      set((state) => ({
        isGenerating: true,
        currentThought: state.currentThought + delta,
      }))
    );
    on("content_delta", ({ delta }) =>
      set((state) => ({
        isGenerating: true,
        currentContent: state.currentContent + delta,
      }))
    );

    on("tool_executing", (payload) => {
      set((state) => {
        if (state.activeToolCalls.some((t) => t.id === payload.id)) return { isGenerating: true };
        return {
          isGenerating: true,
          activeToolCalls: [
            ...state.activeToolCalls,
            { id: payload.id, name: payload.name, args: payload.args, status: "running" as const },
          ],
        };
      });
    });

    on("tool_observed", (payload) => {
      set((state) => {
        // Image observations arrive as a serialized envelope; render via the
        // workspace file route instead of embedding bytes in the event.
        let observation: string = payload.observation;
        let imageUrl: string | undefined;
        try {
          const parsed = JSON.parse(payload.observation);
          if (parsed && parsed.__obs__ === "image" && typeof parsed.path === "string") {
            observation = `[이미지 · ${parsed.text}]`;
            imageUrl = `/api/sessions/${sessionId}/files/${parsed.path}`;
          }
        } catch {}

        const updatedActive = state.activeToolCalls.map((t) =>
          t.id === payload.tool_call_id
            ? { ...t, status: "completed" as const, observation }
            : t
        );

        const toolMsg: Message = {
          id: `msg_tool_${payload.tool_call_id}`,
          session_id: sessionId,
          role: "tool",
          tool_call_id: payload.tool_call_id,
          name: payload.name,
          content: payload.observation,
          imageUrl,
          created_at: new Date().toISOString(),
        };

        const alreadyInMessages = state.messages.some(
          (m) => m.role === "tool" && m.tool_call_id === payload.tool_call_id
        );

        return {
          isGenerating: true,
          activeToolCalls: updatedActive,
          messages: alreadyInMessages ? state.messages : [...state.messages, toolMsg],
        };
      });
    });

    on("user_message", (payload) => {
      set((state) => {
        if (state.messages.some((m) => m.id === payload.id)) return state;

        const reconciledMsg: Message = {
          id: payload.id,
          session_id: sessionId,
          role: "user",
          content: payload.content,
          attachments: Array.isArray(payload.attachments) ? payload.attachments : undefined,
          created_at: new Date().toISOString(),
        };

        // Reconcile optimistic user message if present
        const tempIdx = state.messages.findIndex(
          (m) => m.role === "user" && (m.id.startsWith("msg_user_") || m.id === payload.id || m.content === payload.content)
        );

        if (tempIdx !== -1) {
          const next = [...state.messages];
          next[tempIdx] = reconciledMsg;
          return { messages: next };
        }

        return { messages: [...state.messages, reconciledMsg] };
      });
    });

    on("assistant_message", (payload) => {
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
    });

    on("session_updated", (payload) => {
      if (typeof payload.title === "string") {
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title: payload.title } : s)),
        }));
      }
    });

    es.addEventListener("turn_completed", () => {
      if (get().currentSessionId !== sessionId) return;
      set(resetStreamState());
      get().fetchSessions();
    });

    es.addEventListener("task_interrupted", () => {
      if (get().currentSessionId !== sessionId) return;
      set(resetStreamState());
      get().fetchSessions();
    });

    on("turn_started", () => {
      set((state) => ({
        isGenerating: true,
        activeToolCalls: [],
        lastError: state.lastError ? null : state.lastError,
      }));
    });

    // Harness failure events carry a data payload; native EventSource
    // connection errors do not (they auto-reconnect silently).
    es.addEventListener("error", (e: any) => {
      if (!e?.data) return;
      if (get().currentSessionId !== sessionId) return;
      let message = "The task failed unexpectedly.";
      try {
        message = JSON.parse(e.data).message || message;
      } catch {}
      set({
        ...resetStreamState(),
        lastError: message,
      });
    });

    set({ eventSource: es });
  },
}));
