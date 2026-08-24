<script setup lang="ts">
// The confirmation that only high and severe costs — or an empty meter — raise.
//
// It exists to make an expensive choice deliberate, NOT to stop it: "Continue" is
// always available and is the primary action. An empty meter changes the copy,
// never the outcome. Low-cost actions never reach this component at all, which is
// the point: a budget that interrupts constantly is one people click through
// without reading.
import { OyaModal, formatPrice } from "rakotis";
import { manaConfirm, resolveManaConfirm } from "./useMana";
</script>

<template>
  <OyaModal :open="manaConfirm !== null" @close="resolveManaConfirm(false)">
    <div
      v-if="manaConfirm"
      class="max-h-[85dvh] w-full max-w-sm space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      data-testid="mana-confirm"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="shield-halved" class="opacity-60" />{{ $t("mana.confirmTitle") }}
      </p>

      <div class="flex items-center gap-3">
        <span
          class="shrink-0 rounded-lg border border-warn-light px-3 py-1.5 text-base font-bold tabular-nums text-warn-light dark:border-warn-dark dark:text-warn-dark"
          data-testid="mana-confirm-price"
        >
          {{ formatPrice(manaConfirm.centi) }}
        </span>
        <span class="min-w-0 text-sm font-semibold">{{ manaConfirm.label }}</span>
      </div>

      <!-- The same one sentence the info dot shows. Repeated rather than expanded:
           the explanation should not change depending on where you meet it. -->
      <p v-if="manaConfirm.explain" class="text-sm leading-relaxed opacity-80">
        {{ manaConfirm.explain }}
      </p>

      <p
        v-if="manaConfirm.exhausted"
        class="rounded-lg border border-highlight/40 bg-highlight/10 p-3 text-sm leading-relaxed"
        data-testid="mana-confirm-exhausted"
      >
        {{ $t("mana.confirmExhausted") }}
      </p>

      <!-- Says out loud what a meter cannot: this is a mirror, not a protection.
           Nothing here has undone the exposure it is about to record. -->
      <p class="text-xs leading-relaxed opacity-60">{{ $t("mana.advisoryNote") }}</p>
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        @click="resolveManaConfirm(false)"
      >
        {{ $t("common.cancel") }}
      </button>
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        data-testid="mana-confirm-continue"
        @click="resolveManaConfirm(true)"
      >
        {{ $t("mana.confirmContinue") }}
      </button>
    </template>
  </OyaModal>
</template>
