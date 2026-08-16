<script setup lang="ts">
// Settings — the system palette.
//
// Five roles, one colour each. Free choice: whatever is picked here is what
// every document, drawing and slide uses AND stores, with no per-theme variant
// and no conversion anywhere along the way. That is the whole reason the
// defaults are mid-tone — a role has to read on white paper and on black.
//
// Body text is absent on purpose: black on light and white on dark, and
// nothing else, because it is the one colour every document's legibility rests
// on. The row at the bottom states it rather than offering it.
import { useI18n } from "vue-i18n";
import { SYSTEM_ROLES, PRIMARY_TEXT, isHexColor, type SystemRole } from "../systemColors";
import { useSystemColors } from "../useSystemColors";

const { t } = useI18n({ useScope: "global" });
const { palette, mode, set, reset } = useSystemColors();

/** A colour input can only ever produce `#rrggbb`, but it is still a value
 *  arriving from outside — validate rather than trust the widget. */
function onPick(role: SystemRole, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (isHexColor(value)) set(role, value);
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto p-6">
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="gear" class="opacity-60" />
        {{ t("settings.colors.title") }}
      </h2>
      <p class="mt-1 text-sm opacity-70">{{ t("settings.colors.help") }}</p>

      <div class="mt-5 overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1">
        <div v-for="role in SYSTEM_ROLES" :key="role"
             class="flex items-center gap-3 border-b border-current/10 px-4 py-2.5 last:border-0"
             :data-testid="`role-${role}`">
          <input type="color"
                 class="h-8 w-14 shrink-0 cursor-pointer rounded border border-accent-2 bg-transparent dark:border-accent-1"
                 :value="palette[role]"
                 :data-testid="`color-${role}`"
                 :aria-label="t(`settings.colors.roles.${role}`)"
                 :title="palette[role]"
                 @input="onPick(role, $event)" />
          <span class="flex-1 text-sm font-semibold">{{ t(`settings.colors.roles.${role}`) }}</span>
          <!-- The value in words, so a colour is identifiable without relying
               on the swatch alone. -->
          <code class="text-xs opacity-50">{{ palette[role] }}</code>
        </div>
      </div>

      <!-- Stated, not offered. -->
      <div class="mt-3 flex items-center gap-2 rounded-xl border border-dashed border-accent-2 px-4 py-2.5 text-sm dark:border-accent-1"
           data-testid="primary-text">
        <span class="h-3.5 w-3.5 rounded-full border border-current/25"
              :style="{ backgroundColor: PRIMARY_TEXT[mode] }" />
        <span class="font-semibold">{{ t("settings.colors.primaryText") }}</span>
        <span class="opacity-60">{{ t("settings.colors.primaryTextNote") }}</span>
      </div>

      <button type="button" data-testid="colors-reset"
              class="mt-4 rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:opacity-80 dark:border-accent-1"
              @click="reset()">
        <font-awesome-icon icon="rotate-left" /> {{ t("settings.colors.reset") }}
      </button>
    </div>
  </div>
</template>
