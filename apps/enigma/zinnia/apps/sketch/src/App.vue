<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { brand } from "./config";
import { i18n, setLocale, type Locale } from "./i18n";
import { APP_TABS, DEFAULT_TAB, type AppTabId, type EditorKind } from "./tabs";
import EditorHost from "./views/EditorHost.vue";
import FilesPanel from "./files/FilesPanel.vue";
import SecurityView from "padova/SecurityView.vue";
// Padova's Security tab is app-agnostic: it takes the workspace it should list
// rather than importing one, so the app decides which store it sees. This is
// the same singleton the files sidepanel drives — one tree, two views.
import { filterRows, useWorkspace } from "petalite/files";
import SettingsView from "./views/SettingsView.vue";
import CollabPanel from "./collab/CollabPanel.vue";
import { collab } from "./collab";
import { collabAvailable } from "./collab/transport";

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

// ── tabs ────────────────────────────────────────────────────────────────────
// No router, and that is the point: each editor tab holds an open file with an
// unsaved buffer in it, and a router would unmount the losing tab on every
// switch. Enigma can route because its views are re-derivable; a half-written
// document is not.
//
// Two pieces of state, and the pair is what makes this cheap AND safe:
//   `active`  — what you see now;
//   `visited` — which tabs have ever been opened, so a tab is CREATED lazily
//               (Univer alone is ~5 MB and mounts a React tree) and never
//               destroyed afterwards.
const active = ref<AppTabId>(DEFAULT_TAB);
const visited = ref<Set<AppTabId>>(new Set([DEFAULT_TAB]));

function show(id: AppTabId) {
  const next = new Set(visited.value); // a Set mutated in place is not reactive
  next.add(id);
  visited.value = next;
  active.value = id;
}

const editorTabs = computed(() => APP_TABS.filter((tab) => tab.kind !== null));

// ── the one gated tab ───────────────────────────────────────────────────────
// Collaboration is a Cargo feature, off by default, and a build without it has
// none of the commands the Collab tab calls. The tab list cannot know what the
// backend was built with, so it asks — one probe at start-up — and the tab is
// simply absent otherwise, rather than present with every button failing.
const collabOn = ref(false);
onMounted(async () => {
  collabOn.value = await collabAvailable();
});
const visibleTabs = computed(() => APP_TABS.filter((tab) => tab.id !== "collab" || collabOn.value));

// ── the files sidepanel ─────────────────────────────────────────────────────
// Beside the editor rather than instead of it. Remembered, because whether you
// want a file browser on screen is a working habit, not a per-session decision;
// hidden on Settings, which holds no file for the panel to hand it.
const filesOpen = ref(localStorage.getItem("zinnia:files") !== "0");
watch(filesOpen, (on) => localStorage.setItem("zinnia:files", on ? "1" : "0"));

/** The one workspace, handed to Padova's tab. Resolved once here rather than
 *  inside the tab, because the store is the app's and the tab is a package's. */
const securityWorkspace = useWorkspace();

const showFiles = computed(() =>
  filesOpen.value && APP_TABS.some((tab) => tab.id === active.value && tab.kind !== null));

// ── the file menu ───────────────────────────────────────────────────────────
// New/Open/Save/Save As belong to the OPEN FILE, and every editor tab has its
// own. So the menu does not hold any file state — it finds the host of the tab
// currently on screen and calls into it. One menu, N files, no third copy of
// "is this dirty" to keep in step.
type ExportCommand = { labelKey: string; icon: string; run: () => void };

type Host = {
  newFile: () => void;
  openFile: () => void;
  saveFile: () => void;
  saveAs: () => void;
  /** Extra file commands the mounted editor offers — a PNG, a PDF. Zero or
   *  more, so a tab that has none adds nothing to the menu. */
  exports: ExportCommand[];
  openRemote: (name: string, content: string) => void;
  name: string;
  dirty: boolean;
  busy: boolean;
  canSave: boolean;
  notice: string;
  fileError: string;
};

// The registry is a PLAIN object and the reactive part is a counter, because
// what the menu needs to react to is "a host mounted or unmounted", not every
// keystroke inside one. Storing component instances in a ref would make Vue
// walk them, and reassigning that ref during render is what turns a template
// ref into an infinite update loop.
const hostRegistry: Record<string, Host | null> = {};
const hostVersion = ref(0);

function setHost(id: AppTabId, el: unknown) {
  const next = (el as Host | null) ?? null;
  if (hostRegistry[id] === next) return; // idempotent: refs fire on re-render too
  hostRegistry[id] = next;
  hostVersion.value++;
}

/** One stable callback per tab.
 *
 *  An inline `:ref="(el) => …"` is a NEW function every render, and Vue treats
 *  a changed ref function as a different ref: it calls the old one with null
 *  and the new one with the instance, on every single update. With a write in
 *  there, the render mutates its own dependency and never settles — which is
 *  exactly the "Maximum recursive updates exceeded" this first shipped as. */
const hostSetters = new Map<AppTabId, (el: unknown) => void>();
function setterFor(id: AppTabId) {
  let fn = hostSetters.get(id);
  if (!fn) {
    fn = (el: unknown) => setHost(id, el);
    hostSetters.set(id, fn);
  }
  return fn;
}

