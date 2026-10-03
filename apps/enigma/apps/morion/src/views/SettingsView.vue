<script setup lang="ts">
// Settings, in three tabs:
//   * Colours — the system palette;
//   * System — how the app itself behaves: the search algorithm, and the
//     workspace as one password-protected archive, out and back in;
//   * Protection — what a file's markup may do once it is on screen.
// The tab last shown is remembered on this machine; everything on the other
// two stays mounted, so a tab switch loses nothing half-typed.
//
// THE PALETTE. Five roles, one colour each. Free choice: whatever is picked here is what
// every document, drawing and slide uses AND stores, with no per-theme variant
// and no conversion anywhere along the way. That is the whole reason the
// defaults are mid-tone — a role has to read on white paper and on black.
//
// Body text is absent on purpose: black on light and white on dark, and
// nothing else, because it is the one colour every document's legibility rests
// on. The row at the bottom states it rather than offering it.
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { SYSTEM_ROLES, PRIMARY_TEXT, isHexColor, type SystemRole } from "petalite/theme";
import { useSystemColors } from "petalite/theme";
import { useMarkupSafety, type MarkupSwitch } from "../security/useMarkupSafety";
import { SEARCH_MODES, useSearchMode } from "../files/searchSettings";
import ArchiveModal from "../files/ArchiveModal.vue";
import { useWorkspace } from "petalite/files";
import { refreshMana } from "../security/mana";

const { t } = useI18n({ useScope: "global" });
const { palette, mode, set, reset } = useSystemColors();

// Off by default and offered here rather than assumed, because isolation is not
// free: every raw-markup block gets a shadow root of its own. Whether that is
// noticeable on a large deck is a question this switch exists to answer.
const markup = useMarkupSafety();

/** The three switches, in the order they escalate: where the markup goes, then
 *  what is taken out of it. Rendered from a list so a fourth is one entry. */
const SWITCHES: readonly MarkupSwitch[] = ["isolate", "blockStyles", "blockScripts"];

// How the search box asks: names and tags only, text too, or both ranked.
const search = useSearchMode();

// ── the workspace archive ───────────────────────────────────────────────────
const workspace = useWorkspace();
const archiveOpen = ref(false);
const archiveMode = ref<"export" | "import">("export");

function openArchive(which: "export" | "import") {
  archiveMode.value = which;
  archiveOpen.value = true;
}

/** Files came in: the tree, the padlocks and the Mana bar follow. */
async function afterImport() {
  await workspace.refresh();
  await refreshMana();
}

// ── the tabs ────────────────────────────────────────────────────────────────
const TABS = [
  { id: "colors", icon: "palette" },
  { id: "system", icon: "gear" },
  { id: "protection", icon: "shield-halved" },
] as const;
type Tab = (typeof TABS)[number]["id"];
const TAB_KEY = "zinnia:settingsTab";

function remembered(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.some((tab) => tab.id === saved) ? (saved as Tab) : "colors";
  } catch {
    return "colors";
  }
}
const tab = ref<Tab>(remembered());

function show(which: Tab) {
  tab.value = which;
  try { localStorage.setItem(TAB_KEY, which); } catch { /* a convenience only */ }
}

/** The arrow keys move along the tabs and Home/End jump to the ends — the
 *  ARIA tabs pattern — and focus follows, so the keyboard is never left on a
 *  tab that is no longer selected. */
