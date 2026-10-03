<script setup lang="ts">
// What an act does to Security Mana, in words: decrypting adds a drain for as
// long as the file stays plain, encrypting takes one away. Shown inside the
// dialog that already asks for something (a passphrase, a folder run) so one
// act never needs two dialogs. Rates come from Rust (`mana_rate`).
import { useI18n } from "vue-i18n";
import { formatMana, manaStatus } from "./mana";

defineProps<{
  /** Mana an hour. */
  perHour: number;
  /** `adds`: the act leaves plaintext behind. `saves`: it removes some. */
  direction: "adds" | "saves";
}>();
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <div class="rounded-lg border border-accent-2 px-3 py-2 text-xs dark:border-accent-1" data-testid="mana-cost">
    <p class="font-semibold" data-testid="mana-rate">
      <font-awesome-icon icon="droplet" class="mr-1 opacity-70" />
      {{ t(direction === "adds" ? "mana.adds" : "mana.saves", { rate: formatMana(perHour) }) }}
    </p>
    <p v-if="manaStatus" class="mt-0.5 opacity-70" data-testid="mana-now">
      {{ t("mana.now", { level: formatMana(manaStatus.level), max: manaStatus.max,
                         drain: formatMana(manaStatus.drainPerHour), regen: formatMana(manaStatus.regenPerHour) }) }}
    </p>
    <p v-if="manaStatus?.exhausted && direction === 'adds'" class="mt-1 text-warn-dark" data-testid="mana-exhausted">
      {{ t("mana.exhausted") }}
    </p>
    <p class="mt-1 opacity-50">{{ t("mana.advisory") }}</p>
  </div>
</template>
