// Enigma API — secure-communication app. The HTTP transport, offline cache,
// auth/identity calls, shared response types and the telegraph room endpoints all
// live in Euclid's ApiBase; Enigma only adds the chat media uploads. The data
// workspace (notes/vault/kanban/events/locations/socialhub) moved to Aurora.

import {
  ApiBase,
  assertServerReachable,
  serverBase,
  uploadViaRust,
  getAuthToken,
  isTauri,
} from "euclid";

// Re-export shared types + cache/error helpers for existing call sites.
export type { Me, Health, Room, Participant } from "euclid";
export {
  countResponseCache,
  clearResponseCache,
  SERVER_OFF_ERROR,
  SILENT_NO_CACHE,
  NO_SERVER_ERROR,
} from "euclid";

class ApiService extends ApiBase {
  // ── Chat media uploads (relay rooms) ───────────────────────────────────────

  uploadAudio(slug: string, audioBlob: Blob): Promise<{ ok: boolean }> {
    return new Promise(async (resolve, reject) => {
      try { await assertServerReachable(); } catch (e) { reject(e); return; }
      const base = await serverBase();
      const token = await getAuthToken();
      const form = new FormData();
      form.append("audio", audioBlob, "recording.webm");

      const xhr = new XMLHttpRequest();
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`${xhr.status}: ${xhr.responseText}`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.open("POST", `${base}/telegraph/api/channels/${slug}/upload-audio/`);
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(form);
    });
  }

  uploadImage(
    slug: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<{ ok: boolean }> {
    return new Promise(async (resolve, reject) => {
      try { await assertServerReachable(); } catch (e) { reject(e); return; }
      if (isTauri()) {
        try {
          onProgress?.(100); // progress isn't tracked through the Rust gateway
          const text = await uploadViaRust(`/telegraph/api/channels/${slug}/upload/`, "image", file);
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
        return;
      }
      const base = await serverBase();
      const token = await getAuthToken();
      const form = new FormData();
      form.append("image", file);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`${xhr.status}: ${xhr.responseText}`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.open("POST", `${base}/telegraph/api/channels/${slug}/upload/`);
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(form);
    });
  }
}

export const api = new ApiService();
