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
// them with the path they came from; the editor host owns them from there and
// picks the editor from the file. Nothing here can save, delete or rename — a
// panel that could would be a second, quieter path to writing over your work.
//
// The workspace search sits in the same panel and ends in the same place: a
// hit is a path, and a path opens through `openEntry` exactly as a clicked
// row does. One way into an editor. While a query is typed the results stand
// where the tree was — they cover the whole workspace, not the folders that
// happen to be open.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspace, type Entry, type Row } from "petalite/files";
import { baseName, formatSize, isImageName } from "petalite/files";
import FileTree from "petalite/FileTree.vue";
import LockModal from "padova/LockModal.vue";
import FolderLockModal from "../security/FolderLockModal.vue";
import { lockErrorKey, passphraseStatus, rememberPassphrase, sealFile, unsealFile } from "padova";
import { dialogErrorKey, errorText, fsErrorKey } from "./fs";
import ManaCost from "../security/ManaCost.vue";
import { askMana, manaCharge, manaQuote, manaRecord, type ManaQuote } from "../security/mana";
import WorkspaceSearch from "./WorkspaceSearch.vue";
import { kindForFile } from "./openWith";
import type { EditorKind } from "../kinds";

const { t } = useI18n({ useScope: "global" });
const emit = defineEmits<{
  open: [{ kind: EditorKind; name: string; path: string; content: string }];
  /** An encrypted file: the host asks for the passphrase and decrypts it
   *  into memory. The panel never reads ciphertext. */
  "open-sealed": [{ name: string; path: string }];
  /** The workspace shield: the security summary for this folder. */
  security: [];
  /** A row shield or a folder run changed files' encryption on disk; the
   *  host asks again about the file it has open. */
  "security-changed": [];
}>();

const workspace = useWorkspace();

/** Whether a search query is on screen, and so the results, not the tree. */
const searching = ref(false);
const busy = ref(false);
const openError = ref("");
/** The row most recently opened, so the panel shows where the buffer on screen
 *  came from. A path, not an index: a refresh replaces every row object. */
const openedPath = ref("");

// The remembered folder is reopened by the first read here, through Rust; one
// that is gone or refused shows the picker rather than being assumed.
watch(() => workspace.root.value, (root) => {
  if (root && !workspace.rows.value.length) void workspace.refresh();
}, { immediate: true });

async function activate(row: Row) {
  if (row.isDirectory) {
    await workspace.toggle(row.path);
    return;
  }
  await openEntry(row);
}

/** Open one file — a clicked row or a search hit, the same way. */
async function openEntry(file: { name: string; path: string }) {
  // An encrypted file is not read here: it goes to the host, which asks for
  // the passphrase and has Rust decrypt it into memory.
  if (workspace.isSealed(file.path)) {
    openedPath.value = file.path;
    openError.value = "";
    emit("open-sealed", { name: file.name, path: file.path });
    return;
  }
  const entry: Entry = { name: file.name, path: file.path, isDirectory: false };
  busy.value = true;
  openError.value = "";
  try {
    // A picture is read as BYTES and handed over as a data: URI. Reading it as
    // text would decode UTF-8 over a PNG and hand the editor mojibake — which
    // is what used to happen, and is why images were unopenable before.
    const image = isImageName(entry.name);
    const content = image
      ? await workspace.readImage(entry)
      : await workspace.readText(entry);
    const kind = image ? "code" as const : kindForFile(entry.name, content);
    if (!kind) {
      openError.value = "files.cannotOpen";
      return;
    }
    openedPath.value = entry.path;
    emit("open", { kind, name: entry.name, path: entry.path, content });
  } catch (err) {
    // A known refusal as its catalogue key (the line below translates keys),
    // anything else as it came.
    const message = errorText(err);
    openError.value = fsErrorKey(message) ?? message;
  } finally {
    busy.value = false;
  }
}

/** A search hit was never probed by the tree (it may sit in a folder that was
 *  never expanded), so ask before opening — the tree's cached answer is used
 *  when it has one. */
