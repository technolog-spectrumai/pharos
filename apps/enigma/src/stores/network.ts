// Network policy, shared: the offline (airplane) switch, and what it blocks.
//
// Rust is the enforcement layer: every networked command fails with
// OFFLINE_BLOCKED while it is on. This store exists so the UI can say the same
// thing before the click: buttons stay visible but disabled, with a reason.
// There is no Tor switch: everything always goes over Tor.
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { getOffline, setOffline as persistOffline } from "rakotis";

export const useNetworkStore = defineStore("network", () => {
  const offline = ref(false);
  const loaded = ref(false);

  /** Read the switch from the backend. Cheap; call on mount of any gated view. */
  async function refresh(): Promise<void> {
    // A failure leaves the gates open rather than wedging the UI shut: Rust
    // still enforces.
    offline.value = await getOffline().catch(() => false);
    loaded.value = true;
  }

  /** Flip airplane mode. The backend tears the transport down; we mirror the flag. */
  async function setOffline(value: boolean): Promise<void> {
    await persistOffline(value);
    offline.value = value;
  }

  /** File transfer rides the room's onions, so only airplane mode blocks it. */
  const canFileTransfer = computed(() => !offline.value);

  /** i18n key for the shared "why is this disabled" line; "" when nothing is. */
  const blockedReasonKey = computed(() => (offline.value ? "network.blockedOffline" : ""));

  return { offline, loaded, refresh, setOffline, canFileTransfer, blockedReasonKey };
});
