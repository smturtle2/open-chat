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

  fetchSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettingsView>) => Promise<void>;
  fetchProviders: () => Promise<void>;
  saveProvider: (draft: ProviderDraft) => Promise<{ ok: boolean; error?: string }>;
  deleteProvider: (id: string) => Promise<void>;
  testProvider: (id: string) => Promise<{ ok: boolean; model_count?: number; error?: string }>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { default_provider: "", default_model: "" },
  providers: [],
  loadingProviders: false,

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
    set({ loadingProviders: true });
    try {
      const res = await fetch("/api/providers");
      if (res.ok) set({ providers: await res.json() });
    } catch {
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
      ...(draft.api_key || !exists ? { api_key: draft.api_key } : {}),
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
      await fetch(`/api/providers/${id}`, { method: "DELETE" });
      await get().fetchProviders();
      useChatStore.getState().fetchModels().catch(() => {});
    } catch {}
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
