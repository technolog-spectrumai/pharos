<script setup lang="ts">
// The files sidepanel — a folder on this machine, beside whatever you are
// editing.
//
// This was a TAB. A tab was the wrong shape for it: picking a file meant
// leaving the editor, and coming back meant finding your way to the tab again,
// so the browser and the work were never on screen together. The platform's own
// workspace rooms put an explorer down the left of the editor for exactly that
// reason, and this is the same arrangement in a desktop window.
//
// It holds no file and no buffer. Clicking a row reads the bytes and emits
// them; App decides which editor tab gets them, and that tab's host owns them
// from there. Nothing here can save, delete or rename — a panel that could
// would be a second, quieter path to writing over your work.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { filterRows, useWorkspace, type Entry, type Row } from "petalite/files";
import { baseName, formatSize, isImageName } from "petalite/files";
import FileTree from "petalite/FileTree.vue";
import { kindForFile } from "./openWith";
import type { EditorKind } from "../tabs";

const { t } = useI18n({ useScope: "global" });
const emit = defineEmits<{
  open: [{ kind: EditorKind; name: string; content: string }];
}>();

const workspace = useWorkspace();

const filter = ref("");
const busy = ref(false);
const openError = ref("");
/** The row most recently opened, so the panel shows where the buffer on screen
 *  came from. A path, not an index: a refresh replaces every row object. */
const openedPath = ref("");

const visible = computed<Row[]>(() => filterRows(workspace.rows.value, filter.value));

// The picked folder can be gone by the next launch (the fs grant does not
// survive a restart), so the first read happens here rather than being assumed.
watch(() => workspace.root.value, (root) => {
  if (root && !workspace.rows.value.length) void workspace.refresh();
}, { immediate: true });

async function activate(row: Row) {
  if (row.isDirectory) {
    await workspace.toggle(row.path);
    return;
  }
  // Sealed is the ONE reason a row will not open now. Anything else opens —
  // as plain text if nothing better claims it.
  if (workspace.isSealed(row.path)) {
    openError.value = "files.encrypted";
    return;
  }
  busy.value = true;
  openError.value = "";
  try {
    // A picture is read as BYTES and handed over as a data: URI. Reading it as
    // text would decode UTF-8 over a PNG and hand the editor mojibake — which
    // is what used to happen, and is why images were unopenable before.
    const image = isImageName(row.name);
    const content = image
      ? await workspace.readImage(row as Entry)
      : await workspace.readText(row as Entry);
    const kind = image ? "code" as const : kindForFile(row.name, content);
    if (!kind) {
      openError.value = "files.cannotOpen";
      return;
    }
    openedPath.value = row.path;
    emit("open", { kind, name: row.name, content });
  } catch (err) {
    openError.value = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
  } finally {
    busy.value = false;
  }
}

/** The hover text. The padlock must not be an icon-only affordance — someone
 *  who cannot tell the glyphs apart still needs to know why a row will not
 *  open. */
function rowTitle(row: Row): string {
  return workspace.isSealed(row.path) ? `${row.name} — ${t("files.encrypted")}` : row.name;
}

/** Errors are i18n keys where we have one and raw text otherwise (a filesystem
 *  message has no key and is more useful verbatim than as "something failed"). */
function shown(message: string): string {
  return message.includes(".") && !message.includes(" ") ? t(message) : message;
}
</script>

