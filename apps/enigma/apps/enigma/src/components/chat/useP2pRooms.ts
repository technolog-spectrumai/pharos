import { ref, watch } from "vue";
import {
  getConnectTimeoutSecs,
  isInviteTicket,
  roomActionId,
} from "rakotis";
import { isTauri as _isTauriFn, invoke as _rawInvoke } from "rakotis";

import { redeemInvitation } from "./redeemInvitation";
import { chargeHp, dataCreditHp, recoverHp } from "../hp/useHp";
import type { ChatChannel, P2pRoomEntry } from "rakotis";

// Shared P2P room state + actions for the chat surface. One instance is created in
// ChatPanel and passed to both the desktop rooms sidebar and the mobile drawer so
// they stay in sync (the refs are shared by reference). Create + join run in modals
// (CreateRoomModal / JoinRoomModal) with progress state tracked here.
export function useP2pRooms(channel: ChatChannel) {
  const name = ref("");
  const ticket = ref("");
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
        // `createRoom` returns the room slug now, not a ticket — creating a room
        // produces no shareable credential at all.
        const entry = channel.p2pRooms.value.find((r) => r.room === t);
        createdRoom.value = { slug: t, name: entry?.name ?? n };
        createError.value = "";
        name.value = "";
        // Privacy HP, charged only on a room that actually came up. The variant
        // is read from the room the transport produced rather than from the Tor
        // setting, so a room that fell back to clearnet is priced as one.
        await chargeHp(roomActionId("create", entry?.tor === true));
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

  // ── invitations (technology.md §18) ─────────────────────────────────────────
  // A scanned invitation goes down a different road entirely: instead of joining
  // a topic, we connect to the inviter, prove we hold the capability, and are
  // admitted to the group by them. The join field does not change — the tag byte
  // routes it, exactly as it already routes Tor tickets and DHT room codes.

  /** What a scanned invitation says about itself, before committing to it. */
  const invitePeek = ref<{ kind: string; inviter: string; expiresAt: number } | null>(null);


  async function redeemInvite(code: string) {
    joinError.value = "";
    joinStarted.value = true;
    joinCancelling.value = false;
    joinTimedOut.value = false;
    invitePeek.value = null;
    // The same N-second connect window a ticket join used to get, so the modal's
    // 2×N lifetime (N to connect, N to read the outcome) is unchanged. Rust bounds
    // the rendezvous separately at 2×N; this is the window the USER sees, and it
    // stays shorter so a hung redeem shows Retry rather than a frozen spinner.
    armConnectTimer(1000 * (await getConnectTimeoutSecs()));
    const out = await redeemInvitation(channel, code, (p) => {
      invitePeek.value = p;
      // A Tor redemption dials an onion, which is the case that can hang holding
      // a keystore lock — so Cancel has to be on offer, and the timeout has to
      // abort rather than just give up. Known only after the peek, which is why
      // it is set here rather than before the call.
      joiningTor.value = p.tor === true;
    });
    clearConnectTimer();
    if (out.ok) {
      // Success wins, even after a timeout was already shown: the redemption
      // completed, so we ARE in the room, and leaving "timed out" on screen would
      // contradict the transcript behind it.
      joinTimedOut.value = false;
      ticket.value = "";
      joinError.value = "";
      return;
    }
    // A timeout or a cancel already put its own message up and the modal is
    // showing Retry; overwriting it with whatever the aborted call returned would
    // replace a true statement with a confusing one.
    if (joinTimedOut.value || joinCancelling.value) return;
    joinError.value = out.errorKey;
  }

  /**
   * Join whatever was pasted or scanned.
   *
   * There is exactly one thing that can be: an invitation. Room tickets and DHT
   * room codes both used to arrive through this same field, tag-sniffed apart and
   * routed to their own backends; both are gone, so anything that is not an
   * invitation is rejected here rather than handed to a parser that no longer
   * exists. Saying so plainly beats "invalid ticket" for someone holding a QR that
   * an older build minted and this one will not honour.
   */
  async function joinRoom() {
    const t = ticket.value.trim();
    if (!t) return;
    if (!isInviteTicket(t)) {
      joinError.value = "invite.errNotAnInvitation";
      joinStarted.value = true;
      return;
    }
    await redeemInvite(t);
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
    createdRoom,
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
    invitePeek,
    scanFile,
  };
}

export type P2pRoomsController = ReturnType<typeof useP2pRooms>;
