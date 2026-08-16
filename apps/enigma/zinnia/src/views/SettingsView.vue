<script setup lang="ts">
// Settings — the system palette.
//
// Five roles, two values each, because a role has to read on both papers: the
// light column is what a document uses on white, the dark column what it uses
// on black. Both are editable here regardless of which theme is on, so a user
// can set up dark mode without having to switch into it and back.
//
// Body text is absent on purpose: it is black on light and white on dark and
// nothing else, since it is the one colour the legibility of every document
// depends on. The row at the bottom shows it as a fact, not a control.
import { useI18n } from "vue-i18n";
import { SYSTEM_ROLES, PRIMARY_TEXT, isHexColor, type Mode, type SystemRole } from "../systemColors";
import { useSystemColors } from "../useSystemColors";

const { t } = useI18n({ useScope: "global" });
const { palette, mode, set, reset } = useSystemColors();

const MODES: Mode[] = ["light", "dark"];

/** A colour input can only ever produce `#rrggbb`, but it is still the user's
 *  value arriving from outside — validate rather than trust the widget. */
function onPick(role: SystemRole, forMode: Mode, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (isHexColor(value)) set(role, forMode, value);
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
        <div class="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b
                    border-current/10 px-4 py-2 text-xs font-semibold uppercase opacity-60">
          <span>{{ t("settings.colors.role") }}</span>
          <span class="text-center">{{ t("settings.colors.light") }}</span>
          <span class="text-center">{{ t("settings.colors.dark") }}</span>
        </div>

        <div v-for="role in SYSTEM_ROLES" :key="role"
             class="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-current/10 px-4 py-2.5 last:border-0"
             :data-testid="`role-${role}`">
          <span class="flex items-center gap-2 text-sm">
            <!-- The chip shows the role as it renders in the CURRENT theme, so
                 the name is never the only clue to what was picked. -->
            <span class="h-3.5 w-3.5 rounded-full border border-current/25"
                  :style="{ backgroundColor: palette[role][mode] }" />
            {{ t(`settings.colors.roles.${role}`) }}
          </span>
          <input v-for="m in MODES" :key="m" type="color"
                 class="h-8 w-14 cursor-pointer rounded border border-accent-2 bg-transparent dark:border-accent-1"
                 :value="palette[role][m]"
                 :data-testid="`color-${role}-${m}`"
                 :aria-label="`${t(`settings.colors.roles.${role}`)} — ${t(`settings.colors.${m}`)}`"
                 :title="palette[role][m]"
                 @input="onPick(role, m, $event)" />
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
