<script setup lang="ts">
// The post-activation flash: "−10 HP · DHT presence enabled", ~2.6 s.
//
// Rendered by App.vue in the same layer as the pre-lock warning (z-70: above the
// modal layer, below the vault gate). It reports what already happened, so it has
// no buttons and never asks anything — dismissing it early is the only
// interaction, and even that is optional.
//
// `seq` is in the :key so two identical charges in a row re-run the animation
// instead of looking like one stuck toast.
import { formatPrice } from "rakotis";
import { dismissHpFlash, hpFlash } from "./useHp";
</script>

<template>
  <Transition name="hp-flash">
    <div
      v-if="hpFlash"
      :key="hpFlash.seq"
      class="pointer-events-auto fixed inset-x-0 top-20 z-70 mx-auto flex w-fit max-w-[92vw] items-center gap-2 rounded-xl border border-current/20 bg-appbar-bg-light px-4 py-2.5 text-sm font-bold text-appbar-text-light shadow-lg dark:bg-appbar-bg-dark dark:text-appbar-text-dark"
      role="status"
      aria-live="polite"
      data-testid="hp-flash"
      @click="dismissHpFlash()"
    >
      <span
        class="shrink-0 tabular-nums"
        :class="hpFlash.centi > 0 ? 'text-success-dark' : 'text-warn-dark'"
      >
        {{ formatPrice(hpFlash.centi) }}
      </span>
      <span class="opacity-40">·</span>
      <span class="truncate font-normal">{{ hpFlash.label }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.hp-flash-enter-active,
.hp-flash-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.hp-flash-enter-from,
.hp-flash-leave-to {
  opacity: 0;
  transform: translateY(-0.5rem);
}
</style>