function onTabKey(event: KeyboardEvent) {
  const at = TABS.findIndex((x) => x.id === tab.value);
  const to = event.key === "ArrowRight" ? (at + 1) % TABS.length
    : event.key === "ArrowLeft" ? (at + TABS.length - 1) % TABS.length
    : event.key === "Home" ? 0
    : event.key === "End" ? TABS.length - 1
    : -1;
  if (to < 0) return;
  event.preventDefault();
  show(TABS[to].id);
  // By id, not a v-for ref array: Vue does not promise that array's order.
  document.getElementById(`settings-tab-${TABS[to].id}`)?.focus();
}

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
      <div role="tablist" :aria-label="t('settings.tabs.label')" data-testid="settings-tabs"
           class="mb-6 flex gap-1 border-b border-accent-2 dark:border-accent-1" @keydown="onTabKey">
        <button v-for="spec in TABS" :id="`settings-tab-${spec.id}`" :key="spec.id"
                type="button" role="tab" :data-testid="`settings-tab-${spec.id}`"
                :aria-selected="tab === spec.id" :aria-controls="`settings-panel-${spec.id}`"
                :tabindex="tab === spec.id ? 0 : -1"
                class="-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition"
                :class="tab === spec.id
                  ? 'border-accent-light font-semibold dark:border-accent-dark'
                  : 'border-transparent opacity-60 hover:opacity-100'"
                @click="show(spec.id)">
          <font-awesome-icon :icon="spec.icon" class="opacity-70" />
          {{ t(`settings.tabs.${spec.id}`) }}
        </button>
      </div>

      <!-- ── Colours ───────────────────────────────────────────────────── -->
      <section v-show="tab === 'colors'" id="settings-panel-colors" role="tabpanel"
               aria-labelledby="settings-tab-colors" data-testid="settings-panel-colors">
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="palette" class="opacity-60" />
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
      </section>

      <!-- ── System ────────────────────────────────────────────────────── -->
      <section v-show="tab === 'system'" id="settings-panel-system" role="tabpanel"
               aria-labelledby="settings-tab-system" data-testid="settings-panel-system">
      <!-- how the search box asks -->
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="magnifying-glass" class="opacity-60" />
        {{ t("settings.search.title") }}
      </h2>
      <p class="mt-1 text-sm opacity-70">{{ t("settings.search.help") }}</p>

      <div class="mt-5 overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1"
           data-testid="search-modes" role="radiogroup">
        <label v-for="which in SEARCH_MODES" :key="which"
               class="flex cursor-pointer items-start gap-3 border-b border-current/10 px-4 py-3 last:border-0"
               :data-testid="`search-mode-row-${which}`">
          <input type="radio" name="search-mode" class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent-light dark:accent-accent-dark"
                 :data-testid="`search-mode-${which}`" :value="which"
                 :checked="search.mode.value === which"
                 @change="search.set(which)" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold">{{ t(`settings.search.modes.${which}.label`) }}</span>
            <span class="mt-0.5 block text-sm opacity-70">{{ t(`settings.search.modes.${which}.note`) }}</span>
          </span>
        </label>
      </div>
      <p class="mt-2 text-xs opacity-60" data-testid="search-privacy-note">{{ t("settings.search.privacy") }}</p>

      <!-- the workspace as one archive, out and back in -->
      <h2 class="mt-10 flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="file-export" class="opacity-60" />
        {{ t("archive.title") }}
      </h2>
      <p class="mt-1 text-sm opacity-70">{{ t("archive.help") }}</p>
      <div class="mt-4 flex flex-wrap gap-2" data-testid="archive-actions">
        <button type="button" data-testid="archive-export" :disabled="!workspace.root.value"
                class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:bg-accent-light/10
                       disabled:opacity-40 dark:border-accent-1"
                @click="openArchive('export')">
          <font-awesome-icon icon="file-export" class="mr-1.5 opacity-70" />{{ t("archive.export") }}
        </button>
        <button type="button" data-testid="archive-import" :disabled="!workspace.root.value"
                class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:bg-accent-light/10
                       disabled:opacity-40 dark:border-accent-1"
                @click="openArchive('import')">
          <font-awesome-icon icon="file-import" class="mr-1.5 opacity-70" />{{ t("archive.import") }}
        </button>
      </div>
      <p v-if="!workspace.root.value" class="mt-2 text-xs opacity-60" data-testid="archive-no-workspace">
        {{ t("workspace.errors.no_workspace") }}
      </p>
      <ArchiveModal v-if="workspace.root.value" :open="archiveOpen" :mode="archiveMode" :root="workspace.root.value"
                    @update:open="archiveOpen = $event" @imported="afterImport" />
      </section>

      <!-- ── Protection ────────────────────────────────────────────────── -->
      <section v-show="tab === 'protection'" id="settings-panel-protection" role="tabpanel"
               aria-labelledby="settings-tab-protection" data-testid="settings-panel-protection">
      <!-- isolating what a file brings with it -->
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="shield-halved" class="opacity-60" />
        {{ t("settings.markup.title") }}
      </h2>
      <p class="mt-1 text-sm opacity-70">{{ t("settings.markup.help") }}</p>

      <div class="mt-5 overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1"
           data-testid="markup-safety">
        <label v-for="which in SWITCHES" :key="which"
               class="flex cursor-pointer items-start gap-3 border-b border-current/10 px-4 py-3 last:border-0"
               :data-testid="`switch-row-${which}`">
          <input type="checkbox" class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent-light dark:accent-accent-dark"
                 :data-testid="`switch-${which}`"
                 :checked="markup[which].value"
                 @change="markup.set(which, ($event.target as HTMLInputElement).checked)" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold">{{ t(`settings.markup.${which}.label`) }}</span>
            <span class="mt-0.5 block text-sm opacity-70">{{ t(`settings.markup.${which}.note`) }}</span>
          </span>
        </label>
      </div>
      </section>

    </div>
  </div>
</template>
