// Runtime detection + lazy invoke bridge for the Tauri desktop/mobile runtime.
//
// In a plain browser (Vite dev server / web build) and under vitest (jsdom) the
// Tauri internals are absent, so `isTauri()` returns false and callers fall back
// to a browser implementation. The `invoke` import is lazy so Vite does not choke
// during tree-shaking when Tauri is not present.

export function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}
