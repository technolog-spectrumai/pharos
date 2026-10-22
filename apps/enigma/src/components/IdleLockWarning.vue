<script setup lang="ts">
// Pre-lock countdown toast (App.vue renders it when the idle watcher warns).
// Deliberately a corner card, not a modal: the user may have a draft open, and a
// backdrop would cover exactly what they are about to lose — and eat the first
// click. Any activity anywhere dismisses it: the window-level activity listeners
// clear the watcher's `warned` flag, which the poll below picks up. The 250 ms
// poll (only while visible) also gives the display its cadence — the coarse
// watcher tick is too slow for a live countdown, and `remaining()` reads the
// wall clock, so a throttled timer can't skew the number shown.
import { ref, onMounted, onBeforeUnmount } from "vue";
import { OyaButton } from "rakotis";
import type { IdleLockHandle } from "../idleLock";

const props = defineProps<{
  handle: IdleLockHandle;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const secs = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

function poll() {
  const rem = props.handle.remaining();
  if (rem === null || !props.handle.warned) {
    emit("close");
    return;
  }
  secs.value = Math.max(1, Math.ceil(rem / 1000));
}

onMounted(() => {
  poll();
  timer = setInterval(poll, 250);
});

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
  timer = null;
});
</script>

<template>
  <div
    role="alert"
    class="fixed bottom-4 right-4 z-[70] flex max-w-sm items-center gap-3 rounded-xl border border-current/15 px-4 py-3 shadow-lg bg-header-bg-light text-text-main-light dark:bg-header-bg-dark dark:text-text-main-dark"
  >
    <font-awesome-icon icon="lock" class="shrink-0 text-warn-dark" />
    <div class="min-w-0 text-sm">
      <p class="font-semibold">{{ $t('vault.lockSoonTitle') }}</p>
      <p class="text-xs opacity-70">{{ $t('vault.lockSoonBody', { s: secs }) }}</p>
    </div>
    <!-- The click is itself activity (mousedown clears `warned`); the emit just
         closes the toast without waiting for the next poll. -->
    <OyaButton variant="secondary" class="shrink-0" @click="emit('close')">
      {{ $t('vault.lockSoonStay') }}
    </OyaButton>
  </div>
</template>
