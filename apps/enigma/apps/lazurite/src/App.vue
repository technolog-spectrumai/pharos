<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { brand } from "./config";
import { i18n, setLocale, type Locale } from "./i18n";
import { NEW_FILE_KINDS, type EditorKind } from "./kinds";
import EditorHost from "./views/EditorHost.vue";
import FilesPanel from "./files/FilesPanel.vue";
import SecurityView from "padova/SecurityView.vue";
// Padova's Security view is app-agnostic: it takes the workspace it should list
// rather than importing one, so the app decides which store it sees. This is
// the same singleton the files sidepanel drives — one tree, two views.
import { filterRows, useWorkspace } from "petalite/files";
import SettingsView from "./views/SettingsView.vue";

const { t } = useI18n({ useScope: "global" });

// Dark mode as a plain ref plus the `.dark` class — the class is what every
// `dark:` utility reacts to. Persisted; the initial guess follows the OS.
const dark = ref(
  localStorage.getItem("zinnia:dark") === null
    ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
    : localStorage.getItem("zinnia:dark") === "1",
);
watch(dark, (on) => {
  document.documentElement.classList.toggle("dark", on);
  localStorage.setItem("zinnia:dark", on ? "1" : "0");
}, { immediate: true });

function switchLocale() {
  setLocale((i18n.global.locale.value === "en" ? "pl" : "en") as Locale);
}

// ── views ───────────────────────────────────────────────────────────────────
// There are no editor tabs. The editor host is ONE component that picks its
// editor from whatever file is open (see views/EditorHost.vue), so the only
// thing left to switch between is what is on screen instead of it: Security
// or Settings, both reached from the menu.
//
// The host is mounted once and never destroyed — a half-written document must
// survive a look at Settings — and the two views are created the first time
// they are asked for, then kept, exactly as the old tabs were.
type View = "editor" | "security" | "settings";
const view = ref<View>("editor");
const visited = ref<Set<View>>(new Set(["editor"]));

function showView(id: View) {
  const next = new Set(visited.value); // a Set mutated in place is not reactive
  next.add(id);
  visited.value = next;
  view.value = id;
}

const VIEW_LABELS: Record<Exclude<View, "editor">, { labelKey: string; icon: string }> = {
  security: { labelKey: "nav.security", icon: "shield-halved" },
  settings: { labelKey: "nav.settings", icon: "gear" },
};

// ── the files sidepanel ─────────────────────────────────────────────────────
// Beside the editor rather than instead of it. Remembered, because whether you
// want a file browser on screen is a working habit, not a per-session decision;
// hidden behind Security and Settings, which hold no file for it to hand over.
const filesOpen = ref(localStorage.getItem("zinnia:files") !== "0");
watch(filesOpen, (on) => localStorage.setItem("zinnia:files", on ? "1" : "0"));

/** The one workspace, handed to Padova's view. Resolved once here rather than
 *  inside it, because the store is the app's and the view is a package's. */
const securityWorkspace = useWorkspace();

const showFiles = computed(() => filesOpen.value && view.value === "editor");

// ── the file menu ───────────────────────────────────────────────────────────
// New/Open/Save/Save As belong to the open file, and the host owns it. So the
// menu holds no file state: it calls into the host.
type ExportCommand = { labelKey: string; icon: string; run: () => void };

type Host = {
  newFile: (kind: EditorKind) => void;
  openFile: () => void;
  saveFile: () => void;
  saveAs: () => void;
  /** Extra file commands the mounted editor offers — a PNG, a PDF. Zero or
   *  more, so an editor that has none adds nothing to the menu. */
  exports: ExportCommand[];
  openLocal: (name: string, path: string, content: string) => void;
  name: string;
  dirty: boolean;
  busy: boolean;
  canSave: boolean;
  hasFile: boolean;
  notice: string;
  fileError: string;
};

/** A plain template ref — one host, mounted once, so none of the per-tab
 *  registry the tabs needed. Exposed refs arrive unwrapped on the instance. */
const hostEl = ref<unknown>(null);
const host = computed<Host | null>(() => (hostEl.value as Host | null) ?? null);

const filesPanel = ref<{ focusSearch(): void } | null>(null);

/** A file picked in the sidepanel or a search hit. The host routes it. */
function openFromFiles(payload: { kind: EditorKind; name: string; path: string; content: string }) {
  showView("editor");
  host.value?.openLocal(payload.name, payload.path, payload.content);
}

/** The start screen's "Search notes": the box lives in the files panel. */
async function startSearch() {
  filesOpen.value = true;
  await nextTick();
  filesPanel.value?.focusSearch();
}

