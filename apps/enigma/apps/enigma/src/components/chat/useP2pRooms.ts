import { ref, watch } from "vue";
import { isTorTicket, getConnectTimeoutSecs, roomActionId } from "rakotis";
import { chargeHp, dataCreditHp, recoverHp } from "../hp/useHp";
import type { ChatChannel, P2pRoomEntry } from "rakotis";

// Shared P2P room state + actions for the chat surface. One instance is created in
// ChatPanel and passed to both the desktop rooms sidebar and the mobile drawer so
// they stay in sync (the refs are shared by reference). Create + join run in modals
// (CreateRoomModal / JoinRoomModal) with progress state tracked here.
export function useP2pRooms(channel: ChatChannel) {
  const name = ref("");
  const ticket = ref("");
  const createdTicket = ref("");
  const createdCode = ref(""); // ticketless-join room code — "" while DHT discovery is off
  // The room the ticket above belongs to. Invitations are minted against a room
  // slug, and the entry is the only place that pairs a ticket with one.
  const createdRoom = ref<{ slug: string; name: string }>({ slug: "", name: "" });
  const scanError = ref(""); // i18n key, "" when clear

  // ── Create modal ─────────────────────────────────────────────────────────────
  const createOpen = ref(false);
  const createBusy = ref(false); // launching (onion publish / room create) → spinner
  const createError = ref(""); // i18n key or raw backend message

  // Create shares the join's user-configurable connect timeout (Settings): if the
  // launch hasn't finished in time, surface the timeout error + Retry. The invoke
  // keeps running in the background — a late success still shows the ticket.
  let createTimer: ReturnType<typeof setTimeout> | null = null;
  function clearCreateTimer() {
    if (createTimer !== null) {
      clearTimeout(createTimer);
      createTimer = null;
    }
  }

  function openCreate() {
    name.value = "";
    createdTicket.value = "";
    createdCode.value = "";
    createError.value = "";
    createBusy.value = false;
    clearCreateTimer();
    createOpen.value = true;
  }

  async function createRoom() {
    const n = name.value.trim();
    if (!n || createBusy.value) return;
    createError.value = "";
    createBusy.value = true;
    const timeoutMs = 1000 * (await getConnectTimeoutSecs());
    clearCreateTimer();
    createTimer = setTimeout(() => {
      createTimer = null;
      if (!createBusy.value) return;
      createBusy.value = false; // leave the spinner → show the error + Retry
      createError.value = "chat.joinTimeout";
    }, timeoutMs);
    try {
      // Blocks until the onion descriptor is published (Tor) / room is created (iroh).
      const t = await channel.createRoom(n);
      clearCreateTimer();
      if (t) {
        createdTicket.value = t; // success wins, even after a timeout was shown
        // The room code (ticketless join) rides the remembered entry.
        const entry = channel.p2pRooms.value.find((r) => r.ticket === t);
        createdCode.value = entry?.code ?? "";
        createdRoom.value = { slug: entry?.room ?? "", name: entry?.name ?? n };
        createError.value = "";
        name.value = "";
        // Privacy HP, charged only on a room that actually came up. The variant
        // is read from the ticket the transport produced rather than from the
        // Tor setting, so a room that fell back to clearnet is priced as one.
        await chargeHp(roomActionId("create", isTorTicket(t)));
        // A DHT room code is a separate, additional exposure: the rendezvous
        // record is public even though its contents are sealed.
        if (createdCode.value) await chargeHp("dht.room_code.publish");
      } else if (!createError.value) {
        createError.value = channel.error.value || "chat.launchFailed";
      }
    } catch (e) {
      clearCreateTimer();
      if (!createError.value) createError.value = (e as Error).message || "chat.launchFailed";
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
      const freed = await channel.deleteRoom(room);
      // Privacy HP: deleting stored history is a real reduction in what this
      // device is holding, so it earns — scaled by how much actually went, and
      // nothing at all for a room that had no stored log.
      if (freed > 0) await dataCreditHp("data.delete.chat", freed);
      // Leaving is itself a reduction: this device stops receiving the room at
      // all. Separate from the data credit above, and capped independently.
      await recoverHp("room.leave");
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
  function armConnectTimer(timeoutMs: number) {
    clearConnectTimer();
    connectTimer = setTimeout(() => {
      connectTimer = null;
      // "Connected" means the ENCRYPTED session is up (the modal's success state) —
      // the window covers the transport dial AND the MLS key exchange, so a
      // transport-connected-but-never-encrypted join still times out.
      if (!joinStarted.value || joinError.value || channel.isEncrypted.value) return;
      joinTimedOut.value = true;
      if (joiningTor.value) void channel.cancelJoin(); // free the hung onion/dial in Rust
      joinError.value = "chat.joinTimeout";
    }, timeoutMs);
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
    armConnectTimer(1000 * (await getConnectTimeoutSecs()));
    await channel.joinByTicket(t);
    // NOTE: the connect timer stays armed past this point — the transport is up but
    // the window only ends on a terminal state (Encrypted, or an error), which the
    // terminal watcher below handles. This keeps an MLS hang covered by the timeout.
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
    else await chargeHp(roomActionId("join", joiningTor.value));
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

  // ── Auto-close countdown (join modal) ────────────────────────────────────────
  // The join window lives at most 2×N seconds (N = the user-configured connect
  // timeout): N seconds to connect, then — once a terminal state is reached
  // (established = MLS Encrypted, or an error such as the timeout) — N more seconds
  // for the user to read the outcome, with a visible countdown, before the modal
  // closes itself. Manual Close/Retry still work; Retry resets the countdown.
  const autoCloseSecs = ref<number | null>(null);
  let autoCloseTimer: ReturnType<typeof setInterval> | null = null;
  function clearAutoClose() {
    if (autoCloseTimer !== null) {
      clearInterval(autoCloseTimer);
      autoCloseTimer = null;
    }
    autoCloseSecs.value = null;
  }
  function armAutoClose() {
    if (autoCloseTimer !== null) return;
    void (async () => {
      autoCloseSecs.value = await getConnectTimeoutSecs();
      autoCloseTimer = setInterval(() => {
        if (autoCloseSecs.value === null) return;
        autoCloseSecs.value -= 1;
        if (autoCloseSecs.value <= 0) {
          clearAutoClose();
          joinOpen.value = false;
        }
      }, 1000);
    })();
  }
  watch(
    [channel.isEncrypted, joinError, joinStarted, joinOpen],
    ([encrypted, err, started, open]) => {
      // Terminal outcome visible in an open join window → the connect window is over:
      // disarm the connect timer and start the read countdown. Any reset (Retry,
      // Cancel, close, reopen) clears the countdown.
      if (!open || !started || (!encrypted && !err)) {
        clearAutoClose();
        return;
      }
      clearConnectTimer();
      armAutoClose();
    },
  );

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
    createdRoom,
    createdCode,
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
    autoCloseSecs,
    openJoin,
    resetJoin,
    joinRoom,
    cancelJoin,
    joinTicket,
    scanFile,
  };
}

export type P2pRoomsController = ReturnType<typeof useP2pRooms>;
