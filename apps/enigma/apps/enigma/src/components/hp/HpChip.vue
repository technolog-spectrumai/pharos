<script setup lang="ts">
// The always-visible budget: "⛨ 87" in the sticky header.
//
// TODAY'S balance only. The weekly figure used to sit beside it, but two numbers
// separated by a dot in a cramped app bar read as one number and invite the
// wrong one to be scanned. Today's is the one that moves on the timescale a
// glance is useful over; the weekly meter — and everything else — is one tap
// away on the welcome page.
import { useRouter } from "vue-router";
import { formatHp, meterBand } from "rakotis";
import { hpBalances, hpLoaded } from "./useHp";
import { isTabVisible } from "../../tabs";

const router = useRouter();

/**
 * The shield and the number are one control: tapping either opens Privacy.
 *
 * If the user has hidden that tab, fall back to the welcome page — which carries
 * the same meters — rather than to a route the guard would bounce. A chip that
 * did nothing, or that landed somewhere unrelated, would be worse than no chip.
 */
function openPrivacy() {
  router.push(isTabVisible("privacy") ? "/privacy" : "/welcome");
}

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
    @click="openPrivacy()"
  >
    <font-awesome-icon icon="shield-halved" />
    <span data-testid="hp-chip-daily">{{ formatHp(hpBalances.daily.balanceCenti) }}</span>
  </button>
</template>