const menuOpen = ref(false);
/** Whether New's four kinds are unfolded inside the menu. */
const newOpen = ref(false);
watch(menuOpen, (open) => { if (!open) newOpen.value = false; });

const MENU_ITEMS = [
  { id: "open", labelKey: "file.open", icon: "folder-open", run: (h: Host) => h.openFile() },
  { id: "save", labelKey: "file.save", icon: "floppy-disk", run: (h: Host) => h.saveFile() },
  { id: "saveAs", labelKey: "file.saveAs", icon: "file-pen", run: (h: Host) => h.saveAs() },
] as const;

/** Shown only when the mounted editor offers any. An entry that was always
 *  present and usually inert would be worse than one that arrives with the
 *  editor it belongs to. */
const exportItems = computed<ExportCommand[]>(() => host.value?.exports ?? []);

/** A file command always acts on the editor, so it brings the editor back on
 *  screen first — Open from Settings means "open a file", not "open one out of
 *  sight". */
function runCommand(item: (typeof MENU_ITEMS)[number]) {
  menuOpen.value = false;
  if (!host.value) return;
  showView("editor");
  item.run(host.value);
}

function runNew(kind: EditorKind) {
  menuOpen.value = false;
  if (!host.value) return;
  showView("editor");
  host.value.newFile(kind);
}

function openView(id: Exclude<View, "editor">) {
  menuOpen.value = false;
  showView(id);
}

/** Save is the one command that can be a no-op: an unchanged file that has
 *  already been written has nothing to write. Save As needs a file to exist. */
function isDisabled(id: string): boolean {
  const h = host.value;
  if (!h || h.busy) return true;
  if (id === "save") return !h.canSave;
  if (id === "saveAs") return !h.hasFile;
  return false;
}
</script>

