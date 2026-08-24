export type ThemePreference = "light" | "dark" | "system";

// Single source of truth for theme application. The inline boot script in
// index.html duplicates the resolve+apply logic (it must run before first
// paint without importing modules); keep them in sync.

const STORAGE_KEY = "openchat_theme";

export function readThemePreference(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function writeThemePreference(theme: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, theme);
}

/** Resolve a preference to a concrete dark/light decision. */
export function prefersDark(theme: ThemePreference): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme: ThemePreference): void {
  document.documentElement.classList.toggle("dark", prefersDark(theme));
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", prefersDark(theme) ? "#121212" : "#ffffff");
}

/**
 * Apply the stored preference and keep following OS changes while in
 * "system" mode. Returns a cleanup function.
 */
export function initTheme(): () => void {
  applyTheme(readThemePreference());
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (readThemePreference() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
