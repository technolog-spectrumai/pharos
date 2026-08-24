<script setup lang="ts">
// The always-visible budget: "⛨ 87" in the sticky header.
//
// TODAY'S balance only. The weekly figure used to sit beside it, but two numbers
// separated by a dot in a cramped app bar read as one number and invite the
// wrong one to be scanned. Today's is the one that moves on the timescale a
// glance is useful over; the weekly meter — and everything else — is one tap
// away on the welcome page.
import { useRouter } from "vue-router";
import { formatMana, meterBand } from "rakotis";
import { manaBalances, manaLoaded } from "./useMana";
import { PRIVACY_PATH } from "../../tabs";

const router = useRouter();

/**
 * The shield and the number are one control, and this chip is Privacy's ONLY
 * entrance — there is no nav tab beside it (see `PRIVACY_PATH`). So the route is
 * ungated and this can never fail to lead somewhere.
 */
function openPrivacy() {
  router.push(PRIVACY_PATH);
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
    v-if="manaLoaded"
    type="button"
    class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-current/20 px-2 py-1 text-xs font-bold tabular-nums transition hover:opacity-100"
    :class="bandClass[meterBand(manaBalances.daily)]"
    :title="$t('mana.chipTitle')"
    :aria-label="$t('mana.chipTitle')"
    data-testid="mana-chip"
    @click="openPrivacy()"
  >
    <font-awesome-icon icon="shield-halved" />
    <span data-testid="mana-chip-daily">{{ formatMana(manaBalances.daily.balanceCenti) }}</span>
  </button>
</template>
