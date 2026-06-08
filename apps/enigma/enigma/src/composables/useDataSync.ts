// Full-data "Sync" orchestrator — a call-style invite/accept that pulls a peer's entire
// dataset, treating the peer like a server (provider-wins). It rides the p2p chat's
// MLS-encrypted channel (see useChatChannel's `onSync`/`sendSync` seam): the relay only
// ever sees ciphertext.
//
// Flow (downloader D pulls from provider P, both in the same p2p room):
//   D → sync_request{syncId}        (the invite)
//   P shows it → accept/decline
//   P → sync_accept{syncId,count} → sync_data{syncId,blob}×N → sync_done{syncId}
//   D imports each blob via y_store_import (provider-wins) and reports progress.
//
// Data never leaves Rust unencrypted: P exports via y_store_export_all, D imports via
// y_store_import; only the JSON blobs traverse the (already MLS-encrypted) channel.

import { ref } from "vue";
import { nanoid } from "nanoid";
import type { ChatChannel } from "./useChatChannel";

/** `[doc, map, records]` — one collection in the export. */
export type SyncBlob = [string, string, unknown[]];

export type SyncState =
  | "idle"
  | "requesting"   // downloader: invite sent, awaiting accept
  | "incoming"     // provider: an invite arrived, awaiting our accept/decline
  | "transferring" // data flowing
  | "done"
  | "declined"
  | "error";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function useDataSync(channel: ChatChannel) {
  const state = ref<SyncState>("idle");
  const peerName = ref("");          // who we're syncing with
  const error = ref<string | null>(null);
  const received = ref(0);           // blobs applied (downloader)
  const total = ref(0);              // blobs expected (downloader)
  const importedCount = ref(0);      // records upserted (downloader)

  let mySyncId = "";        // id of the pull we initiated (downloader)
  let incomingSyncId = "";  // id of an invite we received (provider)

  function reset() {
    state.value = "idle";
    error.value = null;
    received.value = 0;
    total.value = 0;
    importedCount.value = 0;
    mySyncId = "";
    incomingSyncId = "";
    peerName.value = "";
  }

  /** Downloader: ask the peer to let us pull their full dataset. */
  async function requestPull() {
    if (!_isTauri()) { error.value = "Sync is desktop-only."; state.value = "error"; return; }
    reset();
    mySyncId = nanoid();
    state.value = "requesting";
    // In a 1:1 p2p room the only other participant is the provider.
    peerName.value = channel.participants.value.find((p) => p.name !== channel.currentUserName.value)?.name ?? "";
    try {
      await channel.sendSync("sync_request", { syncId: mySyncId, name: channel.currentUserName.value });
    } catch (e: any) {
      error.value = e?.message ?? String(e);
      state.value = "error";
    }
  }

  /** Provider: accept an incoming invite → export everything and stream it. */
  async function accept() {
    if (state.value !== "incoming" || !incomingSyncId) return;
    const sid = incomingSyncId;
    state.value = "transferring";
    try {
      const blobs = await _invoke<SyncBlob[]>("y_store_export_all");
      total.value = blobs.length;
      received.value = 0;
      await channel.sendSync("sync_accept", { syncId: sid, count: blobs.length });
      for (const blob of blobs) {
        await channel.sendSync("sync_data", { syncId: sid, blob });
        received.value += 1;
      }
      await channel.sendSync("sync_done", { syncId: sid });
      state.value = "done";
    } catch (e: any) {
      error.value = e?.message ?? String(e);
      state.value = "error";
    }
  }

  /** Provider: refuse the invite. */
  async function decline() {
    if (state.value !== "incoming") return;
    try { await channel.sendSync("sync_decline", { syncId: incomingSyncId }); } catch { /* ignore */ }
    reset();
  }

  /** Either side: abort. */
  async function cancel() {
    const sid = mySyncId || incomingSyncId;
    if (sid) try { await channel.sendSync("sync_cancel", { syncId: sid }); } catch { /* ignore */ }
    reset();
  }

  // ── incoming protocol messages (over the MLS channel) ────────────────────────
  channel.onSync(async (type, payload, sender) => {
    const sid = payload.syncId as string;
    switch (type) {
      case "sync_request":
        // Provider side: surface the invite (ignore if mid-transfer).
        if (state.value === "transferring") return;
        incomingSyncId = sid;
        peerName.value = sender;
        state.value = "incoming";
        break;
      case "sync_accept":
        if (sid !== mySyncId) return;
        total.value = (payload.count as number) ?? 0;
        received.value = 0;
        importedCount.value = 0;
        state.value = "transferring";
        break;
      case "sync_data":
        if (sid !== mySyncId) return;
        try {
          const n = await _invoke<number>("y_store_import", { blobs: [payload.blob as SyncBlob] });
          importedCount.value += n;
        } catch (e: any) {
          error.value = e?.message ?? String(e);
        }
        received.value += 1;
        break;
      case "sync_done":
        if (sid !== mySyncId) return;
        state.value = "done";
        // Tell the app to re-read the affected stores from y_store.
        window.dispatchEvent(new CustomEvent("datasync:imported"));
        break;
      case "sync_decline":
        if (sid !== mySyncId) return;
        state.value = "declined";
        break;
      case "sync_cancel":
        if (sid === mySyncId || sid === incomingSyncId) reset();
        break;
    }
  });

  return { state, peerName, error, received, total, importedCount, requestPull, accept, decline, cancel, reset };
}

export type DataSync = ReturnType<typeof useDataSync>;
