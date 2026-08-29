import { CONFIG } from "../config.js";
import { db, type ProviderModel, type ProviderRecord } from "../db/database.js";

// Provider registry: multi-endpoint LLM configuration (opencode.json-style)
// persisted in SQLite and edited through the settings UI.
//
// Resolution precedence for any request:
//   session.provider + session.model  →  settings default_provider/default_model
//   →  env-seeded bootstrap provider  →  bare CONFIG fallback.
//
// The bootstrap seed keeps pre-existing installations working: on first boot
// with an empty providers table, the legacy LLM_BASE_URL/LLM_API_KEY/LLM_MODEL
// environment values become the "opencode" provider.

import { resolveProtocol, type ProtocolType } from "./protocols.js";

export interface ResolvedEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string | null;
  protocol: ProtocolType;
}

export interface ProviderPreset {
  id: string;
  name: string;
  base_url: string;
  /** Env var names whose presence should pre-suggest the preset. */
  key_hint?: string;
}

/** Well-known OpenAI-compatible endpoints offered in the settings UI.
 *  Custom endpoints are free-form (name + base URL + key). */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "opencode", name: "OpenCode Go", base_url: "https://opencode.ai/zen/go/v1" },
  { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1" },
];

export const BOOTSTRAP_PROVIDER_ID = "opencode";

const DEFAULT_PROVIDER_KEY = "default_provider";
const DEFAULT_MODEL_KEY = "default_model";

function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `provider-${Date.now().toString(36)}`;
}

/** Create the legacy env-backed provider once, if the table is empty. */
export function seedBootstrapProvider(): void {
  // Cosmetic migration: the bootstrap entry predates the "OpenCode Go" naming.
  const existing = db.listProviders();
  const boot = existing.find((p) => p.id === BOOTSTRAP_PROVIDER_ID);
  if (boot && boot.name === "OpenCode Zen") {
    db.upsertProvider({ ...boot, name: "OpenCode Go" });
  }
  if (boot) return;

  db.upsertProvider({
    id: BOOTSTRAP_PROVIDER_ID,
    name: existing.length === 0 ? "OpenCode Go" : `${BOOTSTRAP_PROVIDER_ID} (env)`,
    base_url: CONFIG.LLM_BASE_URL,
    api_key: CONFIG.LLM_API_KEY,
    models: [],
    enabled: true,
    sort_order: existing.length === 0 ? 0 : 1000,
  });

  // First-ever boot: adopt the seeded provider as default so behavior matches
  // the previous single-provider world without any UI action.
  if (!db.getSetting(DEFAULT_PROVIDER_KEY)) {
    db.setSetting(DEFAULT_PROVIDER_KEY, BOOTSTRAP_PROVIDER_ID);
    if (CONFIG.LLM_MODEL) db.setSetting(DEFAULT_MODEL_KEY, CONFIG.LLM_MODEL);
  }
}

export function listProviders(): ProviderRecord[] {
  return db.listProviders();
}

export function getProvider(id: string): ProviderRecord | undefined {
  return db.getProvider(id);
}

export interface ProviderInput {
  name?: string;
  id?: string;
  base_url?: string;
  api_key?: string; // undefined = keep existing; "" = clear
  enabled?: boolean;
}

