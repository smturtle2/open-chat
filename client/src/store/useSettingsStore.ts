import { create } from "zustand";
import { useChatStore } from "./useChatStore";

// Settings-domain state: app preferences + provider CRUD. Kept separate from
// useChatStore so conversation state stays untouched by configuration work.

export interface ProviderView {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  models: Array<{ id: string; name?: string }>;
  has_key: boolean;
  key_hint: string;
}

export interface AppSettingsView {
  default_provider: string;
  default_model: string;
}

export interface ProviderDraft {
  id?: string; // present = editing existing
  /** Which well-known endpoint this is; "custom" exposes the base URL field. */
  preset: "opencode" | "openrouter" | "custom";
  name: string;
  base_url: string;
  api_key: string; // empty = keep existing key on edit
  enabled: boolean;
  clear_key?: boolean;
}

/** Fixed endpoints for the well-known presets (mirrors src/agent/providers.ts). */
export const PRESET_URLS: Record<"opencode" | "openrouter", string> = {
  opencode: "https://opencode.ai/zen/go/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

interface SettingsState {
  settings: AppSettingsView;
  providers: ProviderView[];
  loadingProviders: boolean;
  providersError: string | null;
  providersUpdatedAt: number | null;

  fetchSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettingsView>) => Promise<void>;
  fetchProviders: () => Promise<void>;
  saveProvider: (draft: ProviderDraft) => Promise<{ ok: boolean; error?: string }>;
  deleteProvider: (id: string) => Promise<{ ok: boolean; error?: string }>;
  testProvider: (id: string) => Promise<{ ok: boolean; model_count?: number; error?: string }>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { default_provider: "", default_model: "" },
  providers: [],
  loadingProviders: false,
  providersError: null,
  providersUpdatedAt: null,

  fetchSettings: async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) set({ settings: await res.json() });
    } catch {}
  },

  saveSettings: async (patch) => {
    set((state) => ({ settings: { ...state.settings, ...patch } }));
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) set({ settings: await res.json() });
    } catch {}
  },

  fetchProviders: async () => {
    set({ loadingProviders: true, providersError: null });
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("프로바이더 목록을 불러오지 못했습니다.");
      set({ providers: await res.json(), providersUpdatedAt: Date.now() });
    } catch {
      set({ providersError: "프로바이더 목록을 불러오지 못했습니다. 다시 시도해 주세요." });
    } finally {
      set({ loadingProviders: false });
    }
  },

  saveProvider: async (draft) => {
    const providers = get().providers;
    // Preset instances own their well-known id so re-saving updates in place.
    const targetId = draft.id ?? (draft.preset !== "custom" ? draft.preset : undefined);
    const exists = !!targetId && providers.some((p) => p.id === targetId);
    const body = {
      ...(exists ? {} : { id: targetId }),
      name: draft.name,
      base_url: draft.preset === "custom" ? draft.base_url : PRESET_URLS[draft.preset],
      enabled: draft.enabled,
      // Empty api_key on update means "keep the stored key".
      ...(draft.clear_key ? { api_key: "" } : draft.api_key || !exists ? { api_key: draft.api_key } : {}),
    };
    try {
      const res = await fetch(exists ? `/api/providers/${targetId}` : "/api/providers", {
        method: exists ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "저장 실패" }));
        return { ok: false, error: err.error || "저장 실패" };
      }
      await get().fetchProviders();
      useChatStore.getState().fetchModels().catch(() => {});
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || "저장 실패" };
    }
  },

  deleteProvider: async (id) => {
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
      if (!res.ok) return { ok: false, error: "프로바이더를 삭제하지 못했습니다." };
      await get().fetchProviders();
      useChatStore.getState().fetchModels().catch(() => {});
      return { ok: true };
    } catch { return { ok: false, error: "서버에 연결할 수 없습니다. 다시 시도해 주세요." }; }
  },

  testProvider: async (id) => {
    try {
      const res = await fetch(`/api/providers/${id}/test`, { method: "POST" });
      return await res.json();
    } catch (err: any) {
      return { ok: false, error: err?.message || "테스트 실패" };
    }
  },
}));
