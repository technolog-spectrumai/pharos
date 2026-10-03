<script setup lang="ts">
// The one "this leaves plaintext behind" confirmation. Mounted once by App;
// opened through `askMana` in ./mana, for an act with no dialog of its own.
// Continue is never disabled — the budget informs, it does not decide.
import { useI18n } from "vue-i18n";
import ModalPanel from "petalite/ModalPanel.vue";
import { OyaModal } from "petalite/primitives";
import ManaCost from "./ManaCost.vue";
import { answerMana, manaAsk } from "./mana";

const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <OyaModal :open="manaAsk !== null" @close="answerMana(false)">
    <ModalPanel v-if="manaAsk" :title="t('mana.confirmTitle')">
      <p class="truncate text-xs opacity-60">{{ manaAsk.name }}</p>
      <p class="text-sm" data-testid="mana-consequence">{{ t(manaAsk.consequenceKey) }}</p>
      <ManaCost v-if="manaAsk.adds !== null" :per-hour="manaAsk.adds" direction="adds" />
      <div class="flex justify-end gap-2">
        <button type="button" data-testid="mana-cancel"
                class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1"
                @click="answerMana(false)">{{ t("common.cancel") }}</button>
        <button type="button" data-testid="mana-continue"
                class="rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light
                       transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
                @click="answerMana(true)">{{ t("mana.continue") }}</button>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