const activeHost = computed<Host | null>(() => {
  void hostVersion.value; // the dependency; the registry itself is not reactive
  return hostRegistry[active.value] ?? null;
});

/** A file picked in the sidepanel, routed to the editor that understands it.
 *
 *  The tab it belongs to has to be MOUNTED before its host exists — hosts
 *  register through a template ref — so this shows the tab first and hands the
 *  buffer over on the next tick. */
async function openFromFiles(payload: { kind: EditorKind; name: string; content: string }) {
  show(payload.kind);
  await nextTick();
  hostRegistry[payload.kind]?.openRemote(payload.name, payload.content);
}

const menuOpen = ref(false);

const MENU_ITEMS = [
  { id: "new", labelKey: "file.new", icon: "file-circle-plus", run: (h: Host) => h.newFile() },
  { id: "open", labelKey: "file.open", icon: "folder-open", run: (h: Host) => h.openFile() },
  { id: "save", labelKey: "file.save", icon: "floppy-disk", run: (h: Host) => h.saveFile() },
  { id: "saveAs", labelKey: "file.saveAs", icon: "file-pen", run: (h: Host) => h.saveAs() },
] as const;

/** Shown only when the tab on screen offers any — the sketch's PNG, the
 *  writer's PDF. An entry that was always present and usually inert would be
 *  worse than one that arrives with the tab it belongs to. */
const exportItems = computed<ExportCommand[]>(() => activeHost.value?.exports ?? []);

function runCommand(item: (typeof MENU_ITEMS)[number]) {
  const host = activeHost.value;
  menuOpen.value = false;
  if (!host) return;
  item.run(host);
}

/** Save is the one command that can be a no-op: an unchanged file that has
 *  already been written has nothing to write. The others always apply. */
function isDisabled(id: string): boolean {
  const host = activeHost.value;
  if (!host) return true; // Settings has no file
  if (host.busy) return true;
  return id === "save" && !host.canSave;
}
</script>

<template>
  <div class="flex h-screen flex-col bg-primary-bg-light text-text-main-light
              dark:bg-primary-bg-dark dark:text-text-main-dark transition-colors">
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 border-accent-2 dark:border-accent-1">
      <!-- The menu button stands where the wordmark used to. Escape closes it;
           the backdrop below catches an outside click without a document-level
           listener to leak. -->
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
             class="absolute left-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-xl border shadow-xl
                    border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark">
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
                  :disabled="activeHost?.busy"
                  @click="menuOpen = false; item.run()">
            <font-awesome-icon :icon="item.icon" class="w-4 opacity-70" />
            {{ t(item.labelKey) }}
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

      <!-- The open file, which the deleted file bar used to show. -->
      <p v-if="activeHost" class="flex min-w-0 items-center gap-1.5">
        <span class="truncate text-sm font-semibold" data-testid="file-name">{{ activeHost.name }}</span>
        <span v-if="activeHost.dirty" class="shrink-0 opacity-60" :title="t('file.unsavedTitle')">•</span>
      </p>
      <!-- The session runs on whichever tab is showing; say so where the file
           name is, so nobody draws for a while without knowing it is shared. -->
      <span v-if="collab.phase.value === 'live'" class="shrink-0 text-xs opacity-70"
            :title="t('collab.live')" data-testid="collab-badge">
        <font-awesome-icon icon="user-group" />
      </span>

      <nav class="flex flex-1 flex-wrap items-center gap-1 pl-3">
        <button v-for="tab in visibleTabs" :key="tab.id" type="button"
                :data-testid="`nav-${tab.id}`"
                class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-sm font-semibold transition"
                :class="active === tab.id
                  ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                  : 'opacity-60 hover:opacity-100'"
                @click="show(tab.id)">
          <font-awesome-icon :icon="tab.icon" />
          <span class="hidden sm:inline">{{ t(tab.labelKey) }}</span>
        </button>
      </nav>

      <p v-if="activeHost?.notice" class="shrink-0 text-xs opacity-60">{{ activeHost.notice }}</p>
      <p v-if="activeHost?.fileError" class="min-w-0 truncate text-xs text-warn-dark" data-testid="file-error">
        {{ activeHost.fileError }}
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
      <FilesPanel v-show="showFiles" class="min-h-0" @open="openFromFiles" />

      <div class="flex min-w-0 min-h-0 flex-1 flex-col">
        <!-- v-if on `visited`, v-show on `active`: created once, then kept alive. -->
        <template v-for="tab in editorTabs" :key="tab.id">
          <EditorHost v-if="visited.has(tab.id)" v-show="active === tab.id"
                      :ref="setterFor(tab.id)"
                      :kind="tab.kind!" :active="active === tab.id" class="min-h-0 flex-1" />
        </template>

        <CollabPanel v-if="visited.has('collab')" v-show="active === 'collab'"
                     :session="collab" class="min-h-0 flex-1" />

        <SecurityView v-if="visited.has('security')" v-show="active === 'security'"
                      :workspace="securityWorkspace" :filter-rows="filterRows"
                      class="min-h-0 flex-1" />

        <SettingsView v-if="visited.has('settings')" v-show="active === 'settings'"
                      class="min-h-0 flex-1" />
      </div>
    </div>
  </div>
</template>
