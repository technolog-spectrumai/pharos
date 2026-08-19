// Network policy, shared: the offline switch and the "connect via Tor" switch,
// plus what each capability may do under them.
//
// Rust is the enforcement layer — vox.rs, file_xfer.rs, device_link.rs and
// peer_link.rs each run check_*policy() first and fail networked commands with
// their TOR_BLOCKED / OFFLINE_BLOCKED strings. This store exists so the UI can
// say the same thing *before* the click: buttons stay visible but disabled,
// with a reason, and every panel reads the one reactive source instead of
// sampling getUseTor() once at mount (which went stale the moment the setting
// changed while the panel was open).
//
// The rule for what Tor blocks mirrors the Rust guards exactly: everything
// that rides iroh's direct QUIC — voice calls, P2P file transfer, device
// linking/sync, peer sync — because a direct dial from Tor-exclusive mode
// would leak the IP. Chat itself is fine: it re-homes onto the onion transport.
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  getOffline,
  getUseTor,
  setOffline as persistOffline,
  setUseTor as persistUseTor,
} from "rakotis";

export const useNetworkStore = defineStore("network", () => {
  const offline = ref(false);
  const useTor = ref(false);
  const loaded = ref(false);

  /** Read both switches from the backend. Cheap; call on mount of any gated view. */
  async function refresh(): Promise<void> {
    // Failures leave the gates open rather than wedging the UI shut: Rust
    // still enforces, so a wrongly-enabled button degrades to the old error.
    offline.value = await getOffline().catch(() => false);
    useTor.value = await getUseTor().catch(() => false);
    loaded.value = true;
  }

  /** Flip airplane mode. The backend tears transports down; we mirror the flag. */
  async function setOffline(value: boolean): Promise<void> {
    await persistOffline(value);
    offline.value = value;
  }

  /** Flip Tor-exclusive mode. The backend hangs up calls, kills iroh, aborts
   *  transfers (app_set_use_tor); flipping the ref here is what disables the
   *  buttons everywhere at the same moment. */
  async function setUseTor(value: boolean): Promise<void> {
    await persistUseTor(value);
    useTor.value = value;
  }

  // ── capability gates (all iroh-only features share one fate) ────────────────
  const irohBlocked = computed(() => offline.value || useTor.value);

  /** 1:1 voice calls (vox.rs: direct QUIC only). */
  const canCall = computed(() => !irohBlocked.value);
  /** P2P file transfer (file_xfer.rs: iroh-only, any size — large ones just fail slower). */
  const canFileTransfer = computed(() => !irohBlocked.value);
  /** Per-file device sync for already-linked profiles (device_link.rs / file_sync.rs). */
  const canDeviceSync = computed(() => !irohBlocked.value);
  /** Peer sync links (peer_link.rs). */
  const canPeerSync = computed(() => !irohBlocked.value);

  /** i18n key for the shared "why is this disabled" line; "" when nothing is. */
  const blockedReasonKey = computed(() =>
    offline.value ? "network.blockedOffline" : useTor.value ? "network.blockedTor" : "",
  );

  return {
    offline, useTor, loaded, refresh, setOffline, setUseTor,
    canCall, canFileTransfer, canDeviceSync, canPeerSync, blockedReasonKey,
  };
});
