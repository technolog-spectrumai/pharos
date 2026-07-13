import { ref } from "vue";
import { isTorTicket } from "rakotis";
import type { ChatChannel, P2pRoomEntry } from "rakotis";

// Shared P2P room state + actions for the chat surface. One instance is created in
// ChatPanel and passed to both the desktop rooms sidebar and the mobile drawer so
// they stay in sync (the refs are shared by reference). Create + join run in modals
// (CreateRoomModal / JoinRoomModal) with progress state tracked here.
export function useP2pRooms(channel: ChatChannel) {
  const name = ref("");
  const ticket = ref("");
  const createdTicket = ref("");
  const scanError = ref(""); // i18n key, "" when clear

  // ── Create modal ─────────────────────────────────────────────────────────────
  const createOpen = ref(false);
  const createBusy = ref(false); // launching (onion publish / room create) → spinner
  const createError = ref(""); // i18n key or raw backend message

  function openCreate() {
    name.value = "";
    createdTicket.value = "";
    createError.value = "";
    createBusy.value = false;
    createOpen.value = true;
  }

  async function createRoom() {
    const n = name.value.trim();
    if (!n || createBusy.value) return;
    createError.value = "";
    createBusy.value = true;
    try {
      // Blocks until the onion descriptor is published (Tor) / room is created (iroh).
      const t = await channel.createRoom(n);
      if (t) {
        createdTicket.value = t;
        name.value = "";
      } else {
        createError.value = channel.error.value || "chat.launchFailed";
      }
    } catch (e) {
      createError.value = (e as Error).message || "chat.launchFailed";
    } finally {
      createBusy.value = false;
    }
  }

  // ── Room-info modal ──────────────────────────────────────────────────────────
  // Re-show a saved room's QR / join ticket (each P2pRoomEntry carries its ticket).
  const infoOpen = ref(false);
  const infoRoom = ref<P2pRoomEntry | null>(null);

  function openInfo(room: P2pRoomEntry) {
    infoRoom.value = room;
    infoOpen.value = true;
  }

  // ── Join modal ───────────────────────────────────────────────────────────────
  const joinOpen = ref(false);
  const joinStarted = ref(false); // a join was initiated → show live progress
  const joinError = ref("");
  const joiningTor = ref(false); // current in-flight join is over Tor → offer Cancel
  const joinCancelling = ref(false); // Cancel pressed → abort in progress, swallow error

  function openJoin() {
    ticket.value = "";
    scanError.value = "";
    joinError.value = "";
    joinStarted.value = false;
    joiningTor.value = false;
    joinCancelling.value = false;
    joinOpen.value = true;
  }
  function resetJoin() {
    joinStarted.value = false;
    joinError.value = "";
    joiningTor.value = false;
    joinCancelling.value = false;
  }

  async function joinRoom() {
    const t = ticket.value.trim();
    if (!t) return;
    joinError.value = "";
    joinStarted.value = true;
    joiningTor.value = isTorTicket(t);
    joinCancelling.value = false;
    await channel.joinByTicket(t);
    ticket.value = "";
    // If the user cancelled mid-join, cancelJoin() already reset the UI — swallow the
    // "join cancelled" error the aborted invoke produced (in both this controller and
    // the channel) instead of surfacing it anywhere.
    if (joinCancelling.value) {
      channel.error.value = null;
      return;
    }
    // The modal then watches channel.isEncrypted for "established". A transport error
    // lands in channel.error.
    if (channel.error.value) joinError.value = channel.error.value;
  }

  // Abort a hanging Tor join and return to the form. Frees the onion lock in Rust so
  // the immediate retry doesn't fail with "resource already in use".
  async function cancelJoin() {
    if (joinCancelling.value) return;
    joinCancelling.value = true;
    await channel.cancelJoin();
    joinStarted.value = false;
    joinError.value = "";
    joiningTor.value = false;
  }

  async function joinTicket(raw: string) {
    ticket.value = raw.trim();
    await joinRoom();
  }

  // Join by decoding a QR image file (off-screen #p2p-qr-file-region lives in ChatPanel).
  async function scanFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    scanError.value = "";
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const reader = new Html5Qrcode("p2p-qr-file-region");
      const decoded: string = await reader.scanFile(file, false);
      try {
        await reader.clear();
      } catch {
        /* ignore */
      }
      await joinTicket(decoded);
    } catch {
      scanError.value = "chat.qrNotFound";
    }
  }

  return {
    name,
    ticket,
    createdTicket,
    scanError,
    createOpen,
    createBusy,
    createError,
    openCreate,
    createRoom,
    infoOpen,
    infoRoom,
    openInfo,
    joinOpen,
    joinStarted,
    joinError,
    joiningTor,
    joinCancelling,
    openJoin,
    resetJoin,
    joinRoom,
    cancelJoin,
    joinTicket,
    scanFile,
  };
}

export type P2pRoomsController = ReturnType<typeof useP2pRooms>;
