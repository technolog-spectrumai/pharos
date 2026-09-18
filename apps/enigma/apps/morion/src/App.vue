<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { brand } from "./config";
import { i18n, setLocale, type Locale } from "./i18n";
import { NEW_FILE_KINDS, type EditorKind } from "./kinds";
import EditorHost from "./views/EditorHost.vue";
import FilesPanel from "./files/FilesPanel.vue";
// Workspace security is contextual: reached from the shield beside the file
// tree, never from the menu. It summarises; the encrypting happens beside the
// files themselves.
import WorkspaceSecurity from "./views/WorkspaceSecurity.vue";
import { baseName, isImageName, useWorkspace } from "petalite/files";

/** A picture is shown, never edited: its shield says so. */
const readOnlyName = isImageName;
import SettingsView from "./views/SettingsView.vue";
import TagModal from "./files/TagModal.vue";
import ManaConfirm from "./security/ManaConfirm.vue";
import { askMana, manaCharge } from "./security/mana";
import { errorText } from "./files/fs";
import { tagsGet } from "./files/tags";

const { t } = useI18n({ useScope: "global" });

/** Whether Rust is there at all: the browser build has no workspace. */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
// thing left to switch between is what is on screen instead of it: Settings,
// from the menu, or workspace security, from the shield beside the file tree.
//
// The host is mounted once and never destroyed — a half-written document must
// survive a look at Settings — and the two views are created the first time
// they are asked for, then kept.
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
  security: { labelKey: "security.workspace.title", icon: "shield-halved" },
  settings: { labelKey: "nav.settings", icon: "gear" },
};

/** What the menu opens. Security is not here: it is the shield beside the
 *  tree, because it is about the folder, not the app. */
const MENU_VIEWS = { settings: VIEW_LABELS.settings } as const;

// ── the files sidepanel ─────────────────────────────────────────────────────
// Beside the editor rather than instead of it. Remembered, because whether you
// want a file browser on screen is a working habit, not a per-session decision;
// hidden behind Security and Settings, which hold no file for it to hand over.
const filesOpen = ref(localStorage.getItem("zinnia:files") !== "0");
watch(filesOpen, (on) => localStorage.setItem("zinnia:files", on ? "1" : "0"));

/** The one workspace: the menu's section, the start screen's prompt and the
 *  folder the security view summarises. */
const workspace = useWorkspace();
/** The recent list, without the folder that is open now. */
const recentWorkspaces = computed(() => workspace.recent.value.filter((p) => p !== workspace.root.value));

const showFiles = computed(() => filesOpen.value && view.value === "editor");

// ── the file menu ───────────────────────────────────────────────────────────
// New/Open/Save/Save As belong to the open file, and the host owns it. So the
// menu holds no file state: it calls into the host.
/** `run` answers whether it wrote a file; a cancelled dialog is `false`. */
type ExportCommand = { labelKey: string; icon: string; run: () => Promise<boolean | void> | void };

