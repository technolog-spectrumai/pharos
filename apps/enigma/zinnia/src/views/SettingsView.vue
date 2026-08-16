<script setup lang="ts">
// Settings — deliberately empty for now.
//
// The tab exists ahead of its contents because it is where the things already
// in the header (theme, language) belong, and where the platform connection
// will go once the API layer is wired back up. Landing those one at a time into
// a tab that already exists beats moving the header around later.
import { useI18n } from "vue-i18n";

const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
    <font-awesome-icon icon="gear" class="text-3xl opacity-30" />
    <p class="text-sm font-semibold">{{ t("nav.settings") }}</p>
    <p class="max-w-sm text-sm opacity-60">{{ t("settings.empty") }}</p>
  </div>
</template>
