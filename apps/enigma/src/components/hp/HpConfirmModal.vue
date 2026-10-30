<script setup lang="ts">
// The confirmation that only high and severe costs — or an empty meter — raise.
//
// It exists to make an expensive choice deliberate, NOT to stop it: "Continue" is
// always available and is the primary action. An empty meter changes the copy,
// never the outcome. Low-cost actions never reach this component at all, which is
// the point: a budget that interrupts constantly is one people click through
// without reading.
import { formatPrice } from "rakotis";
import { OyaModal } from "petalite/primitives";
import { hpConfirm, resolveHpConfirm } from "./useHp";
</script>

<template>
  <OyaModal :open="hpConfirm !== null" @close="resolveHpConfirm(false)">
    <div
      v-if="hpConfirm"
      class="max-h-[85dvh] w-full max-w-sm space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      data-testid="hp-confirm"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="shield-halved" class="opacity-60" />{{ $t("hp.confirmTitle") }}
      </p>

      <div class="flex items-center gap-3">
        <span
          class="shrink-0 rounded-lg border border-warn-light px-3 py-1.5 text-base font-bold tabular-nums text-warn-light dark:border-warn-dark dark:text-warn-dark"
          data-testid="hp-confirm-price"
        >
          {{ formatPrice(hpConfirm.centi) }}
        </span>
        <span class="min-w-0 text-sm font-semibold">{{ hpConfirm.label }}</span>
      </div>

      <!-- The same one sentence the info dot shows. Repeated rather than expanded:
           the explanation should not change depending on where you meet it. -->
      <p v-if="hpConfirm.explain" class="text-sm leading-relaxed opacity-80">
        {{ hpConfirm.explain }}
      </p>

      <p
        v-if="hpConfirm.exhausted"
        class="rounded-lg border border-highlight/40 bg-highlight/10 p-3 text-sm leading-relaxed"
        data-testid="hp-confirm-exhausted"
      >
        {{ $t("hp.confirmExhausted") }}
      </p>

      <!-- Says out loud what a meter cannot: this is a mirror, not a protection.
           Nothing here has undone the exposure it is about to record. -->
      <p class="text-xs leading-relaxed opacity-60">{{ $t("hp.advisoryNote") }}</p>
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        @click="resolveHpConfirm(false)"
      >
        {{ $t("common.cancel") }}
      </button>
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        data-testid="hp-confirm-continue"
        @click="resolveHpConfirm(true)"
      >
        {{ $t("hp.confirmContinue") }}
      </button>
    </template>
  </OyaModal>
</template>