type Host = {
  newFile: (kind: EditorKind) => void;
  openFile: () => void;
  saveFile: () => void;
  saveAs: () => void;
  /** Extra file commands the mounted editor offers — a sheet's CSV, a
   *  drawing's PNG. Zero or more, so an editor that has none adds nothing to
   *  the menu. */
  exports: ExportCommand[];
  openLocal: (name: string, path: string, content: string) => void;
  openSealed: (name: string, path: string) => Promise<boolean>;
  encryptFile: () => Promise<boolean>;
  decryptFile: () => Promise<boolean>;
  resync: () => Promise<void>;
  name: string;
  path: string | null;
  /** Bumped on every open and New; what "another file is on screen" means. */
  generation: number;
  dirty: boolean;
  busy: boolean;
  canSave: boolean;
  hasFile: boolean;
  hasPath: boolean;
  hasWorkspace: boolean;
  isSealed: boolean;
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

/** An encrypted file picked in the sidepanel: the host asks for the
 *  passphrase and decrypts it into memory. */
async function openSealedFromFiles(payload: { name: string; path: string }) {
  showView("editor");
  await host.value?.openSealed(payload.name, payload.path);
}

// ── the file shield ─────────────────────────────────────────────────────────
// Encryption is contextual: a shield beside the open file's name says whether
// it is encrypted and offers to encrypt it, or to decrypt it permanently.
const shieldOpen = ref(false);
watch(() => host.value?.name, () => { shieldOpen.value = false; });

/** Why encrypting is not offered right now, as a catalogue key; "" when it is. */
const shieldBlocker = computed(() => {
  const h = host.value;
  if (!h) return "";
  if (!h.hasPath) return "shield.saveFirst";
  if (h.dirty) return "shield.cleanFirst";
  return "";
});

async function shieldEncrypt() {
  shieldOpen.value = false;
  await host.value?.encryptFile();
}
async function shieldDecrypt() {
  shieldOpen.value = false;
  await host.value?.decryptFile();
}

// ── the file tags ───────────────────────────────────────────────────────────
// Beside the shield: three words about the open file, in plain text. Loaded
// when the file changes and after the modal saves; never guessed.
const tags = ref<string[]>([]);
const tagsOpen = ref(false);

watch(() => host.value?.path ?? null, async (path) => {
  tags.value = [];
  if (!path || !isTauri) return;
  try {
    tags.value = (await tagsGet(path)) ?? [];
  } catch {
    tags.value = [];
  }
}, { immediate: true });

/** The start screen's "Search notes": the box lives in the files panel. */
async function startSearch() {
  filesOpen.value = true;
  await nextTick();
  filesPanel.value?.focusSearch();
}

const menuOpen = ref(false);
/** Whether New's kinds are unfolded inside the menu. */
const newOpen = ref(false);
/** Whether the workspace section is unfolded: the folder, the recent ones,
 *  and what a workspace means. */
const workspaceOpen = ref(false);
watch(menuOpen, (open) => { if (!open) { newOpen.value = false; workspaceOpen.value = false; } });

async function pickWorkspace() {
  menuOpen.value = false;
  showView("editor");
  await workspace.pickRoot();
}

async function switchWorkspace(path: string) {
  menuOpen.value = false;
  showView("editor");
  await workspace.switchRoot(path);
}

const MENU_ITEMS = [
  { id: "open", labelKey: "file.open", icon: "folder-open", run: (h: Host) => h.openFile() },
  { id: "save", labelKey: "file.save", icon: "floppy-disk", run: (h: Host) => h.saveFile() },
  { id: "saveAs", labelKey: "file.saveAs", icon: "file-pen", run: (h: Host) => h.saveAs() },
] as const;

/** Shown only when the mounted editor offers any. An entry that was always
 *  present and usually inert would be worse than one that arrives with the
 *  editor it belongs to. */
const exportItems = computed<ExportCommand[]>(() => host.value?.exports ?? []);

/** Run an export. From an ENCRYPTED file an export writes plaintext outside
 *  the workspace: that costs Mana, shown first and charged only once a file
 *  was actually written. A plain file's export changes nothing and is free. */
async function runExport(item: ExportCommand) {
  menuOpen.value = false;
  exportError.value = "";
  const h = host.value;
  try {
    if (!h?.isSealed) {
      await item.run();
      return;
    }
    if (!(await askMana("export_plain", 1, h.name, "mana.consequence.export_plain"))) return;
    if ((await item.run()) === true) await manaCharge("export_plain", 1, h.path);
  } catch (err) {
    // A failed write (a full disk, a refused location) is said beside the
    // file name, not left to the fatal-error overlay. Nothing was charged.
    exportError.value = `${t("file.exportFailed")} ${errorText(err)}`;
  }
}

/** Why the last export did not happen, until another file is open — any
 *  open, even of a file with the same name: the host counts them. */
const exportError = ref("");
watch(() => host.value?.generation, () => { exportError.value = ""; });

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
 *  already been written has nothing to write. Save As needs a file to exist,
 *  and Open and Save As both need a workspace to look in. */
function isDisabled(id: string): boolean {
  const h = host.value;
  if (!h || h.busy) return true;
  // The browser build has no workspace and needs none: it opens through a
  // file input and saves by download.
  const noWorkspace = isTauri && !h.hasWorkspace;
  if (id === "save") return !h.canSave;
  if (id === "saveAs") return !h.hasFile || noWorkspace;
  if (id === "open") return noWorkspace;
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
          <!-- The workspace: the folder everything below happens in. Unfolds
               to the current folder, the recent ones, and one line saying what
               a workspace is. -->
          <button type="button" role="menuitem" data-testid="menu-workspace"
                  class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-accent-light/10"
                  :aria-expanded="workspaceOpen" @click="workspaceOpen = !workspaceOpen">
            <font-awesome-icon icon="folder" class="w-4 opacity-70" />
            <span class="min-w-0 flex-1 truncate">
              {{ t("workspace.title") }}
              <span class="opacity-60" data-testid="menu-workspace-name">
                {{ workspace.root.value ? baseName(workspace.root.value) : t("workspace.none") }}
              </span>
            </span>
            <font-awesome-icon :icon="workspaceOpen ? 'chevron-down' : 'chevron-right'" class="w-3 opacity-50" />
          </button>
          <template v-if="workspaceOpen">
            <p v-if="workspace.root.value" class="truncate py-1 pl-9 pr-3 text-[11px] opacity-50"
               :title="workspace.root.value" data-testid="menu-workspace-path">{{ workspace.root.value }}</p>
            <button type="button" role="menuitem" data-testid="menu-workspace-pick"
                    class="flex w-full items-center gap-2.5 py-1.5 pl-9 pr-3 text-left text-sm transition hover:bg-accent-light/10"
                    @click="pickWorkspace">
              <font-awesome-icon icon="folder-open" class="w-4 opacity-70" />
              {{ t(workspace.root.value ? "workspace.change" : "workspace.pick") }}
            </button>
            <p v-if="recentWorkspaces.length" class="pb-0.5 pl-9 pr-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-50">
              {{ t("workspace.recent") }}
            </p>
            <button v-for="(path, i) in recentWorkspaces" :key="path" type="button" role="menuitem"
                    :data-testid="`menu-workspace-recent-${i}`" :title="path"
                    class="flex w-full items-center gap-2.5 py-1.5 pl-9 pr-3 text-left text-sm transition hover:bg-accent-light/10"
                    @click="switchWorkspace(path)">
              <font-awesome-icon icon="clock-rotate-left" class="w-4 opacity-70" />
              <span class="truncate">{{ baseName(path) }}</span>
            </button>
            <p class="px-3 pb-2 pt-1.5 text-[11px] leading-snug opacity-60" data-testid="menu-workspace-hint">
              {{ t("workspace.hint") }}
            </p>
          </template>
          <div class="border-t border-current/10" />

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
                  @click="runExport(item)">
            <font-awesome-icon :icon="item.icon" class="w-4 opacity-70" />
            {{ t(item.labelKey) }}
          </button>

          <div class="border-t border-current/10" />
          <button v-for="(spec, id) in MENU_VIEWS" :key="id" type="button" role="menuitem"
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
      <!-- The shield: whether THIS file is encrypted, and the two things you
           can do about that. Beside the name, because that is what it is
           about; the folder's shield sits in the pane, beside the folder. -->
      <div v-if="view === 'editor' && host?.hasFile" class="relative shrink-0" @keydown.esc="shieldOpen = false">
        <button type="button" data-testid="file-shield"
                class="inline-flex h-7 w-7 items-center justify-center rounded-lg border transition hover:opacity-80"
                :class="host.isSealed
                  ? 'border-transparent bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                  : 'border-accent-2 dark:border-accent-1'"
                :title="t(host.isSealed ? 'shield.statusSealedShort' : 'shield.statusPlain')"
                :aria-label="t('shield.title')" aria-haspopup="dialog" :aria-expanded="shieldOpen"
                :data-sealed="host.isSealed ? '1' : '0'"
                @click="shieldOpen = !shieldOpen">
          <font-awesome-icon icon="shield-halved" />
        </button>
        <div v-if="shieldOpen" class="fixed inset-0 z-40" @click="shieldOpen = false" />
        <div v-if="shieldOpen" role="dialog" data-testid="file-shield-panel"
             class="absolute left-0 top-full z-50 mt-2 w-72 rounded-xl border p-3 shadow-xl
                    border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark">
          <p class="flex items-center gap-2 text-sm font-semibold">
            <font-awesome-icon :icon="host.isSealed ? 'lock' : 'lock-open'" class="opacity-70" />
            {{ t("shield.title") }}
          </p>
          <p class="mt-1 text-xs opacity-80" data-testid="file-shield-status">
            {{ t(!host.isSealed ? 'shield.statusPlain' : readOnlyName(host.name) ? 'shield.statusSealedImage' : 'shield.statusSealed') }}
          </p>
          <div class="mt-3 flex flex-col gap-1.5">
            <button v-if="!host.isSealed" type="button" data-testid="file-shield-encrypt"
                    class="rounded-lg border border-accent-2 px-3 py-1.5 text-left text-sm transition
                           hover:bg-accent-light/10 disabled:opacity-40 dark:border-accent-1"
                    :disabled="Boolean(shieldBlocker) || host.busy" @click="shieldEncrypt">
              <font-awesome-icon icon="lock" class="mr-1.5 w-4 opacity-70" />{{ t("shield.encrypt") }}
            </button>
            <button v-else type="button" data-testid="file-shield-decrypt"
                    class="rounded-lg border border-accent-2 px-3 py-1.5 text-left text-sm transition
                           hover:bg-accent-light/10 disabled:opacity-40 dark:border-accent-1"
                    :disabled="Boolean(shieldBlocker) || host.busy" @click="shieldDecrypt">
              <font-awesome-icon icon="lock-open" class="mr-1.5 w-4 opacity-70" />{{ t("shield.decrypt") }}
            </button>
            <p v-if="shieldBlocker" class="text-xs opacity-60" data-testid="file-shield-blocker">{{ t(shieldBlocker) }}</p>
          </div>
          <p class="mt-3 border-t border-current/10 pt-2 text-[11px] leading-snug opacity-60" data-testid="file-shield-limits">
            {{ t("shield.limits") }}
          </p>
        </div>
      </div>
      <!-- The tags: three words at most, shown as chips, edited in a modal.
           Only for a file that exists on disk — a tag is filed by path. -->
      <button v-if="view === 'editor' && host?.hasPath" type="button" data-testid="file-tags"
              class="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg border border-accent-2 px-2
                     text-xs transition hover:opacity-80 dark:border-accent-1"
              :title="t('tags.title')" :aria-label="t('tags.title')" @click="tagsOpen = true">
        <font-awesome-icon icon="tag" class="opacity-60" />
        <span v-if="!tags.length" class="opacity-50">{{ t("tags.none") }}</span>
        <span v-for="(tag, i) in tags" :key="tag" :data-testid="`file-tag-${i}`"
              class="truncate rounded bg-accent-light/15 px-1.5 py-0.5">{{ tag }}</span>
      </button>
      <ManaConfirm />
      <TagModal v-if="host?.path" :open="tagsOpen" :name="host.name" :path="host.path" :sealed="host.isSealed"
                @update:open="tagsOpen = $event" @saved="tags = $event" />

      <span class="flex-1" />

      <p v-if="view === 'editor' && host?.notice" class="shrink-0 text-xs opacity-60">{{ host.notice }}</p>
      <p v-if="view === 'editor' && host?.fileError" class="min-w-0 truncate text-xs text-warn-dark" data-testid="file-error">
        {{ host.fileError }}
      </p>
      <p v-if="view === 'editor' && exportError" class="min-w-0 truncate text-xs text-warn-dark" data-testid="export-error">
        {{ exportError }}
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
      <FilesPanel ref="filesPanel" v-show="showFiles" class="min-h-0"
                  @open="openFromFiles" @open-sealed="openSealedFromFiles"
                  @security="showView('security')" @security-changed="host?.resync()" />

      <div class="flex min-w-0 min-h-0 flex-1 flex-col">
        <!-- One host, always mounted; hidden, not destroyed, behind a view. -->
        <EditorHost ref="hostEl" v-show="view === 'editor'" :active="view === 'editor'"
                    class="min-h-0 flex-1" @search="startSearch" />

        <WorkspaceSecurity v-if="visited.has('security')" v-show="view === 'security'"
                           :active="view === 'security'" class="min-h-0 flex-1" />

        <SettingsView v-if="visited.has('settings')" v-show="view === 'settings'"
                      class="min-h-0 flex-1" />
      </div>
    </div>
  </div>
</template>
