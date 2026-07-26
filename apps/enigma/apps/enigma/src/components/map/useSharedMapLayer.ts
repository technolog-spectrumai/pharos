// Reactive wrapper over the shared-layer derivation: the open room's map cards,
// aged against a ticking clock and split by whether an imported region can
// actually draw them.
//
// The clock tick is what makes a location vanish at its TTL without a reload
// (the timeline itself never changes when a share merely gets old).

import { computed, onScopeDispose, ref } from "vue";
import { useChatStore } from "../../stores/chat";
import { useMapStore } from "../../stores/map";
import { deriveSharedLayer, type SharedItem } from "./sharedLayerModel";

/** Coarse enough to be free, fine enough that a 6 h expiry looks instant. */
const AGE_TICK_MS = 60_000;

export function useSharedMapLayer() {
  const chat = useChatStore();
  const map = useMapStore();

  const now = ref(Date.now());
  const tick = setInterval(() => {
    now.value = Date.now();
  }, AGE_TICK_MS);
  // MapPanel remounts whenever the active region changes (its :key), so the
  // interval must die with the scope.
  onScopeDispose(() => clearInterval(tick));

  const roomSlug = computed(() => chat.p2p.currentRoom.value?.slug ?? null);

  /** Everything shared in THIS room, live and in timeline order. Room scoping
   *  is free: the channel clears + restores `messages` on every room entry. */
  const all = computed<SharedItem[]>(() =>
    roomSlug.value === null
      ? []
      : deriveSharedLayer(chat.p2p.messages.value, { now: now.value, regions: map.regions }),
  );

  /** What the canvas may draw: covered by an imported region, layer enabled. */
  const onMap = computed<SharedItem[]>(() =>
    map.sharedLayerVisible ? all.value.filter((i) => i.covered) : [],
  );

  /** Shared, but no imported region covers it — listed in the sidebar so the
   *  user knows it exists (and which package they are missing). */
  const outside = computed<SharedItem[]>(() => all.value.filter((i) => !i.covered));

  return { roomSlug, all, onMap, outside, now };
}