function normalizeModels(models: unknown): ProviderModel[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const out: ProviderModel[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const id = String((m as any).id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof (m as any).name === "string" && (m as any).name.trim() && (m as any).name !== id
      ? (m as any).name.trim()
      : undefined;
    out.push(name ? { id, name } : { id });
  }
  return out.slice(0, 1000);
}

export function createProvider(input: ProviderInput): ProviderRecord {
  const name = (input.name || "").trim() || "Untitled provider";
  let id = input.id?.trim() ? slugify(input.id) : slugify(name);
  while (db.getProvider(id)) {
    if (input.id?.trim()) throw new Error(`provider id "${id}" already exists`);
    id = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const baseUrl = (input.base_url || "").trim();
  if (!baseUrl) throw new Error("base_url is required");
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("base_url must start with http:// or https://");

  return db.upsertProvider({
    id,
    name,
    base_url: baseUrl.replace(/\/+$/, ""),
    api_key: input.api_key ?? "",
    models: [], // filled from the gateway's /models endpoint
    enabled: input.enabled ?? true,
    sort_order: 0,
  });
}

export function updateProvider(id: string, input: ProviderInput): ProviderRecord | undefined {
  const current = db.getProvider(id);
  if (!current) return undefined;

  const baseUrl = input.base_url !== undefined ? (input.base_url || "").trim().replace(/\/+$/, "") : current.base_url;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error("base_url must be an http(s) URL");

  const next = db.upsertProvider({
    ...current,
    name: input.name?.trim() || current.name,
    base_url: baseUrl,
    api_key: input.api_key === undefined ? current.api_key : input.api_key,
    enabled: input.enabled ?? current.enabled,
  });

  // Credentials or endpoint changed → drop the cached catalog so the next
  // picker refresh re-fetches from the gateway.
  if (input.api_key !== undefined || input.base_url !== undefined) modelMemory.delete(id);
  return next;
}

export function deleteProvider(id: string): boolean {
  const existed = !!db.getProvider(id);
  if (existed) db.deleteProvider(id);
  if (db.getSetting(DEFAULT_PROVIDER_KEY) === id) {
    db.setSetting(DEFAULT_PROVIDER_KEY, "");
    db.setSetting(DEFAULT_MODEL_KEY, "");
  }
  return existed;
}

// ---- app-level defaults -----------------------------------------------------

export interface AppSettings {
  default_provider: string;
  default_model: string;
}

export function getSettings(): AppSettings {
  return {
    default_provider: db.getSetting(DEFAULT_PROVIDER_KEY) || "",
    default_model: db.getSetting(DEFAULT_MODEL_KEY) || "",
  };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  if (patch.default_provider !== undefined) db.setSetting(DEFAULT_PROVIDER_KEY, patch.default_provider.trim());
  if (patch.default_model !== undefined) db.setSetting(DEFAULT_MODEL_KEY, patch.default_model.trim());
  return getSettings();
}

// ---- resolution -------------------------------------------------------------

/**
 * Resolve the endpoint a session should talk to. Falls back through session →
 * app defaults → any enabled provider → legacy env config so a request never
 * fails merely because configuration is partial.
 */
export function resolveEndpoint(opts: { provider?: string | null; model?: string | null }): ResolvedEndpoint {
  const defaults = getSettings();

  const candidates: Array<{ providerId: string | null; model: string | null }> = [
    { providerId: opts.provider || null, model: opts.model || null },
    { providerId: defaults.default_provider || null, model: opts.model || defaults.default_model || null },
  ];

  for (const cand of candidates) {
    const provider = cand.providerId ? db.getProvider(cand.providerId) : undefined;
    if (!provider || !provider.enabled || !provider.api_key) continue;
    const model = cand.model || pickDefaultModel(provider);
    if (!model) continue;
    return {
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
      model,
      providerId: provider.id,
      protocol: resolveProtocol(provider.base_url, model),
    };
  }

  // Last resort: first enabled keyed provider.
  for (const provider of db.listProviders()) {
    if (!provider.enabled || !provider.api_key) continue;
    const model = opts.model || defaults.default_model || pickDefaultModel(provider);
    if (!model) continue;
    return {
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
      model,
      providerId: provider.id,
      protocol: resolveProtocol(provider.base_url, model),
    };
  }

  // Legacy env fallback (pre-providers behavior).
  const fallbackModel = opts.model || CONFIG.LLM_MODEL;
  return {
    baseUrl: CONFIG.LLM_BASE_URL,
    apiKey: CONFIG.LLM_API_KEY,
    model: fallbackModel,
    providerId: null,
    protocol: resolveProtocol(CONFIG.LLM_BASE_URL, fallbackModel),
  };
}

function pickDefaultModel(provider: ProviderRecord): string {
  return provider.models[0]?.id ?? "";
}

// ---- merged model catalog ----------------------------------------------------

export interface ModelGroup {
  provider_id: string;
  provider_name: string;
  models: ProviderModel[];
}

/**
 * Fetch the model catalog from a gateway's OpenAI-compatible /models endpoint.
 * Providers self-describe — the user never types model ids.
 */
export async function fetchUpstreamModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    const arr = Array.isArray(data?.data) ? data.data : [];
    return normalizeModels(arr);
  } finally {
    clearTimeout(timer);
  }
}

// Per-provider in-memory cache so picker refreshes don't hammer gateways.
// The DB copy acts as the last-known-good fallback when upstream is down.
const MODEL_TTL_MS = 5 * 60_000;
const modelMemory = new Map<string, { fetchedAt: number; models: ProviderModel[] }>();

async function modelsFor(provider: ProviderRecord): Promise<ProviderModel[]> {
  const cached = modelMemory.get(provider.id);
  if (cached && Date.now() - cached.fetchedAt < MODEL_TTL_MS) return cached.models;
  try {
    const models = await fetchUpstreamModels(provider.base_url, provider.api_key);
    if (models.length > 0) {
      modelMemory.set(provider.id, { fetchedAt: Date.now(), models });
      db.upsertProvider({ ...provider, models }); // persist as fallback cache
      return models;
    }
  } catch {
    // fall through to last-known-good
  }
  if (cached) return cached.models;
  return provider.models;
}

/** Warm the catalog cache after credential changes (fire-and-forget helper). */
export function warmModelCache(id: string): void {
  const provider = db.getProvider(id);
  if (!provider?.enabled || !provider.api_key) return;
  void modelsFor(provider).catch(() => undefined);
}

/**
 * Model catalog for the unified picker: every enabled, keyed provider's
 * gateway-reported models, grouped for display. Results come from each
 * gateway's own /models endpoint with a short TTL cache; a stale DB copy
 * keeps the picker usable across upstream hiccups.
 */
export async function listModelGroups(): Promise<ModelGroup[]> {
  const groups = await Promise.all(
    db
      .listProviders()
      .filter((p) => p.enabled && p.api_key)
      .map(async (p) => ({ provider_id: p.id, provider_name: p.name, models: await modelsFor(p) }))
  );
  return groups.filter((g) => g.models.length > 0);
}

/** Verify a provider's credentials by hitting its own /models endpoint. */
export async function testProvider(id: string): Promise<{ ok: boolean; model_count?: number; error?: string }> {
  const provider = db.getProvider(id);
  if (!provider) return { ok: false, error: "provider not found" };
  try {
    const models = await fetchUpstreamModels(provider.base_url, provider.api_key);
    if (models.length > 0) {
      modelMemory.set(id, { fetchedAt: Date.now(), models });
      db.upsertProvider({ ...provider, models });
    }
    return { ok: true, model_count: models.length };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
