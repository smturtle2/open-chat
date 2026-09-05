import React, { lazy, Suspense, useEffect, useState } from "react";
import { useChatStore } from "../store/useChatStore";

const App = lazy(() => import("../App").then((module) => ({ default: module.App })));

export function AuthGate() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/auth").then((response) => response.json()).then((data) => {
      if (active) setAuthenticated(!!data.authenticated);
    }).catch(() => { if (active) { setAuthenticated(false); setError("서버에 연결할 수 없습니다."); } });
    const requireAuth = () => {
      useChatStore.getState().eventSource?.close();
      useChatStore.setState({ eventSource: null, currentSessionId: null, currentRunId: null, messages: [], sessions: [], activeArtifact: null, currentThought: "", currentContent: "", activeToolCalls: [], pendingAttachments: [], isGenerating: false });
      setAuthenticated(false);
      setToken("");
    };
    window.addEventListener("openchat:auth-required", requireAuth);
    return () => { active = false; window.removeEventListener("openchat:auth-required", requireAuth); };
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const data = await response.json();
      if (!response.ok) setError(data.error || "로그인할 수 없습니다.");
      else { setToken(""); setAuthenticated(true); }
    } catch { setError("서버에 연결할 수 없습니다."); }
    finally { setBusy(false); }
  }

  const loading = <div className="h-full flex items-center justify-center text-sm text-zinc-500">불러오는 중…</div>;
  if (authenticated === null) return loading;
  if (authenticated) return <Suspense fallback={loading}><App /></Suspense>;
  return <div className="h-full flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6 text-zinc-900 dark:text-zinc-100">
    <form onSubmit={login} className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-7 shadow-sm">
      <div><h1 className="text-xl font-semibold">OpenChat</h1><p className="mt-2 text-sm text-zinc-500">접속 키를 입력해 주세요.</p></div>
      <label className="block text-sm">접속 키
        <input type="password" autoComplete="current-password" autoFocus required value={token} onChange={(e) => setToken(e.target.value)}
          className="mt-2 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500" />
      </label>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy ? "접속 중…" : "접속"}</button>
    </form>
  </div>;
}
