<script setup lang="ts">
// What the app shows when no file is open.
//
// Deliberately no editor. The app used to open on an untitled Write document
// because Write was the first tab; with no tabs, defaulting to any one editor
// would be choosing the file's kind for someone who has not said what they
// are about to make. So: make something, open something, or find something.
import { useI18n } from "vue-i18n";
import { brand } from "../config";
import { NEW_FILE_KINDS, type EditorKind } from "../kinds";

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{
  new: [EditorKind];
  open: [];
  search: [];
}>();

const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" data-testid="start">
    <div class="flex w-full max-w-md flex-col gap-5">
      <div>
        <p class="text-lg font-semibold">{{ brand.name }}</p>
        <p class="text-sm opacity-60">{{ t("start.hint") }}</p>
      </div>

      <div class="flex flex-col gap-1.5">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ t("file.new") }}</p>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="item in NEW_FILE_KINDS" :key="item.kind" type="button"
                  :data-testid="`start-new-${item.kind}`" :disabled="busy"
                  class="flex items-center gap-2 rounded-lg border border-accent-2 px-3 py-2 text-left text-sm
                         transition hover:bg-accent-light/10 disabled:opacity-40 dark:border-accent-1"
                  @click="emit('new', item.kind)">
            <font-awesome-icon :icon="item.icon" class="w-4 opacity-70" />
            {{ t(item.labelKey) }}
          </button>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button type="button" data-testid="start-open" :disabled="busy"
                class="inline-flex items-center gap-2 rounded-lg bg-accent-light px-3 py-2 text-sm font-semibold
                       text-primary-bg-light transition hover:opacity-90 disabled:opacity-40
                       dark:bg-accent-dark dark:text-primary-bg-dark"
                @click="emit('open')">
          <font-awesome-icon icon="folder-open" />
          {{ t("file.open") }}
        </button>
        <button type="button" data-testid="start-search"
                class="inline-flex items-center gap-2 rounded-lg border border-accent-2 px-3 py-2 text-sm
                       transition hover:bg-accent-light/10 dark:border-accent-1"
                @click="emit('search')">
          <font-awesome-icon icon="magnifying-glass" />
          {{ t("start.searchNotes") }}
        </button>
      </div>
    </div>
  </div>
</template>