<template>
  <aside class="flex w-64 shrink-0 flex-col overflow-hidden border-r border-accent-2 dark:border-accent-1"
         data-testid="files-panel">
    <!-- Header: what folder this is, and the two things you can do to it. -->
    <div class="flex items-center gap-1 border-b border-current/10 px-2 py-1.5">
      <span class="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide opacity-70"
            :title="workspace.root.value || t('nav.files')" data-testid="files-root">
        {{ workspace.root.value ? baseName(workspace.root.value) : t("nav.files") }}
      </span>
      <button v-if="workspace.root.value && !workspace.unreadable.value" type="button" data-testid="files-refresh"
              class="rounded p-1 opacity-60 transition hover:opacity-100 disabled:opacity-25"
              :title="t('files.refresh')" :aria-label="t('files.refresh')"
              :disabled="workspace.loading.value" @click="workspace.refresh()">
        <font-awesome-icon :icon="workspace.loading.value ? 'spinner' : 'rotate-right'"
                           :spin="workspace.loading.value" class="text-xs" />
      </button>
      <button type="button" data-testid="files-change"
              class="rounded p-1 opacity-60 transition hover:opacity-100"
              :title="t('files.changeWorkspace')" :aria-label="t('files.changeWorkspace')"
              @click="workspace.pickRoot()">
        <font-awesome-icon icon="folder-open" class="text-xs" />
      </button>
    </div>

    <!-- Two states share one shape, because from here they are one question:
         there is no tree, and the answer is the picker.
           * no folder chosen yet — say so in three words. The paragraph
             explaining what picking one GRANTS lives in Settings, where there
             is room to read it.
           * a folder is remembered but cannot be read — the read grant lives in
             the running process, so this is what a restart looks like. It used
             to render as a raw Rust string above an empty listing, which read
             as a broken app rather than a folder waiting to be re-picked. -->
    <div v-if="!workspace.root.value || workspace.unreadable.value"
         class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
         data-testid="files-empty">
      <font-awesome-icon icon="folder-open" class="text-2xl opacity-25" />
      <template v-if="workspace.unreadable.value">
        <p class="text-xs opacity-70" data-testid="files-unreadable">{{ t("files.unreadable") }}</p>
        <p class="break-all text-[10px] opacity-40">{{ workspace.root.value }}</p>
        <p class="text-xs opacity-60">{{ t("files.unreadableHint") }}</p>
      </template>
      <p v-else class="text-xs opacity-60">{{ t("files.noWorkspace") }}</p>

      <button type="button" data-testid="files-pick"
              class="mt-1 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
              @click="workspace.pickRoot()">
        {{ t("files.pickWorkspace") }}
      </button>

      <!-- The browser build has no folder picker; pickRoot says so through the
           store, and this is the only branch that can show it. -->
      <p v-if="workspace.error.value && !workspace.unreadable.value"
         class="text-xs text-warn-dark" data-testid="files-pick-error">
        {{ shown(workspace.error.value) }}
      </p>
    </div>

    <template v-else>
      <div class="px-2 py-1.5">
        <input v-model="filter" type="search" :placeholder="t('common.search')"
               data-testid="files-filter"
               class="w-full rounded-lg border border-accent-2 bg-transparent px-2 py-1 text-xs dark:border-accent-1" />
      </div>

      <p v-if="workspace.error.value" class="px-2 pb-1.5 text-xs text-warn-dark" data-testid="files-error">
        {{ shown(workspace.error.value) }}
      </p>

      <!-- Flat rows, indented by depth: no recursion, and a folder twelve deep
           costs the same as one at the top. The rendering is Petalite's, shared
           with the Security tab; what is ours is the size at the right edge and
           the busy gate. -->
      <div class="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="files-tree">
        <FileTree :rows="visible" :is-expanded="workspace.isExpanded"
                  :is-sealed="workspace.isSealed" testid-prefix="files-row"
                  :row-title="rowTitle" :active-path="openedPath" :disabled="busy"
                  @activate="activate">
          <template #trailing="{ row }">
            <span v-if="!row.isDirectory" class="shrink-0 text-[10px] opacity-40">
              {{ formatSize((row as Row).size) }}
            </span>
          </template>
        </FileTree>

        <p v-if="!visible.length && !workspace.loading.value"
           class="px-3 pt-6 text-center text-xs opacity-40" data-testid="files-nothing">
          {{ filter ? t("files.noMatches") : t("files.emptyFolder") }}
        </p>
      </div>
    </template>

    <p v-if="openError" class="border-t border-current/10 px-2 py-1.5 text-xs text-warn-dark"
       data-testid="files-open-error">
      {{ shown(openError) }}
    </p>
  </aside>
</template>
