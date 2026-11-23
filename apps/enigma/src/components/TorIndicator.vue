<script setup lang="ts">
// Tor's state in the app bar, on every screen: whether this device's Tor is up,
// which is what everything in the app rides on. Tapping it opens the Tor card in
// Settings.
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { torState, watchTor } from "../stores/tor";

const router = useRouter();
onMounted(() => void watchTor());

const look = computed(() => {
  switch (torState.value) {
    case "on":
      return { key: "tor.on", dot: "bg-success-light dark:bg-success-dark", text: "", pulse: false };
    case "starting":
      return { key: "tor.starting", dot: "bg-highlight", text: "", pulse: true };
    case "error":
      return { key: "tor.error", dot: "bg-warn-dark", text: "text-warn-dark", pulse: false };
    default:
      return { key: "tor.off", dot: "border border-current", text: "opacity-60", pulse: false };
  }
});
</script>

<template>
  <button
    type="button"
    class="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-current/15 px-2.5 text-xs font-semibold transition hover:opacity-80"
    :class="look.text"
    :title="$t(`${look.key}Hint`)"
    :aria-label="$t(`${look.key}Hint`)"
    data-testid="tor-indicator"
    :data-state="torState"
    @click="router.push('/config?tab=connections')"
  >
    <span class="relative flex h-2.5 w-2.5">
      <span v-if="look.pulse" class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" :class="look.dot" />
      <span class="relative inline-flex h-2.5 w-2.5 rounded-full" :class="look.dot" />
    </span>
    <font-awesome-icon icon="shield-halved" class="opacity-80" />
    <span>{{ $t(look.key) }}</span>
  </button>
</template>
