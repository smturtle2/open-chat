import React, { useEffect, useState } from "react";
import { Check, CircleDot, Pencil, Plus, Trash2, Zap, Globe, Sparkles, Boxes } from "lucide-react";
import { BottomSheet } from "./BottomSheet";
import { useChatStore } from "../store/useChatStore";
import { useSettingsStore, type ProviderDraft, type ProviderView } from "../store/useSettingsStore";
import type { ThemePreference } from "../theme";

// Settings sheet: two sections (외모 / 프로바이더).
// Providers are preset-driven (OpenCode Go / OpenRouter / Custom); their model
// catalogs are fetched from each gateway's /models endpoint automatically.

type Section = "appearance" | "providers";

const SECTION_LABELS: Record<Section, string> = {
  appearance: "외모",
  providers: "프로바이더",
};

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
  { value: "system", label: "시스템" },
];

export const SettingsSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [section, setSection] = useState<Section>("appearance");

  return (
    <BottomSheet onClose={onClose}>
      <div className="pb-4" data-settings-sheet>
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-2">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">설정</h2>
        </div>

        {/* Section tabs */}
        <div className="flex gap-1 px-4 pb-2">
          {(Object.keys(SECTION_LABELS) as Section[]).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                section === s
                  ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {SECTION_LABELS[s]}
            </button>
          ))}
        </div>

        <div className="border-t border-zinc-100 dark:border-zinc-800">
          {section === "appearance" ? <AppearanceSection /> : <ProvidersSection />}
        </div>
      </div>
    </BottomSheet>
  );
};

// ------------------------------------------------------------------ 외모

