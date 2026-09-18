<script setup lang="ts">
// A quote, in words: what it costs and what would be left. Used inside the
// confirmation dialog and inside any dialog that already asks for something
// (a passphrase, a folder run, tags) so one action never needs two dialogs.
import { useI18n } from "vue-i18n";
import type { ManaQuote } from "./mana";

defineProps<{ quote: ManaQuote }>();
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <div class="rounded-lg border border-accent-2 px-3 py-2 text-xs dark:border-accent-1" data-testid="mana-cost">
    <p class="font-semibold">
      <font-awesome-icon icon="droplet" class="mr-1 opacity-70" />
      {{ t("mana.cost", { cost: quote.cost }) }}
    </p>
    <p class="mt-0.5 opacity-70" data-testid="mana-after">
      {{ t("mana.after", { daily: quote.dailyAfter, dailyMax: quote.dailyMax, weekly: quote.weeklyAfter, weeklyMax: quote.weeklyMax }) }}
    </p>
    <p v-if="quote.exhausted || quote.dailyAfter === 0 || quote.weeklyAfter === 0"
       class="mt-1 text-warn-dark" data-testid="mana-exhausted">{{ t("mana.exhausted") }}</p>
    <p class="mt-1 opacity-50">{{ t("mana.advisory") }}</p>
  </div>
</template>
