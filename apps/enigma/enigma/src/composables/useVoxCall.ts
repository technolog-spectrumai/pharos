// Real-time 1:1 voice call ("Vox") controller.
//
// Drives the Rust iroh voice backend (the `vox_*` commands + `vox://*` events).
// It is a plain module singleton so the event listeners are wired exactly once
// and every component observes the same call state. Voice is desktop/Android
// only (iroh lives in Rust) — in a plain browser `available` is false and the
// panel shows a notice, mirroring how P2P chat is native-only.

import { ref } from "vue";
import { useChatStore } from "../stores/chat";

export type VoxPhase =
  | "idle" // nothing happening — show start/join
  | "waiting" // we created a ticket and are waiting for a peer to join (callee)
  | "calling" // we are dialing a ticket (caller)
  | "incoming" // a peer is calling us — show accept/decline
  | "connected" // call is live
  | "ended" // transient — settles back to idle
  | "error"; // transient — settles back to idle

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function createVox() {
  const available = _isTauri();

  const phase = ref<VoxPhase>("idle");
  const ticket = ref("");
  const nodeId = ref("");
  const incomingName = ref("");
  const peerName = ref("");
  const muted = ref(false);
  const error = ref(""); // i18n key or raw message
  const callSeconds = ref(0);
  const spectrum = ref<number[]>([]); // live equalizer bands (0..1) of the incoming voice

  let timer: ReturnType<typeof setInterval> | null = null;
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  function startTimer() {
    stopTimer();
    callSeconds.value = 0;
    timer = setInterval(() => (callSeconds.value += 1), 1000);
  }

  function reset() {
    phase.value = "idle";
    ticket.value = "";
    nodeId.value = "";
    incomingName.value = "";
    peerName.value = "";
    muted.value = false;
    spectrum.value = [];
    stopTimer();
  }

  // ── backend events ──────────────────────────────────────────────────────────
  let listening = false;
  async function ensureListeners(): Promise<void> {
    if (listening || !available) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ from_name: string; node_id: string }>("vox://incoming", (e) => {
      incomingName.value = e.payload.from_name || "Unknown";
      phase.value = "incoming";
    });
    await listen<{ bands: number[] }>("vox://spectrum", (e) => {
      spectrum.value = e.payload.bands ?? [];
    });
    await listen<{ state: string; peer: string | null }>("vox://state", (e) => {
      const { state, peer } = e.payload;
      switch (state) {
        case "calling":
          phase.value = "calling";
          break;
        case "ringing":
          if (peer) incomingName.value = peer;
          break;
        case "connected":
          peerName.value = peer || incomingName.value || "Peer";
          incomingName.value = "";
          phase.value = "connected";
          startTimer();
          break;
        case "ended":
        case "error":
          if (state === "error") error.value = "vox.errorGeneric";
          phase.value = state;
          stopTimer();
          // Settle back to the start screen shortly after.
          setTimeout(() => {
            if (phase.value === "ended" || phase.value === "error") reset();
          }, 1500);
          break;
      }
    });
  }

  function myName(): string {
    const chat = useChatStore();
    const u = chat.relay.currentUserName.value;
    return u && u !== "You" ? u : chat.relay.mlsIdentity.value || "Caller";
  }

  // ── actions ────────────────────────────────────────────────────────────────
  async function createCall(): Promise<void> {
    if (!available) {
      error.value = "vox.desktopOnly";
      return;
    }
    error.value = "";
    try {
      await ensureListeners();
      const res = await _invoke<{ ticket: string; node_id: string }>("vox_create", { name: myName() });
      ticket.value = res.ticket;
      nodeId.value = res.node_id;
      phase.value = "waiting";
    } catch (e) {
      error.value = (e as Error).message || "vox.errorGeneric";
      phase.value = "error";
    }
  }

  async function joinByTicket(t: string): Promise<void> {
    if (!available) {
      error.value = "vox.desktopOnly";
      return;
    }
    const tk = t.trim();
    if (!tk) return;
    error.value = "";
    try {
      await ensureListeners();
      phase.value = "calling";
      await _invoke("vox_join", { ticket: tk, name: myName() });
    } catch (e) {
      error.value = (e as Error).message || "vox.errorGeneric";
      phase.value = "error";
    }
  }

  async function accept(): Promise<void> {
    try {
      await _invoke("vox_accept");
    } catch {
      /* the call may have already gone away */
    }
  }

  async function decline(): Promise<void> {
    try {
      await _invoke("vox_decline");
    } catch {
      /* ignore */
    }
    reset();
  }

  async function hangup(): Promise<void> {
    try {
      await _invoke("vox_hangup");
    } catch {
      /* ignore */
    }
    reset();
  }

  async function toggleMute(): Promise<void> {
    const next = !muted.value;
    try {
      await _invoke("vox_set_mute", { muted: next });
      muted.value = next;
    } catch {
      /* ignore */
    }
  }

  return {
    available,
    phase,
    ticket,
    nodeId,
    incomingName,
    peerName,
    muted,
    error,
    callSeconds,
    spectrum,
    createCall,
    joinByTicket,
    accept,
    decline,
    hangup,
    toggleMute,
  };
}

let _instance: ReturnType<typeof createVox> | null = null;

/** Singleton accessor for the Vox call controller. */
export function useVoxCall() {
  return (_instance ??= createVox());
}