const AppearanceSection: React.FC = () => {
  const theme = useChatStore((st) => st.theme);
  const setTheme = useChatStore((st) => st.setTheme);

  return (
    <div className="px-5 py-4">
      <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wide pb-2">테마</h3>
      <div className="grid grid-cols-3 gap-2">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            className={`py-2.5 rounded-xl border text-sm font-medium transition-colors cursor-pointer ${
              theme === opt.value
                ? "border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900"
                : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {theme === "system" && (
        <p className="pt-2 text-[11px] text-zinc-400">OS 설정에 따라 자동으로 전환됩니다.</p>
      )}
    </div>
  );
};

// ------------------------------------------------------------ 프로바이더

type EditorState =
  | { open: false }
  | { open: true; draft: ProviderDraft };

const ProvidersSection: React.FC = () => {
  const providers = useSettingsStore((st) => st.providers);
  const fetchProviders = useSettingsStore((st) => st.fetchProviders);
  const deleteProvider = useSettingsStore((st) => st.deleteProvider);
  const testProviderFn = useSettingsStore((st) => st.testProvider);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleTest = async (p: ProviderView) => {
    setTestingId(p.id);
    const res = await testProviderFn(p.id);
    setTestResult((prev) => ({
      ...prev,
      [p.id]: res.ok ? `연결 성공${res.model_count !== undefined ? ` · ${res.model_count}개 모델` : ""}` : `실패: ${res.error}`,
    }));
    setTestingId(null);
  };

  /** Draft for editing an existing provider; preset inferred from its id/URL. */
  const draftFor = (p: ProviderView): ProviderDraft => ({
    id: p.id,
    preset: p.id === "opencode" ? "opencode" : p.id === "openrouter" ? "openrouter" : "custom",
    name: p.name,
    base_url: p.base_url,
    api_key: "",
    enabled: p.enabled,
  });

  if (editor.open) {
    return <ProviderEditor draft={editor.draft} onDone={() => setEditor({ open: false })} />;
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between pb-2">
        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wide px-1">
          연결된 프로바이더 {providers.length > 0 && `(${providers.length})`}
        </h3>
        <button
          onClick={() =>
            setEditor({
              open: true,
              draft: { preset: "opencode", name: "OpenCode Go", base_url: "", api_key: "", enabled: true },
            })
          }
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[11px] font-medium hover:opacity-85 transition-opacity cursor-pointer"
        >
          <Plus className="w-3 h-3" />
          추가
        </button>
      </div>

      {providers.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-zinc-400">
          아직 프로바이더가 없습니다. 추가 버튼으로 연결해 주세요.
        </p>
      ) : (
        <div className="space-y-1.5">
          {providers.map((p) => (
            <div
              key={p.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-700/80 px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <CircleDot
                      className={`w-3 h-3 flex-shrink-0 ${p.enabled && p.has_key ? "text-emerald-500" : "text-zinc-300 dark:text-zinc-600"}`}
                    />
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{p.name}</span>
                    <span className="text-[10px] font-mono text-zinc-400 flex-shrink-0">{p.models.length}개 모델</span>
                  </div>
                  <div className="pl-[18px] text-[11px] font-mono text-zinc-400 truncate">{p.base_url}</div>
                  {testResult[p.id] && (
                    <div className={`pl-[18px] text-[11px] ${testResult[p.id].startsWith("연결 성공") ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}`}>
                      {testResult[p.id]}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={() => handleTest(p)}
                    disabled={testingId === p.id}
                    title="연결 테스트 · 모델 목록 갱신"
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Zap className={`w-3.5 h-3.5 ${testingId === p.id ? "animate-pulse" : ""}`} />
                  </button>
                  <button
                    onClick={() => setEditor({ open: true, draft: draftFor(p) })}
                    title="편집"
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`프로바이더 "${p.name}"을(를) 삭제할까요?`)) deleteProvider(p.id);
                    }}
                    title="삭제"
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="pt-2 px-1 text-[10.5px] leading-relaxed text-zinc-400">
        모델 목록은 각 게이트웨이에서 자동으로 가져옵니다.
      </p>
    </div>
  );
};

// --------------------------------------------------------- 프로바이더 편집 폼

const PRESET_CARDS: Array<{
  key: ProviderDraft["preset"];
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  { key: "opencode", label: "OpenCode Go", hint: "opencode.ai 게이트웨이", icon: <Sparkles className="w-4 h-4" /> },
  { key: "openrouter", label: "OpenRouter", hint: "openrouter.ai", icon: <Globe className="w-4 h-4" /> },
  { key: "custom", label: "커스텀", hint: "직접 URL 입력", icon: <Boxes className="w-4 h-4" /> },
];

const PRESET_DEFAULT_NAMES: Record<ProviderDraft["preset"], string> = {
  opencode: "OpenCode Go",
  openrouter: "OpenRouter",
  custom: "",
};

const ProviderEditor: React.FC<{ draft: ProviderDraft; onDone: () => void }> = ({ draft, onDone }) => {
  const saveProvider = useSettingsStore((st) => st.saveProvider);
  const [form, setForm] = useState<ProviderDraft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!form.id;
  const isCustom = form.preset === "custom";
  const canSave = (isCustom ? form.name.trim() && form.base_url.trim() : true) && (isEditing || form.api_key.trim());

  const inputCls =
    "w-full bg-zinc-50 dark:bg-zinc-900 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 outline-none focus:border-zinc-400 dark:focus:border-zinc-500";

  const pickPreset = (key: ProviderDraft["preset"]) => {
    if (!isEditing) {
      setForm({ ...form, preset: key, name: PRESET_DEFAULT_NAMES[key], base_url: "" });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const res = await saveProvider(form);
    setSaving(false);
    if (res.ok) onDone();
    else setError(res.error || "저장 실패");
  };

  return (
    <div className="px-4 py-3 space-y-3">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {isEditing ? "프로바이더 편집" : "프로바이더 추가"}
      </h3>

      {/* Preset selection — fixed once created */}
      <div className="grid grid-cols-3 gap-2">
        {PRESET_CARDS.map((card) => (
          <button
            key={card.key}
            onClick={() => pickPreset(card.key)}
            disabled={isEditing}
            className={`flex flex-col items-center gap-1 py-3 rounded-xl border text-xs font-medium transition-colors ${
              isEditing ? "cursor-default opacity-70" : "cursor-pointer"
            } ${
              form.preset === card.key
                ? "border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900"
                : "border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500"
            }`}
          >
            {card.icon}
            <span>{card.label}</span>
            {!isEditing && form.preset === card.key && (
              <span className="text-[9px] opacity-70 font-normal">{card.hint}</span>
            )}
          </button>
        ))}
      </div>

      {isCustom && (
        <>
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 pb-1">이름</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="예: 사내 게이트웨이"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 pb-1">Base URL (OpenAI 호환)</label>
            <input
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="https://api.example.com/v1"
              className={`${inputCls} font-mono text-xs`}
            />
          </div>
        </>
      )}

      <div>
        <label className="block text-[11px] font-medium text-zinc-500 pb-1">
          API 키{isEditing && " (비우면 기존 키 유지)"}
        </label>
        <input
          type="password"
          value={form.api_key}
          onChange={(e) => setForm({ ...form, api_key: e.target.value })}
          placeholder={isEditing ? "••••••••" : "sk-..."}
          className={`${inputCls} font-mono text-xs`}
          autoComplete="off"
        />
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          className="accent-zinc-900 dark:accent-zinc-100"
        />
        <span className="text-sm text-zinc-600 dark:text-zinc-300">사용함</span>
      </label>

      {error && <p className="text-xs text-rose-500">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onDone}
          className="px-4 py-2 rounded-xl text-sm text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          취소
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium hover:opacity-85 transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check className="w-3.5 h-3.5" />
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </div>
  );
};
