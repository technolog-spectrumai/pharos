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
import { useWorkspace } from "../files/useWorkspace";

const { t } = useI18n({ useScope: "global" });
const { palette, mode, set, reset } = useSystemColors();

// The same store the sidepanel drives, not a copy: picking a folder here has to
// be the picking the panel already does, or the two would disagree about which
// folder is open.
//
// There is NO text field for the path, and that is not an oversight. The folder
// picker is what widens the app's filesystem grant to the folder you chose —
// a path typed in here would be remembered and then refuse to read, which is a
// worse answer than not offering it.
const workspace = useWorkspace();

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

      <!-- ── the workspace folder ──────────────────────────────────────── -->
      <h2 class="mt-10 flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="folder-open" class="opacity-60" />
        {{ t("settings.workspace.title") }}
      </h2>
      <p class="mt-1 text-sm opacity-70">{{ t("files.pickWorkspaceHint") }}</p>

      <div class="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-accent-2 px-4 py-3 dark:border-accent-1"
           data-testid="workspace-row">
        <!-- The path in full, wrapping rather than truncating: a folder you
             cannot read all of is a folder you cannot check. -->
        <span v-if="workspace.root.value" class="min-w-0 flex-1">
          <code class="block break-all text-xs" data-testid="workspace-path">{{ workspace.root.value }}</code>
          <!-- Stated here as well as in the panel: this is the screen someone
               comes to when the panel says it cannot read the folder. -->
          <span v-if="workspace.unreadable.value" class="mt-1 block text-xs text-warn-dark"
                data-testid="workspace-unreadable">
            {{ t("files.unreadable") }} {{ t("files.unreadableHint") }}
          </span>
        </span>
        <span v-else class="min-w-0 flex-1 text-sm opacity-60" data-testid="workspace-none">
          {{ t("settings.workspace.none") }}
        </span>

        <button type="button" data-testid="workspace-pick"
                class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
                @click="workspace.pickRoot()">
          {{ t(workspace.root.value ? "files.changeWorkspace" : "files.pickWorkspace") }}
        </button>
        <button v-if="workspace.root.value" type="button" data-testid="workspace-forget"
                class="shrink-0 rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:opacity-80 dark:border-accent-1"
                @click="workspace.clearRoot()">
          {{ t("settings.workspace.forget") }}
        </button>
      </div>
    </div>
  </div>
</template>
