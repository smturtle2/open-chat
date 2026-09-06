import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((update: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
