export function isLocalProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return ["localhost", "[::1]", "0.0.0.0"].includes(url.hostname) ||
      (/^127(?:\.\d{1,3}){3}$/.test(url.hostname) && url.hostname.split(".").every(part => Number(part) <= 255));
  } catch { return false; }
}
