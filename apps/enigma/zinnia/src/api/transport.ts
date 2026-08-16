// How the API client reaches the server.
//
// It cannot use the webview's `fetch`. The session token lives in the OS secret
// store and is never handed to JavaScript — that is the whole point of the sign
// -in design — so nothing here can build an `Authorization` header. Rust makes
// the call and attaches it.
//
// `createClient` already takes a `fetchImpl`, so this slots in underneath the
// typed layer without changing a line of it: `errors.ts`'s status→kind
// taxonomy and `vault.ts`'s DTOs work exactly as they do over a real fetch.
import type { CloudSettings } from "../cloud/cloudSettings";

interface ApiReply {
  status: number;
  body: string;
}

/** The Tauri bridge, imported once.
 *
 *  Cached rather than imported per request: two calls in flight at the same
 *  time — which is the normal case, since a refresh fetches the files and the
 *  folder tree together — would otherwise each start their own module load. */
let bridgePromise: Promise<typeof import("@tauri-apps/api/core")> | null = null;
function bridge() {
  bridgePromise ??= import("@tauri-apps/api/core");
  return bridgePromise;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** A `fetch` that goes through Rust.
 *
 *  The path is taken from the URL rather than passed through whole: Rust owns
 *  the base address (it is the key the token is filed under) and refuses paths
 *  outside its allowlist, so handing it a full URL would invite a caller to
 *  point it somewhere else. */
export function tauriFetch(settings: () => CloudSettings): typeof fetch {
  return async (input, init) => {
    if (!isTauri()) throw new Error("desktop_only: the platform needs the desktop app");
    const { server, fingerprint } = settings();
    const url = typeof input === "string" ? input : String(input);
    // `client.ts` builds `${baseUrl}${path}`; recover the path, so a change of
    // base cannot smuggle a host into the part Rust checks.
    const path = url.startsWith(server) ? url.slice(server.length) : new URL(url).pathname;

    const { invoke } = await bridge();
    const reply = await invoke<ApiReply>("cloud_request", {
      serverUrl: server,
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      fingerprint: fingerprint || null,
    });

    // A real Response, so the client above parses and classifies it the same
    // way it would a network one — one code path, not two.
    return new Response(reply.body, {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
