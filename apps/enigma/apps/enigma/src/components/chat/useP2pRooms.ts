import { ref } from "vue";
import { isTorTicket } from "rakotis";
import type { ChatChannel, P2pRoomEntry } from "rakotis";

// Default time a join is given to connect before it times out (aborting the
// in-flight connect and offering a retry). Tunable.
const CONNECT_TIMEOUT_MS = 5000;

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

  // ── Delete-room confirmation ─────────────────────────────────────────────────
  const deleteOpen = ref(false);
  const deleteRoomEntry = ref<P2pRoomEntry | null>(null);
  const deleteBusy = ref(false);

  function openDeleteConfirm(room: P2pRoomEntry) {
    deleteRoomEntry.value = room;
    deleteBusy.value = false;
    deleteOpen.value = true;
  }

  async function confirmDelete() {
    const room = deleteRoomEntry.value;
    if (!room || deleteBusy.value) return;
    deleteBusy.value = true;
    try {
      // Kicks participants (if host + connected), closes connections, wipes the data.
      await channel.deleteRoom(room);
      deleteOpen.value = false;
      deleteRoomEntry.value = null;
    } finally {
      deleteBusy.value = false;
    }
  }

  // ── Join modal ───────────────────────────────────────────────────────────────
  const joinOpen = ref(false);
  const joinStarted = ref(false); // a join was initiated → show live progress
  const joinError = ref("");
  const joiningTor = ref(false); // current in-flight join is over Tor → offer Cancel
  const joinCancelling = ref(false); // Cancel pressed → abort in progress, swallow error
  const joinTimedOut = ref(false); // connect timed out → keep the timeout error, swallow the abort

  // Connect-timeout timer: armed when a join begins, cleared once it connects
  // (joinByTicket resolves), the user cancels, or the modal resets.
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  function clearConnectTimer() {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }
  function armConnectTimer() {
    clearConnectTimer();
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (!joinStarted.value || joinError.value) return;
      joinTimedOut.value = true;
      if (joiningTor.value) void channel.cancelJoin(); // free the hung onion/dial in Rust
      joinError.value = "chat.joinTimeout";
    }, CONNECT_TIMEOUT_MS);
  }

  function openJoin() {
    ticket.value = "";
    scanError.value = "";
    joinError.value = "";
    joinStarted.value = false;
    joiningTor.value = false;
    joinCancelling.value = false;
    joinTimedOut.value = false;
    clearConnectTimer();
    joinOpen.value = true;
  }
  function resetJoin() {
    joinStarted.value = false;
    joinError.value = "";
    joiningTor.value = false;
    joinCancelling.value = false;
    joinTimedOut.value = false;
    clearConnectTimer();
  }

  async function joinRoom() {
    const t = ticket.value.trim();
    if (!t) return;
    joinError.value = "";
    joinStarted.value = true;
    joiningTor.value = isTorTicket(t);
    joinCancelling.value = false;
    joinTimedOut.value = false;
    armConnectTimer();
    await channel.joinByTicket(t);
    clearConnectTimer(); // connected (or failed) → the connect window is over
    ticket.value = "";
    // If the user cancelled mid-join, cancelJoin() already reset the UI — swallow the
    // "join cancelled" error the aborted invoke produced (in both this controller and
    // the channel) instead of surfacing it anywhere.
    if (joinCancelling.value) {
      channel.error.value = null;
      return;
    }
    // Connect timed out: keep the timeout error (the modal shows Retry), and swallow
    // the "join cancelled" error the timeout's abort produced.
    if (joinTimedOut.value) {
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
    clearConnectTimer();
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
    deleteOpen,
    deleteRoomEntry,
    deleteBusy,
    openDeleteConfirm,
    confirmDelete,
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