async function openHit(hit: { name: string; path: string }) {
  if (!workspace.sealed.value.has(hit.path)) await workspace.reprobe(hit.path);
  await openEntry(hit);
}

// ── the row shields ─────────────────────────────────────────────────────────
// A shield beside each file: encrypt it, or decrypt it permanently, from the
// pane — for files no editor here opens (a PDF, say) as much as for notes.
const lockOpen = ref(false);
const lockMode = ref<"lock" | "unlock">("lock");
const lockTarget = ref<{ name: string; path: string } | null>(null);
/** The price of a permanent decrypt, shown inside the passphrase dialog. */
const lockQuote = ref<ManaQuote | null>(null);

async function shieldFile(row: { name: string; path: string }) {
  openError.value = "";
  const sealed = workspace.isSealed(row.path);
  lockTarget.value = row;
  lockMode.value = sealed ? "unlock" : "lock";
  lockQuote.value = null;
  // Decrypting with a remembered passphrase needs no passphrase dialog, only
  // the price; encrypting always asks, because a passphrase typed twice is
  // one you can type again.
  if (sealed) {
    let known = false;
    try { known = (await passphraseStatus()).remembered; } catch { /* ask instead */ }
    if (known) {
      if (!(await askMana("decrypt_file", 1, row.name, "mana.consequence.decrypt_file"))) return;
      try {
        await unsealFile(row.path, null);
        await workspace.reprobe(row.path);
        await manaCharge("decrypt_file", 1, row.path);
        emit("security-changed");
        return;
      } catch (err) {
        if (!/^(wrong_password|no_passphrase)/.test(errorText(err))) {
          const key = fsErrorKey(errorText(err)) ?? lockErrorKey(errorText(err));
          openError.value = key ?? errorText(err);
          return;
        }
      }
    }
    lockQuote.value = await manaQuote("decrypt_file", 1);
  }
  lockOpen.value = true;
}

async function lockAction(password: string, remember: boolean): Promise<void> {
  const target = lockTarget.value;
  if (!target) return;
  const mode = lockMode.value;
  try {
    if (mode === "lock") await sealFile(target.path, password);
    else await unsealFile(target.path, password);
  } catch (err) {
    // The dialog has words for sealing refusals only; a workspace refusal
    // gets its own sentence here.
    const key = dialogErrorKey(errorText(err), mode);
    throw key ? new Error(t(key)) : err;
  }
  await workspace.reprobe(target.path);
  if (mode === "lock") await manaRecord("encrypt_file", target.path);
  else await manaCharge("decrypt_file", 1, target.path);
  // Remembered only once it proved to work on this file.
  if (remember) await rememberPassphrase(password);
  emit("security-changed");
}

// The folder shield: everything under one folder, one passphrase.
const folderOpen = ref(false);
const folderTarget = ref<{ name: string; path: string } | null>(null);

function shieldFolder(row: { name: string; path: string }) {
  openError.value = "";
  folderTarget.value = row;
  folderOpen.value = true;
}

/** A run changed files on disk; read the tree again so every padlock is
 *  right, and re-run the search so no stale line survives an encryption. */
async function folderDone() {
  await workspace.refresh();
  search.value?.refresh();
  emit("security-changed");
}

const search = ref<InstanceType<typeof WorkspaceSearch> | null>(null);
defineExpose({
  /** Put the cursor in the workspace search, for a caller that wants to start there. */
  focusSearch() {
    search.value?.focus();
  },
});

/** The hover text. The padlock must not be an icon-only affordance — someone
 *  who cannot tell the glyphs apart still needs to know why a row will not
 *  open. */
function rowTitle(row: Row): string {
  return workspace.isSealed(row.path) ? `${row.name} — ${t("files.encryptedRow")}` : row.name;
}

/** Errors are i18n keys where we have one and raw text otherwise (a filesystem
 *  message has no key and is more useful verbatim than as "something failed"). */