<template>
  <div class="flex h-screen flex-col bg-primary-bg-light text-text-main-light
              dark:bg-primary-bg-dark dark:text-text-main-dark transition-colors">
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 border-accent-2 dark:border-accent-1">
      <!-- The menu button stands where the wordmark used to. Escape closes it;
           the backdrop below catches an outside click without a document-level
           listener to leak. It is also the only way to Security and Settings:
           the top bar belongs to the open file. -->
      <div class="relative shrink-0" @keydown.esc="menuOpen = false">
        <button type="button" data-testid="app-menu"
                class="relative z-50 inline-flex h-8 w-8 items-center justify-center rounded-lg
                       border border-accent-2 transition hover:opacity-80 dark:border-accent-1"
                :title="brand.name" :aria-label="t('nav.menu')"
                aria-haspopup="menu" :aria-expanded="menuOpen"
                @click="menuOpen = !menuOpen">
          <font-awesome-icon icon="bars" />
        </button>

        <div v-if="menuOpen" class="fixed inset-0 z-40" @click="menuOpen = false" />
        <div v-if="menuOpen" role="menu" data-testid="app-menu-panel"
             class="absolute left-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border shadow-xl
                    border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark">
          <!-- New unfolds in place: the file's kind is the one thing a file
               that does not exist yet cannot tell the app. -->
          <button type="button" role="menuitem" data-testid="menu-new"
                  class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition
                         hover:bg-accent-light/10 disabled:opacity-40 disabled:hover:bg-transparent"
                  :aria-expanded="newOpen" :disabled="isDisabled('new')"
                  @click="newOpen = !newOpen">
            <font-awesome-icon icon="file-circle-plus" class="w-4 opacity-70" />
            <span class="flex-1">{{ t("file.new") }}</span>
            <font-awesome-icon :icon="newOpen ? 'chevron-down' : 'chevron-right'" class="w-3 opacity-50" />
          </button>
          <template v-if="newOpen">
            <button v-for="item in NEW_FILE_KINDS" :key="item.kind" type="button" role="menuitem"
                    :data-testid="`menu-new-${item.kind}`"
                    class="flex w-full items-center gap-2.5 py-1.5 pl-9 pr-3 text-left text-sm transition
                           hover:bg-accent-light/10"
                    @click="runNew(item.kind)">
              <font-awesome-icon :icon="item.icon" class="w-4 opacity-70" />
              {{ t(item.labelKey) }}
            </button>
          </template>

          <button v-for="item in MENU_ITEMS" :key="item.id" type="button" role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition
                         hover:bg-accent-light/10 disabled:opacity-40 disabled:hover:bg-transparent"
                  :data-testid="`menu-${item.id}`"
                  :disabled="isDisabled(item.id)"
                  @click="runCommand(item)">
            <font-awesome-icon :icon="item.icon" class="w-4 opacity-70" />
            {{ t(item.labelKey) }}
          </button>
          <button v-for="(item, i) in exportItems" :key="item.labelKey" type="button" role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm
                         transition hover:bg-accent-light/10 disabled:opacity-40"
                  :class="i === 0 ? 'border-t border-current/10' : ''"
                  :data-testid="i === 0 ? 'menu-export' : `menu-export-${i}`"
                  :disabled="host?.busy"
                  @click="menuOpen = false; item.run()">
            <font-awesome-icon :icon="item.icon" class="w-4 opacity-70" />
            {{ t(item.labelKey) }}
          </button>

          <div class="border-t border-current/10" />
          <button v-for="(spec, id) in VIEW_LABELS" :key="id" type="button" role="menuitem"
                  :data-testid="`menu-${id}`"
                  class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-accent-light/10"
                  @click="openView(id)">
            <font-awesome-icon :icon="spec.icon" class="w-4 opacity-70" />
            {{ t(spec.labelKey) }}
          </button>
        </div>
      </div>

      <button type="button" data-testid="files-toggle"
              class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border
                     transition hover:opacity-80"
              :class="filesOpen
                ? 'border-transparent bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                : 'border-accent-2 dark:border-accent-1'"
              :title="t('files.toggle')" :aria-label="t('files.toggle')"
              :aria-pressed="filesOpen"
              @click="filesOpen = !filesOpen">
        <font-awesome-icon icon="folder-open" />
      </button>

      <!-- What is on screen: the open file with its unsaved marker, or the
           view that is standing in front of it and the way back. -->
      <p v-if="view !== 'editor'" class="flex min-w-0 items-center gap-1.5" data-testid="view-title">
        <font-awesome-icon :icon="VIEW_LABELS[view].icon" class="opacity-70" />
        <span class="truncate text-sm font-semibold">{{ t(VIEW_LABELS[view].labelKey) }}</span>
        <button type="button" data-testid="view-close"
                class="ml-1 inline-flex h-6 w-6 items-center justify-center rounded opacity-60 transition hover:opacity-100"
                :title="t('common.close')" :aria-label="t('common.close')"
                @click="showView('editor')">
          <font-awesome-icon icon="xmark" />
        </button>
      </p>
      <p v-else-if="host?.hasFile" class="flex min-w-0 items-center gap-1.5">
        <span class="truncate text-sm font-semibold" data-testid="file-name">{{ host.name }}</span>
        <span v-if="host.dirty" class="shrink-0 opacity-60" :title="t('file.unsavedTitle')">•</span>
      </p>

      <span class="flex-1" />

      <p v-if="view === 'editor' && host?.notice" class="shrink-0 text-xs opacity-60">{{ host.notice }}</p>
      <p v-if="view === 'editor' && host?.fileError" class="min-w-0 truncate text-xs text-warn-dark" data-testid="file-error">
        {{ host.fileError }}
      </p>

      <button type="button" @click="switchLocale"
              class="rounded-lg border px-2.5 py-1 text-xs border-accent-2 dark:border-accent-1">
        {{ i18n.global.locale.value === "en" ? "PL" : "EN" }}
      </button>
      <!-- Icon, not a word: zenobia's header shows the CURRENT mode (moon while
           dark, sun while light) and this should read the same way across the
           two apps. The label stays for screen readers and the tooltip. -->
      <button type="button" data-testid="dark-toggle" @click="dark = !dark"
              :title="dark ? t('nav.themeDark') : t('nav.themeLight')"
              :aria-label="dark ? t('nav.themeDark') : t('nav.themeLight')"
              class="inline-flex h-7 w-7 items-center justify-center rounded-lg border
                     border-accent-2 transition hover:opacity-80 dark:border-accent-1">
        <font-awesome-icon :icon="dark ? 'moon' : 'sun'" />
      </button>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- The panel is MOUNTED once and hidden, not destroyed: it holds the
           loaded tree and which folders are open, and rebuilding that on every
           toggle would re-read the disk to show what was just on screen. -->
      <FilesPanel ref="filesPanel" v-show="showFiles" class="min-h-0" @open="openFromFiles" />

      <div class="flex min-w-0 min-h-0 flex-1 flex-col">
        <!-- One host, always mounted; hidden, not destroyed, behind a view. -->
        <EditorHost ref="hostEl" v-show="view === 'editor'" :active="view === 'editor'"
                    class="min-h-0 flex-1" @search="startSearch" />

        <SecurityView v-if="visited.has('security')" v-show="view === 'security'"
                      :workspace="securityWorkspace" :filter-rows="filterRows"
                      class="min-h-0 flex-1" />

        <SettingsView v-if="visited.has('settings')" v-show="view === 'settings'"
                      class="min-h-0 flex-1" />
      </div>
    </div>
  </div>
</template>
