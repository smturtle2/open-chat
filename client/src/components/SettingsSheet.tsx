import React, { useEffect, useState } from "react";
import { Check, CircleDot, Pencil, Plus, Trash2, Zap, Globe, Sparkles, Boxes, Sun, Moon, Monitor, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { BottomSheet } from "./BottomSheet";
import { useChatStore } from "../store/useChatStore";
import { useSettingsStore, type ProviderDraft, type ProviderView } from "../store/useSettingsStore";
import type { ThemePreference } from "../theme";
import { isLocalProviderUrl } from "../providerUrl";

// Settings sheet: two sections (외모 / 프로바이더).
// Providers are preset-driven (OpenCode Go / OpenRouter / Custom); their model
// catalogs are fetched from each gateway's /models endpoint automatically.

type Section = "appearance" | "providers";

const SECTION_LABELS: Record<Section, string> = {
  appearance: "화면",
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
    <BottomSheet title="설정" description="테마와 사용할 모델을 관리하세요." onClose={onClose}>
      <div className="pb-4" data-settings-sheet>
        {/* Section tabs */}
        <div className="flex gap-1 px-5 pb-4 sticky top-0 bg-[var(--surface)] z-10" role="group" aria-label="설정 항목">
          {(Object.keys(SECTION_LABELS) as Section[]).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              aria-pressed={section === s}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                section === s
                  ? "bg-[var(--accent-soft)] text-indigo-700 dark:text-indigo-200"
                  : "text-muted hover:bg-[var(--surface-soft)]"
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
    <div className="px-5 sm:px-6 py-6">
      <h3 className="text-sm font-semibold">테마</h3>
      <p className="text-sm text-muted mt-1 mb-5">편안하게 읽을 수 있는 화면을 선택하세요.</p>
      <div className="grid grid-cols-3 gap-3">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            aria-pressed={theme === opt.value}
            className={`relative p-2 sm:p-3 rounded-2xl border text-sm font-medium transition-colors cursor-pointer ${
              theme === opt.value
                ? "border-indigo-500 bg-[var(--accent-soft)] text-indigo-700 dark:text-indigo-200 ring-1 ring-indigo-500"
                : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500"
            }`}
          >
            <div aria-hidden="true" className={`h-20 sm:h-24 rounded-lg mb-3 border overflow-hidden flex ${opt.value === "dark" ? "bg-[#171a21] border-[#303541]" : opt.value === "light" ? "bg-white border-zinc-200" : "bg-linear-to-r from-white from-50% to-[#171a21] to-50% border-zinc-300"}`}>
              <div className={`w-1/4 h-full border-r ${opt.value === "dark" ? "bg-[#232731] border-[#303541]" : "bg-zinc-100 border-zinc-200"}`} />
              <div className="flex-1 p-2.5 space-y-1.5"><div className="h-1.5 w-3/4 rounded bg-indigo-300/60" /><div className="h-1 w-full rounded bg-zinc-400/40" /><div className="h-1 w-2/3 rounded bg-zinc-400/40" /><div className="h-4 mt-3 rounded border border-zinc-400/30" /></div>
            </div>
            <span className="flex items-center justify-center gap-1.5">{opt.value === "light" ? <Sun className="size-4" /> : opt.value === "dark" ? <Moon className="size-4" /> : <Monitor className="size-4" />}{opt.label}</span>
            {theme === opt.value && <Check className="absolute top-1.5 right-1.5 size-5 p-0.5 rounded-full bg-indigo-600 text-white" />}
          </button>
        ))}
      </div>
      <p className="pt-4 text-xs text-muted">{theme === "system" ? "기기의 화면 설정에 따라 자동으로 전환됩니다." : "선택한 테마가 바로 적용됩니다."}</p>
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
  const loading = useSettingsStore(st => st.loadingProviders);
  const loadError = useSettingsStore(st => st.providersError);
  const updatedAt = useSettingsStore(st => st.providersUpdatedAt);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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
    if (res.ok) {
      await fetchProviders();
    }
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
    <div className="px-5 sm:px-6 py-5">
      <div className="flex items-center justify-between gap-3 pb-4">
        <h3 className="text-sm font-semibold">
          연결된 프로바이더 {providers.length > 0 && `(${providers.length})`}
        </h3>
        <button
          onClick={() =>
            setEditor({
              open: true,
              draft: { preset: "opencode", name: "OpenCode Go", base_url: "", api_key: "", enabled: true },
            })
          }
          className="ui-button ui-button-primary shrink-0"
        >
          <Plus className="size-4" />
          추가
        </button>
      </div>

      {loadError && <div role="alert" className="text-sm text-rose-600 dark:text-rose-400 mb-4 flex items-center gap-2"><span className="flex-1">{loadError}</span><button className="ui-icon-button" title="다시 불러오기" onClick={fetchProviders}><RefreshCw className="size-4" /></button></div>}
      {loading && providers.length === 0 ? <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted"><Loader2 className="size-4 animate-spin" />프로바이더를 불러오는 중…</div> : providers.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-zinc-400">
          아직 프로바이더가 없습니다. 추가 버튼으로 연결해 주세요.
        </p>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => (
            <div
              key={p.id}
              className="rounded-2xl border border-[var(--border)] p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <CircleDot
                      className={`w-3 h-3 flex-shrink-0 ${p.enabled && (p.has_key || isLocalProviderUrl(p.base_url)) ? "text-emerald-500" : "text-zinc-400"}`}
                    />
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{p.name}</span>
                  </div>
                  <div className="text-xs text-muted truncate mt-1" title={p.base_url}>{p.base_url}</div>
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted"><span className="rounded-md bg-[var(--surface-soft)] px-1.5 py-0.5">{!p.enabled ? "비활성" : p.has_key || isLocalProviderUrl(p.base_url) ? "활성" : "API 키 필요"}</span><span>{p.models.length}개 모델</span></div>
                  {testResult[p.id] && (
                    <div role="status" className={`text-xs mt-2 break-words ${testResult[p.id].startsWith("연결 성공") ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}`}>
                      {testResult[p.id]}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={() => handleTest(p)}
                    disabled={testingId === p.id}
                    title="연결 테스트 · 모델 목록 갱신"
                    className="ui-icon-button"
                  >
                    <Zap className={`w-3.5 h-3.5 ${testingId === p.id ? "animate-pulse" : ""}`} />
                  </button>
                  <button
                    onClick={() => setEditor({ open: true, draft: draftFor(p) })}
                    title="편집"
                    className="ui-icon-button"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDeletingId(p.id)}
                    title="삭제"
                    className="ui-icon-button hover:text-rose-500!"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {deletingId === p.id && <div className="mt-3 pt-3 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-3"><span className="text-sm">이 연결을 삭제할까요?</span><div className="flex gap-2"><button className="ui-button" disabled={deleting} onClick={() => setDeletingId(null)}>취소</button><button className="ui-button ui-button-danger" disabled={deleting} onClick={async () => { setDeleting(true); const result = await deleteProvider(p.id); setDeleting(false); if (result.ok) setDeletingId(null); else setTestResult(prev => ({ ...prev, [p.id]: result.error || "삭제 실패" })); }}>{deleting ? "삭제 중…" : "삭제"}</button></div></div>}
            </div>
          ))}
        </div>
      )}
      <p className="pt-4 text-xs leading-relaxed text-muted">
        연결 테스트로 모델 목록을 갱신할 수 있습니다.{updatedAt && ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 갱신`}
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
  const isLocal = isLocalProviderUrl(form.base_url);
  const canSave = (isCustom ? form.name.trim() && form.base_url.trim() : true) && (isEditing || isLocal || form.api_key.trim());

  const inputCls =
    "ui-field";

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
    <div className="px-5 sm:px-6 py-5 space-y-5">
      <button className="inline-flex items-center gap-1.5 text-sm text-muted cursor-pointer hover:text-[var(--ink)]" onClick={onDone}><ArrowLeft className="size-4" />프로바이더 목록</button>
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
                ? "border-indigo-500 bg-[var(--accent-soft)] text-indigo-700 dark:text-indigo-200"
                : "border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500"
            }`}
          >
            {card.icon}
            <span>{card.label}</span>
            {!isEditing && form.preset === card.key && (
              <span className="text-[11px] font-normal opacity-80">{card.hint}</span>
            )}
          </button>
        ))}
      </div>

      {isCustom && (
        <>
          <div>
            <label htmlFor="provider-name" className="block text-sm font-medium pb-2">이름</label>
            <input
              id="provider-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="예: 사내 게이트웨이"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="provider-url" className="block text-sm font-medium pb-2">API 주소</label>
            <input
              id="provider-url"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="https://api.example.com/v1"
              className={`${inputCls} font-mono`}
            />
          </div>
        </>
      )}

      <div>
        <label htmlFor="provider-key" className="block text-sm font-medium pb-2">
          API 키{isLocal && <span className="ml-1 text-muted font-normal">(선택)</span>}
        </label>
        <input
          id="provider-key"
          type="password"
          value={form.api_key}
          onChange={(e) => setForm({ ...form, api_key: e.target.value, clear_key: false })}
          placeholder={isEditing ? "새 키를 입력하면 변경됩니다" : "프로바이더의 API 키"}
          className={`${inputCls} font-mono`}
          autoComplete="off"
        />
        {isEditing && <p className="text-xs text-muted mt-2">비워 두면 저장된 키를 유지합니다.</p>}
        {isEditing && <label className="flex items-center gap-2 mt-3 text-xs text-muted cursor-pointer"><input type="checkbox" className="size-4 accent-indigo-600" checked={!!form.clear_key} onChange={e => setForm({ ...form, clear_key: e.target.checked, api_key: "" })} />저장된 키 삭제</label>}
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          className="size-4 accent-indigo-600"
        />
        <span className="text-sm">모델 선택 목록에서 사용</span>
      </label>

      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onDone}
          className="ui-button"
        >
          취소
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="ui-button ui-button-primary"
        >
          <Check className="w-3.5 h-3.5" />
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </div>
  );
};