function shown(message: string): string {
  const key = fsErrorKey(message);
  if (key) return t(key);
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
      <!-- The workspace's shield: what is encrypted here, the passphrase,
           Security Mana and recent actions. Security lives beside the files. -->
      <button v-if="workspace.root.value && !workspace.unreadable.value" type="button" data-testid="files-security"
              class="rounded p-1 opacity-60 transition hover:opacity-100"
              :title="t('security.workspace.open')" :aria-label="t('security.workspace.open')"
              @click="emit('security')">
        <font-awesome-icon icon="shield-halved" class="text-xs" />
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
      <!-- The one search box: names, paths, tags and (by setting) text, over
           the whole workspace. Its results replace the tree while it is used. -->
      <WorkspaceSearch ref="search" :root="workspace.root.value" @open="openHit"
                       @update:active="searching = $event" />

      <p v-if="workspace.error.value" class="px-2 py-1.5 text-xs text-warn-dark" data-testid="files-error">
        {{ shown(workspace.error.value) }}
      </p>

      <!-- Flat rows, indented by depth: no recursion, and a folder twelve deep
           costs the same as one at the top. The rendering is Petalite's, shared
           with the Security tab; what is ours is the size at the right edge and
           the busy gate. -->
      <div v-show="!searching" class="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="files-tree">
        <FileTree :rows="workspace.rows.value" :is-expanded="workspace.isExpanded"
                  :is-sealed="workspace.isSealed" testid-prefix="files-row"
                  :row-title="rowTitle" :active-path="openedPath" :disabled="busy"
                  @activate="activate">
          <template #trailing="{ row }">
            <span v-if="row.isDirectory" role="button" tabindex="0" :data-testid="`folder-shield-${row.name}`"
                  class="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-40
                         transition hover:opacity-100"
                  :title="t('folder.shield')" :aria-label="t('folder.shield')"
                  @click.stop="shieldFolder(row)" @keydown.enter.stop="shieldFolder(row)">
              <font-awesome-icon icon="shield-halved" class="text-[10px]" />
            </span>
            <template v-if="!row.isDirectory">
              <span class="shrink-0 text-[10px] opacity-40">{{ formatSize((row as Row).size) }}</span>
              <!-- A span with a role, not a button: the row itself is one. -->
              <span role="button" tabindex="0" :data-testid="`row-shield-${row.name}`"
                    class="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-40
                           transition hover:opacity-100"
                    :class="workspace.isSealed(row.path) ? 'text-accent-light dark:text-accent-dark opacity-90' : ''"
                    :title="t(workspace.isSealed(row.path) ? 'shield.rowDecrypt' : 'shield.rowEncrypt')"
                    :aria-label="t(workspace.isSealed(row.path) ? 'shield.rowDecrypt' : 'shield.rowEncrypt')"
                    @click.stop="shieldFile(row)" @keydown.enter.stop="shieldFile(row)">
                <font-awesome-icon :icon="workspace.isSealed(row.path) ? 'lock' : 'shield-halved'" class="text-[10px]" />
              </span>
            </template>
          </template>
        </FileTree>

        <p v-if="!workspace.rows.value.length && !workspace.loading.value"
           class="px-3 pt-6 text-center text-xs opacity-40" data-testid="files-nothing">
          {{ t("files.emptyFolder") }}
        </p>
      </div>
    </template>

    <p v-if="openError" class="border-t border-current/10 px-2 py-1.5 text-xs text-warn-dark"
       data-testid="files-open-error">
      {{ shown(openError) }}
    </p>

    <LockModal :open="lockOpen" :mode="lockMode" :name="lockTarget?.name ?? ''" :action="lockAction"
               offer-remember @update:open="lockOpen = $event">
      <template #notice>
        <template v-if="lockMode === 'unlock' && lockQuote">
          <p class="text-xs" data-testid="lock-consequence">{{ t("mana.consequence.decrypt_file") }}</p>
          <ManaCost :quote="lockQuote" />
        </template>
      </template>
    </LockModal>
    <FolderLockModal :open="folderOpen" :name="folderTarget?.name ?? ''" :path="folderTarget?.path ?? ''"
                     @update:open="folderOpen = $event" @done="folderDone" />
  </aside>
</template>
