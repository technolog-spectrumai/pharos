// P2P file-sharing orchestrator — a call-style offer/accept that streams a single file
// directly between two peers over iroh QUIC (see the Rust `file_xfer` backend). It mirrors
// the data-sync flow (useDataSync) for the signaling: the offer/accept/decline handshake
// rides the p2p chat's MLS-encrypted channel via the channel's `onSync`/`sendSync` seam,
// so the relay only ever sees ciphertext. The file bytes themselves never touch the chat —
// they stream point-to-point over a dedicated QUIC connection (iroh TLS, node-id auth).
//
// Flow (host H offers a file to recipient R, both in the same p2p room):
//   H picks a file → file_offer_create → { offerId, addr, name, size, mime }
//   H → file_offer{offerId, target: R, addr, name, size, mime}   (the invite, addressed to R)
//   R shows it (Files tab) → accept/decline
//   R accept  → pick a save location → file_download(addr, offerId, dest) → streams to disk
//   R decline → file_decline{offerId}
//   Progress on both sides arrives via the `file://*` backend events.

import { ref } from "vue";
import type { ChatChannel } from "rakotis";

export type FileShareState =
  | "idle"
  | "offering"     // host: offer sent, awaiting the peer's response
  | "incoming"     // recipient: an offer arrived, awaiting our accept/decline
  | "transferring" // bytes flowing (either direction)
  | "done"
  | "declined"
  | "error";

export type FileShareDirection = "send" | "recv" | "";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

interface OfferCreated {
  offer_id: string;
  addr: string;
  name: string;
  size: number;
  mime: string;
}

export function useFileShare(channel: ChatChannel) {
  const available = _isTauri();

  const state = ref<FileShareState>("idle");
  const peerName = ref("");           // who we're sending to / receiving from
  const fileName = ref("");
  const fileSize = ref(0);
  const progress = ref(0);            // 0..1
  const direction = ref<FileShareDirection>("");
  const error = ref<string | null>(null);

  // Host side: the offer we are currently serving.
  let myOfferId = "";
  // Recipient side: the offer we received.
  let incomingOfferId = "";
  let incomingAddr = "";

  function reset() {
    state.value = "idle";
    peerName.value = "";
    fileName.value = "";
    fileSize.value = 0;
    progress.value = 0;
    direction.value = "";
    error.value = null;
    myOfferId = "";
    incomingOfferId = "";
    incomingAddr = "";
  }

  // ── backend transfer events (file://progress|done|error) ─────────────────────
  let listening = false;
  async function ensureListeners(): Promise<void> {
    if (listening || !available) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ offerId: string; dir: string; transferred: number; total: number }>(
      "file://progress",
      (e) => {
        if (e.payload.offerId !== myOfferId && e.payload.offerId !== incomingOfferId) return;
        direction.value = e.payload.dir === "send" ? "send" : "recv";
        progress.value = e.payload.total ? e.payload.transferred / e.payload.total : 0;
        if (state.value === "offering" || state.value === "incoming") state.value = "transferring";
      },
    );
    await listen<{ offerId: string; dir: string }>("file://done", (e) => {
      if (e.payload.offerId !== myOfferId && e.payload.offerId !== incomingOfferId) return;
      progress.value = 1;
      state.value = "done";
      if (myOfferId) void _invoke("file_offer_cancel", { offerId: myOfferId }).catch(() => {});
    });
    await listen<{ offerId: string; message: string }>("file://error", (e) => {
      if (e.payload.offerId !== myOfferId && e.payload.offerId !== incomingOfferId) return;
      error.value = e.payload.message || "Transfer failed.";
      state.value = "error";
    });
  }

  /** Host: pick a file and offer it to a *specific* peer (addressed by MLS id). */
  async function offer(target: { id: string; name: string }) {
    if (!available) { error.value = "File sharing is desktop-only."; state.value = "error"; return; }
    if (!target?.id) { error.value = "Pick someone to send to."; state.value = "error"; return; }
    error.value = null;
    try {
      await ensureListeners();
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, directory: false });
      if (typeof path !== "string" || !path) return; // user cancelled
      const meta = await _invoke<OfferCreated>("file_offer_create", { path });
      reset();
      myOfferId = meta.offer_id;
      peerName.value = target.name;
      fileName.value = meta.name;
      fileSize.value = meta.size;
      direction.value = "send";
      state.value = "offering";
      await channel.sendSync("file_offer", {
        offerId: meta.offer_id,
        target: target.id,
        addr: meta.addr,
        name: meta.name,
        size: meta.size,
        mime: meta.mime,
        fromName: channel.currentUserName.value,
      });
    } catch (e: any) {
      error.value = e?.message ?? String(e);
      state.value = "error";
    }
  }

  /** Recipient: accept → choose a save location and pull the file. */
  async function accept() {
    if (state.value !== "incoming" || !incomingOfferId) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({ defaultPath: fileName.value || undefined });
      if (!dest) return; // user cancelled the save dialog — stay on the offer
      await channel.sendSync("file_accept", { offerId: incomingOfferId });
      direction.value = "recv";
      progress.value = 0;
      state.value = "transferring";
      await _invoke("file_download", { addr: incomingAddr, offerId: incomingOfferId, dest });
    } catch (e: any) {
      error.value = e?.message ?? String(e);
      state.value = "error";
    }
  }

  /** Recipient: refuse the offer. */
  async function decline() {
    if (state.value !== "incoming") return;
    try { await channel.sendSync("file_decline", { offerId: incomingOfferId }); } catch { /* ignore */ }
    reset();
  }

  /** Host: stop offering before it's accepted. */
  async function cancel() {
    if (myOfferId) {
      try { await channel.sendSync("file_cancel", { offerId: myOfferId }); } catch { /* ignore */ }
      void _invoke("file_offer_cancel", { offerId: myOfferId }).catch(() => {});
    } else if (incomingOfferId) {
      try { await channel.sendSync("file_decline", { offerId: incomingOfferId }); } catch { /* ignore */ }
    }
    reset();
  }

  // ── incoming signaling (over the MLS channel) ────────────────────────────────
  channel.onSync(async (type, payload, sender) => {
    if (!type.startsWith("file_")) return; // not ours (data sync owns `sync_*`)
    const offerId = payload.offerId as string;
    switch (type) {
      case "file_offer":
        // Recipient side: only act if addressed to us (multi-party rooms broadcast).
        if (payload.target && payload.target !== channel.mlsIdentity.value) return;
        if (state.value === "offering" || state.value === "transferring") return; // busy
        void ensureListeners();
        incomingOfferId = offerId;
        incomingAddr = (payload.addr as string) ?? "";
        peerName.value = (payload.fromName as string) || sender;
        fileName.value = (payload.name as string) ?? "";
        fileSize.value = (payload.size as number) ?? 0;
        direction.value = "recv";
        progress.value = 0;
        state.value = "incoming";
        break;
      case "file_accept":
        // Host side: the peer accepted; the inbound QUIC connection + progress events
        // take it from here. Reflect the state change immediately.
        if (offerId !== myOfferId) return;
        if (state.value === "offering") state.value = "transferring";
        break;
      case "file_decline":
        if (offerId !== myOfferId) return;
        void _invoke("file_offer_cancel", { offerId: myOfferId }).catch(() => {});
        state.value = "declined";
        break;
      case "file_cancel":
        if (offerId === myOfferId || offerId === incomingOfferId) reset();
        break;
    }
  });

  return {
    available, state, peerName, fileName, fileSize, progress, direction, error,
    offer, accept, decline, cancel, reset,
  };
}

export type FileShare = ReturnType<typeof useFileShare>;
