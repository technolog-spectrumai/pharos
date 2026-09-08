// The one HTTP door. Everything zinnia says to the platform goes through here,
// so auth, error mapping and the base-URL rule live in exactly one place.
//
// Two of enigma's cloud.md lessons are load-bearing in this file:
//   * URL normalisation is FROZEN: lowercase scheme+host, strip trailing
//     slashes, nothing else — the normalised URL keys stored credentials, and
//     changing the rule later silently orphans every saved login.
//   * 401 anywhere means the stored session died: surface `unauthorized`, let
//     the auth store flip to logged-out. Never auto-retry a credential.
import { ApiFailure, classify } from "./errors";

export interface ApiClient {
  readonly baseUrl: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

/** Frozen — see the header before touching. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const url = new URL(trimmed); // throws on garbage — the caller shows it
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function createClient(opts: {
  baseUrl: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}): ApiClient {
  const baseUrl = normalizeServerUrl(opts.baseUrl);
  // Bind window.fetch explicitly: an unbound fetch loses `this` and throws
  // "Illegal invocation" in some webviews.
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      // Load-bearing: the subscription gate keys its JSON-vs-HTML refusal on
      // the Accept header — without it a 402 arrives as an HTML page.
      Accept: "application/json",
    };
    const token = opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new ApiFailure({ kind: "network", cause });
    }

    // Django's HTML error pages and login redirects both land here as
    // non-JSON; parse defensively and classify on status alone in that case.
    let parsed: unknown = null;
    const text = await res.text();
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (!res.ok) throw new ApiFailure(classify(res.status, parsed));
    return parsed as T;
  }

  return {
    baseUrl,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    put: (path, body) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
  };
}
