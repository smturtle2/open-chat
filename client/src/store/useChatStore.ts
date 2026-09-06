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
  tool_status?: { ok: boolean; exitCode?: number; timedOut?: boolean; interrupted?: boolean };
  sending?: boolean;
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
  workspace_state?: "active" | "archived" | "missing";
  created_at: string;
  updated_at: string;
}

export interface ActiveToolCall {
  id: string;
  name: string;
  args: any;
  status: "running" | "completed" | "error";
  observation?: string;
  tool_status?: Message["tool_status"];
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
  currentRunId: string | null;
  messages: Message[];
  isGenerating: boolean;
  isSubmitting: boolean;
  isStopping: boolean;
  isSessionLoading: boolean;
  connection: "connecting" | "connected" | "reconnecting";
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
  drafts: Record<string, string>;
  attachmentDrafts: Record<string, AttachmentMeta[]>;
  uploadingSessions: string[];

  // Actions
  openArtifact: (artifact: Artifact) => void;
  closeArtifact: () => void;
  setDraft: (content: string, sessionId?: string) => void;
  addFiles: (files: File[] | FileList) => Promise<void>;
  removePendingAttachment: (id: string) => void;
  setTheme: (theme: ThemePreference) => void;
  setSidebarOpen: (open: boolean) => void;
  fetchSessions: () => Promise<void>;
  fetchModels: () => Promise<void>;
  createSession: (mode?: SessionMode, workdir?: string) => Promise<string>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<boolean>;
  updateSessionTitle: (id: string, title: string) => Promise<boolean>;
  renameSession: (id: string, title: string) => Promise<boolean>;
  clearError: () => void;
  setSelectedModel: (model: string, provider?: string) => Promise<boolean>;
  sendMessage: (content: string) => Promise<boolean>;
  editMessage: (messageId: string, newContent: string) => Promise<boolean>;
  regenerateMessage: (messageId: string) => Promise<boolean>;
  stopGeneration: () => Promise<void>;
  connectSSE: (sessionId: string, afterEventId?: number) => void;
}

