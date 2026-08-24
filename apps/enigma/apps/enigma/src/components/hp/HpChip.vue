<script setup lang="ts">
// The always-visible budget: "⛨ 87 · 631" in the sticky header.
//
// Compact on purpose — two numbers and a shield. The header is already tight at
// phone width, so the weekly figure drops below `sm` and only today's remains;
// the full picture lives one tap away on the welcome page.
import { useRouter } from "vue-router";
import { formatHp, meterBand } from "rakotis";
import { hpBalances, hpLoaded } from "./useHp";

const router = useRouter();

/** Today's band drives the colour: it is the meter that moves fastest, so it is
 *  the one worth reacting to. Cosmetic only — nothing is gated on it. */
const bandClass: Record<string, string> = {
  full: "opacity-70",
  ok: "opacity-90",
  low: "text-highlight",
  empty: "text-warn-dark",
};
</script>

<template>
  <button
    v-if="hpLoaded"
    type="button"
    class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-current/20 px-2 py-1 text-xs font-bold tabular-nums transition hover:opacity-100"
    :class="bandClass[meterBand(hpBalances.daily)]"
    :title="$t('hp.chipTitle')"
    :aria-label="$t('hp.chipTitle')"
    data-testid="hp-chip"
    @click="router.push('/welcome')"
  >
    <font-awesome-icon icon="shield-halved" />
    <span data-testid="hp-chip-daily">{{ formatHp(hpBalances.daily.balanceCenti) }}</span>
    <span class="hidden opacity-50 sm:inline">·</span>
    <span class="hidden sm:inline" data-testid="hp-chip-weekly">
      {{ formatHp(hpBalances.weekly.balanceCenti) }}
    </span>
  </button>
</template>
