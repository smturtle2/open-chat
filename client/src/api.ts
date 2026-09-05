export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 && !String(input).startsWith("/api/auth")) {
    window.dispatchEvent(new Event("openchat:auth-required"));
  }
  return response;
}