let selectionVersion = 0;
let sessionLoadController: AbortController | undefined;
function readDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(sessionStorage.getItem("openchat_drafts") || "{}");
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}
function saveDrafts(drafts: Record<string, string>) {
  try { sessionStorage.setItem("openchat_drafts", JSON.stringify(drafts)); } catch {}
}
async function requireOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || fallback);
  }
}
const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message !== "Failed to fetch" ? error.message : fallback;

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  currentRunId: null,
  messages: [],
  isGenerating: false,
  isSubmitting: false,
  isStopping: false,
  isSessionLoading: true,
  connection: "connecting",
  currentThought: "",
  currentContent: "",
  activeToolCalls: [],
  sidebarOpen: window.matchMedia("(min-width: 768px)").matches,
  activeArtifact: null,
  theme: readThemePreference(),
  eventSource: null,
  modelGroups: [],
  selectedProvider: localStorage.getItem("openchat_provider") || "",
  selectedModel: localStorage.getItem("openchat_model") || "",
  lastError: null,
  pendingAttachments: [],
  uploading: false,
  drafts: readDrafts(),
  attachmentDrafts: {},
  uploadingSessions: [],

  openArtifact: (artifact) => set({ activeArtifact: artifact }),
  closeArtifact: () => set({ activeArtifact: null }),
  setDraft: (content, sessionId) => {
    const id = sessionId || get().currentSessionId;
    if (!id) return;
    const drafts = { ...get().drafts, [id]: content };
    if (!content) delete drafts[id];
    saveDrafts(drafts);
    set({ drafts });
  },

  addFiles: async (files) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;
    const targetSessionId = currentSessionId;
    const list = Array.from(files).slice(0, Math.max(0, 8 - (get().attachmentDrafts[targetSessionId]?.length || 0)));
    if (list.length === 0) return;
    if (get().uploadingSessions.includes(targetSessionId)) return;
    set((state) => ({ uploading: true, uploadingSessions: [...state.uploadingSessions, targetSessionId] }));
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
    set((state) => {
      const attachments = [...(state.attachmentDrafts[targetSessionId] || []), ...added].slice(0, 8);
      return {
        attachmentDrafts: { ...state.attachmentDrafts, [targetSessionId]: attachments },
        uploadingSessions: state.uploadingSessions.filter(id => id !== targetSessionId),
        ...(state.currentSessionId === targetSessionId ? { pendingAttachments: attachments, uploading: false } : {}),
      };
    });
  },

  removePendingAttachment: (id) => {
    set((state) => {
      const attachments = state.pendingAttachments.filter((a) => a.id !== id);
      return { pendingAttachments: attachments, attachmentDrafts: { ...state.attachmentDrafts, [state.currentSessionId!]: attachments } };
    });
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
      await requireOk(res, "대화 목록을 불러오지 못했습니다.");
      const data: Session[] = await res.json();
      set({ sessions: data });

      const { currentSessionId } = get();
      if (!currentSessionId && data.length > 0) {
        await get().selectSession(data[0].id);
      } else if (data.length === 0) {
        await get().createSession();
      }
    } catch (error) { set({ isSessionLoading: false, lastError: errorText(error, "서버에 연결할 수 없습니다. 다시 시도해 주세요.") }); }
  },

  createSession: async (mode: SessionMode = "chat", workdir?: string) => {
    const version = ++selectionVersion;
    sessionLoadController?.abort();
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
        if (version === selectionVersion) set({ isSessionLoading: false, lastError: err.error || "새 대화를 만들지 못했습니다." });
        return "";
      }
      const session: Session = await res.json();
      if (version !== selectionVersion) { set(state => ({ sessions: [session, ...state.sessions] })); return session.id; }
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        currentRunId: null,
        messages: [],
        currentThought: "",
        currentContent: "",
        activeToolCalls: [],
        isGenerating: false,
        isSubmitting: false,
        isStopping: false,
        isSessionLoading: false,
        pendingAttachments: [],
        uploading: false,
        activeArtifact: null,
        lastError: null,
        sidebarOpen: window.innerWidth < 768 ? false : state.sidebarOpen,
        selectedProvider: session.provider || state.selectedProvider,
        selectedModel: session.model || state.selectedModel,
      }));
      get().connectSSE(session.id, 0);
      return session.id;
    } catch (error) {
      if (version === selectionVersion) set({ isSessionLoading: false, lastError: errorText(error, "새 대화를 만들지 못했습니다. 다시 시도해 주세요.") });
      return "";
    }
  },

  selectSession: async (id: string) => {
    const version = ++selectionVersion;
    sessionLoadController?.abort();
    sessionLoadController = new AbortController();
    const controller = sessionLoadController;
    set({ lastError: null });
    const { eventSource } = get();
    if (eventSource) {
      eventSource.close();
      set({ eventSource: null });
    }

    set({
      currentSessionId: id,
      currentRunId: null,
      messages: [],
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
      isGenerating: false,
      isSubmitting: false,
      isStopping: false,
      isSessionLoading: true,
      activeArtifact: null,
      pendingAttachments: get().attachmentDrafts[id] || [],
      uploading: get().uploadingSessions.includes(id),
    });

    try {
      const res = await fetch(`/api/sessions/${id}`, { signal: controller.signal });
      await requireOk(res, "대화를 불러오지 못했습니다. 다시 시도해 주세요.");
      const data = await res.json();

      if (get().currentSessionId !== id || version !== selectionVersion) return;

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
        if (typeof m.tool_status === "string") {
          try { msg.tool_status = JSON.parse(m.tool_status); } catch { msg.tool_status = undefined; }
        }
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
        isStopping: data.run?.status === "stopping",
        isSessionLoading: false,
        currentRunId: data.run?.id || null,
        currentThought: data.run?.thought || "",
        currentContent: data.run?.content || "",
        activeToolCalls: (data.run?.tools || []).map((tool: any) => ({ ...tool, tool_status: tool.tool_status || (typeof tool.ok === "boolean" ? { ok: tool.ok } : undefined) })),
        selectedModel: sessionModel,
        selectedProvider: sessionProvider,
      });
      if (sessionProvider) localStorage.setItem("openchat_provider", sessionProvider);
      localStorage.setItem("openchat_model", sessionModel);

      get().connectSSE(id, data.last_event_id || 0);
    } catch (error) {
      if (!controller.signal.aborted && version === selectionVersion) set({ isSessionLoading: false, lastError: errorText(error, "대화를 불러오지 못했습니다. 연결을 확인해 주세요.") });
    }
  },

  deleteSession: async (id: string) => {
    try {
      await requireOk(await fetch(`/api/sessions/${id}`, { method: "DELETE" }), "대화를 삭제하지 못했습니다.");
      const { sessions, currentSessionId } = get();
      const filtered = sessions.filter((s) => s.id !== id);
      const drafts = { ...get().drafts };
      const attachmentDrafts = { ...get().attachmentDrafts };
      delete drafts[id]; delete attachmentDrafts[id];
      saveDrafts(drafts);
      set({ sessions: filtered, drafts, attachmentDrafts });

      if (currentSessionId === id) {
        if (filtered.length > 0) {
          await get().selectSession(filtered[0].id);
        } else {
          get().eventSource?.close();
          set({ currentSessionId: null, messages: [], activeArtifact: null, eventSource: null });
          await get().createSession();
        }
      }
      return true;
    } catch (error) { set({ lastError: errorText(error, "대화를 삭제하지 못했습니다. 연결을 확인해 주세요.") }); return false; }
  },

  updateSessionTitle: async (id: string, title: string) => {
    try {
      await requireOk(await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }), "이름을 저장하지 못했습니다.");
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
      }));
      return true;
    } catch (error) { set({ lastError: errorText(error, "이름을 저장하지 못했습니다. 다시 시도해 주세요.") }); return false; }
  },

  renameSession: async (id: string, title: string) => {
    return get().updateSessionTitle(id, title);
  },

  setSelectedModel: async (model: string, provider?: string) => {
    const { currentSessionId, selectedProvider } = get();
    const nextProvider = provider ?? selectedProvider;

    // Persist to current session
    if (currentSessionId) {
      try {
        await requireOk(await fetch(`/api/sessions/${currentSessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, provider: nextProvider || null }),
        }), "모델 변경을 저장하지 못했습니다.");
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === currentSessionId ? { ...s, model, provider: nextProvider || null } : s
          ),
        }));
      } catch (error) {
        if (get().currentSessionId === currentSessionId) set({ lastError: errorText(error, "모델을 변경하지 못했습니다. 다시 시도해 주세요.") });
        return false;
      }
    }
    if (get().currentSessionId === currentSessionId) {
      set({ selectedModel: model, selectedProvider: nextProvider });
      localStorage.setItem("openchat_model", model);
      localStorage.setItem("openchat_provider", nextProvider);
    }
    return true;
  },

  sendMessage: async (content: string) => {
    const { currentSessionId, pendingAttachments, messages } = get();
    if (!currentSessionId || get().isGenerating || get().isSessionLoading || get().uploading) return false;
    const promptText = content.trim();
    if (!promptText && pendingAttachments.length === 0) return false;

    const attachmentIds = pendingAttachments.map((a) => a.id).filter(Boolean) as string[];
    const userMsgId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tempUserMsg: Message = {
      id: userMsgId,
      session_id: currentSessionId,
      role: "user",
      content: promptText || "첨부된 파일 확인 및 분석",
      attachments: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
      created_at: new Date().toISOString(),
      sending: true,
    };

    set({
      messages: [...messages, tempUserMsg],
      isGenerating: true,
      isSubmitting: true,
      isStopping: false,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
      lastError: null,
    });

    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: userMsgId, content: promptText, attachmentIds }),
      });
      await requireOk(res, "메시지를 전송하지 못했습니다.");
      set((state) => ({
        attachmentDrafts: { ...state.attachmentDrafts, [currentSessionId]: [] },
        ...(state.currentSessionId === currentSessionId ? {
          pendingAttachments: [], isSubmitting: false,
          messages: state.messages.map(m => m.id === userMsgId ? { ...m, sending: false } : m),
        } : {}),
      }));
      if (get().drafts[currentSessionId] === content) get().setDraft("", currentSessionId);
      return true;
    } catch (error) {
      if (get().currentSessionId === currentSessionId) set((state) => ({
        messages: state.messages.filter(m => m.id !== userMsgId || !m.sending),
        isGenerating: false, isSubmitting: false,
        lastError: errorText(error, "전송하지 못했습니다. 작성한 내용과 첨부는 보관되어 있습니다."),
      }));
      return false;
    }
  },

  editMessage: async (messageId: string, newContent: string) => {
    const { currentSessionId, messages } = get();
    if (!currentSessionId || !newContent.trim() || get().isGenerating) return false;

    // Keep all messages up to and including the target user message, update its content, and drop subsequent assistant turns
    const targetIdx = messages.findIndex((m) => m.id === messageId);
    const retained = targetIdx !== -1 ? messages.slice(0, targetIdx + 1) : messages;
    const updatedMessages = retained.map((m) => (m.id === messageId ? { ...m, content: newContent } : m));

    set({
      messages: updatedMessages,
      isGenerating: true,
      isSubmitting: true,
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
      await requireOk(res, "메시지를 수정하지 못했습니다.");
      if (get().currentSessionId === currentSessionId) set({ isSubmitting: false });
      return true;
    } catch (error) {
      if (get().currentSessionId === currentSessionId) set({ messages, isGenerating: false, isSubmitting: false, lastError: errorText(error, "수정하지 못해 원래 대화를 복원했습니다.") });
      return false;
    }
  },

  regenerateMessage: async (messageId: string) => {
    const { currentSessionId, messages } = get();
    if (!currentSessionId || get().isGenerating) return false;

    // Keep all messages up to and including the target user message, drop subsequent assistant turns
    const targetIdx = messages.findIndex((m) => m.id === messageId);
    const retained = targetIdx !== -1 ? messages.slice(0, targetIdx + 1) : messages;

    set({
      messages: retained,
      isGenerating: true,
      isSubmitting: true,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
      lastError: null,
    });

    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/messages/${messageId}/regenerate`, {
        method: "POST",
      });
      await requireOk(res, "답변을 다시 생성하지 못했습니다.");
      if (get().currentSessionId === currentSessionId) set({ isSubmitting: false });
      return true;
    } catch (error) {
      if (get().currentSessionId === currentSessionId) set({ messages, isGenerating: false, isSubmitting: false, lastError: errorText(error, "다시 생성하지 못해 원래 답변을 복원했습니다.") });
      return false;
    }
  },

  stopGeneration: async () => {
    const { currentSessionId } = get();
    if (!currentSessionId || get().isStopping) return;
    set({ isStopping: true });

    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/stop`, { method: "POST" });
      await requireOk(res, "중단 요청을 보내지 못했습니다.");
      const data = await res.json();
      if (get().currentSessionId === currentSessionId && data.status !== "stopping") set({ isGenerating: false, isStopping: false });
    } catch (error) {
      if (get().currentSessionId === currentSessionId) set({ isStopping: false, lastError: errorText(error, "중단 요청을 보내지 못했습니다. 다시 시도해 주세요.") });
    }
  },

  connectSSE: (sessionId: string, afterEventId = 0) => {
    const { eventSource } = get();
    if (eventSource) {
      eventSource.close();
    }

    const url = `/api/sessions/${sessionId}/events?after=${afterEventId}`;
    const es = new EventSource(url);
    es.addEventListener("open", () => {
      if (get().eventSource === es && get().currentSessionId === sessionId) set({ connection: "connected" });
    });

    // Shared plumbing: session guard + JSON parse for every data event.
    const on = (type: string, fn: (payload: any) => void) =>
      es.addEventListener(type, (e: any) => {
        if (get().currentSessionId !== sessionId) return;
        try {
          const payload = JSON.parse(e.data);
          if (payload.run_id && type !== "run_queued" && get().currentRunId && payload.run_id !== get().currentRunId) return;
          fn(payload);
        } catch {}
      });

    const resetStreamState = () => ({
      isGenerating: false,
      isSubmitting: false,
      isStopping: false,
      currentThought: "",
      currentContent: "",
      activeToolCalls: [],
    });

    on("run_queued", ({ run_id }) => set({ ...resetStreamState(), currentRunId: run_id, isGenerating: true }));
    on("run_started", ({ run_id }) => set({ currentRunId: run_id, isGenerating: true }));
    on("run_stopping", () => set({ isStopping: true }));
    on("run_finished", () => {
      set(resetStreamState());
      get().fetchSessions();
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
            ? { ...t, status: (payload.tool_status?.ok === false ? "error" : "completed") as "error" | "completed", observation, tool_status: payload.tool_status }
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
          tool_status: payload.tool_status,
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
          (m) => m.id === payload.id
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

    on("turn_completed", () => {
      set(resetStreamState());
      get().fetchSessions();
    });

    on("task_interrupted", () => {
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
      if (!e?.data) {
        if (get().eventSource === es && get().currentSessionId === sessionId) set({ connection: "reconnecting" });
        return;
      }
      if (get().currentSessionId !== sessionId) return;
      let message = "응답을 완료하지 못했습니다. 다시 시도해 주세요.";
      try {
        const payload = JSON.parse(e.data);
        if (payload.run_id && payload.run_id !== get().currentRunId) return;
        message = payload.message || message;
      } catch {}
      set({
        ...resetStreamState(),
        lastError: message,
      });
    });

    set({ eventSource: es, connection: "connecting" });
  },
}));
