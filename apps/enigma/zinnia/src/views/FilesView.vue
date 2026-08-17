<script setup lang="ts">
// Files — the vault on the server, and a folder on this machine.
//
// Two sub-tabs rather than two tabs: they answer the same question ("where is
// my work?") and a file from either opens in the same editor, so putting them
// side by side is what makes the app feel like one thing rather than a browser
// bolted onto an editor.
//
// Nothing here filters for security. Every vault endpoint scopes by
// `owner=request.user` before it answers, so this renders what the server
// returned — see useCloudFiles for why growing a filter here would be a
// mistake rather than a precaution.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import ModalPanel from "../components/ModalPanel.vue";
import OyaModal from "rakotis/components/primitives/OyaModal.vue";
import { useCloudFiles } from "../files/useCloudFiles";
import { useWorkspace, type Entry } from "../files/useWorkspace";
import { useCloud } from "../cloud/useCloud";
import { formatDate, formatSize } from "../files/format";
import { kindForFile, kindForVaultFile, looksOpenable } from "../files/openWith";
import { isEmptyDirectory, trailTo, type TreeNode } from "../files/cloudTree";
import type { VaultFileDto } from "../api/vault";
import type { EditorKind } from "../tabs";

const { t } = useI18n({ useScope: "global" });
const emit = defineEmits<{ open: [{ kind: EditorKind; name: string; content: string }] }>();

/** Kept out of the template binding on purpose: a literal inside an :icon
 *  ternary reads as an icon name to the registration scanner, and a comparison
 *  operand is not one. */
const NODE_ICONS: Record<TreeNode["kind"], string> = {
  bucket: "hard-drive",
  directory: "folder",
};

const pane = ref<"cloud" | "local">("cloud");
const cloud = useCloud();
const vault = useCloudFiles();
const workspace = useWorkspace();

const busy = ref(false);
const actionError = ref("");
/** What a confirmation is about. One ref, because only one thing is ever
 *  pending — and a modal that could be about two things at once is a modal
 *  that eventually deletes the wrong one. */
const confirming = ref<{ kind: "file"; file: VaultFileDto } | { kind: "folder"; node: TreeNode } | null>(null);
const newFolderOpen = ref(false);
const newFolderName = ref("");

onMounted(() => {
  if (cloud.signedIn.value) void vault.refresh();
  if (workspace.root.value) void workspace.refresh();
});

const breadcrumb = computed(() => trailTo(vault.selected.value, vault.nodes.value));

const canDeleteFolder = computed(() => {
  const node = vault.selected.value;
  return node ? isEmptyDirectory(node, vault.nodes.value, vault.files.value) : false;
});

// ── opening ─────────────────────────────────────────────────────────────────

async function openVaultFile(file: VaultFileDto) {
  // Encrypted files are shown but never opened: the editor would be handed
  // ciphertext and would render nonsense or refuse in a way that reads as a bug.
  if (file.is_encrypted) return;
  busy.value = true;
  actionError.value = "";
  try {
    const content = await vault.open(file);
    const name = file.title || file.key;
    // The server's own classification wins for a cloud file. The vault's pxml
    // migration retyped legacy decks without renaming them, so a deck row can
    // be typed `pxml` while still titled `talk.xml` — routing on the title
    // alone would send it to the document editor.
    const kind = kindForVaultFile(file.file_type, name, content);
    if (!kind) {
      actionError.value = "files.cannotOpen";
      return;
    }
    emit("open", { kind, name, content });
  } catch (err) {
    actionError.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function openLocalFile(entry: Entry) {
  if (entry.isDirectory) {
    await workspace.enter(entry);
    return;
  }
  if (!looksOpenable(entry.name)) return;
  busy.value = true;
  actionError.value = "";
  try {
    const content = await workspace.readText(entry);
    const kind = kindForFile(entry.name, content);
    if (!kind) {
      actionError.value = "files.cannotOpen";
      return;
    }
    emit("open", { kind, name: entry.name, content });
  } catch (err) {
    actionError.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// ── mutations ───────────────────────────────────────────────────────────────

async function confirmDelete() {
  const target = confirming.value;
  if (!target) return;
  busy.value = true;
  actionError.value = "";
  try {
    if (target.kind === "file") await vault.remove(target.file);
    else await vault.removeFolder(target.node);
    confirming.value = null;
  } catch (err) {
    // The server has the last word on whether a folder is empty — a listing
    // can be stale, so its refusal is shown rather than second-guessed.
    actionError.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function submitNewFolder() {
  const name = newFolderName.value.trim();
  if (!name) return;
  busy.value = true;
  actionError.value = "";
  try {
    await vault.newFolder(name);
    newFolderOpen.value = false;
    newFolderName.value = "";
  } catch (err) {
    actionError.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function downloadFile(file: VaultFileDto) {
  busy.value = true;
  actionError.value = "";
  try {
    const content = await vault.open(file);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({ defaultPath: file.title || file.key });
    if (typeof target !== "string") return;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(target, content);
  } catch (err) {
    actionError.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "error" in err) {
    const kind = (err as { error: { kind: string } }).error.kind;
    return `cloud.apiErrors.${kind}`;
  }
  return "cloud.apiErrors.unknown";
}

/** Errors are i18n keys where we have one and raw text otherwise (a filesystem
 *  message has no key and is more useful verbatim than as "something failed"). */
function shown(message: string): string {
  return message.includes(".") && !message.includes(" ") ? t(message) : message;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
    <!-- Sub-tabs -->
    <div class="flex gap-1 rounded-xl border border-accent-2 p-1 text-sm font-semibold dark:border-accent-1">
      <button v-for="p in (['cloud', 'local'] as const)" :key="p" type="button"
              class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
              :class="pane === p
                ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                : 'opacity-60 hover:opacity-100'"
              :data-testid="`files-pane-${p}`"
              @click="pane = p">
        <font-awesome-icon :icon="p === 'cloud' ? 'cloud' : 'folder'" />
        {{ t(`files.${p}Tab`) }}
      </button>
    </div>

    <!-- ── cloud ──────────────────────────────────────────────────────────── -->
    <div v-if="pane === 'cloud'" class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1">
      <div v-if="!cloud.signedIn.value" class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
           data-testid="files-signed-out">
        <font-awesome-icon icon="cloud" class="text-3xl opacity-30" />
        <p class="max-w-sm text-sm opacity-70">{{ t("files.signInFirst") }}</p>
      </div>

      <template v-else>
        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-2 border-b border-current/10 px-3 py-2">
          <nav class="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
            <template v-for="(crumb, i) in breadcrumb" :key="crumb.id">
              <font-awesome-icon v-if="i > 0" icon="chevron-right" class="shrink-0 text-[10px] opacity-40" />
              <button v-if="i < breadcrumb.length - 1" type="button"
                      class="max-w-40 truncate font-semibold opacity-70 transition hover:underline hover:opacity-100"
                      @click="vault.select(crumb.id)">{{ crumb.name }}</button>
              <span v-else class="max-w-40 truncate font-semibold">{{ crumb.name }}</span>
            </template>
          </nav>
          <input v-model="vault.search.value" type="search" :placeholder="t('common.search')"
                 data-testid="files-search"
                 class="w-40 rounded-lg border border-accent-2 bg-transparent px-2 py-1 text-xs dark:border-accent-1" />
          <button type="button" data-testid="files-refresh"
                  class="rounded-lg border border-accent-2 px-2.5 py-1 text-xs transition hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
                  :disabled="vault.loading.value" @click="vault.refresh()">
            <font-awesome-icon :icon="vault.loading.value ? 'spinner' : 'rotate-right'" :spin="vault.loading.value" />
          </button>
          <button type="button" data-testid="files-new-folder"
                  class="rounded-lg border border-accent-2 px-2.5 py-1 text-xs transition hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
                  :disabled="!vault.selected.value" @click="newFolderOpen = true">
            <font-awesome-icon icon="folder-plus" /> {{ t("files.newFolder") }}
          </button>
          <button v-if="canDeleteFolder" type="button" data-testid="files-delete-folder"
                  class="rounded-lg border border-accent-2 px-2.5 py-1 text-xs transition hover:opacity-80 dark:border-accent-1"
                  @click="confirming = { kind: 'folder', node: vault.selected.value! }">
            <font-awesome-icon icon="trash" />
          </button>
        </div>

        <p v-if="vault.atCap.value" class="border-b border-current/10 px-3 py-1.5 text-xs opacity-60"
           data-testid="files-cap">
          {{ t("files.listCapped") }}
        </p>
        <p v-if="vault.error.value" class="border-b border-current/10 px-3 py-1.5 text-xs text-warn-dark"
           data-testid="files-error">{{ shown(vault.error.value) }}</p>

        <div class="flex min-h-0 flex-1">
          <!-- Folder tree -->
          <div class="w-56 shrink-0 overflow-y-auto border-r border-current/10 py-2" data-testid="files-tree">
            <button v-for="node in vault.nodes.value" :key="node.id" type="button"
                    class="flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm transition hover:bg-accent-light/10"
                    :class="vault.selectedId.value === node.id ? 'font-bold text-accent-light dark:text-accent-dark' : ''"
                    :style="`padding-left: calc(${node.depth} * 1rem + 0.75rem)`"
                    :data-testid="`tree-${node.id}`"
                    @click="vault.select(node.id)">
              <font-awesome-icon :icon="NODE_ICONS[node.kind]" class="shrink-0 text-xs opacity-60" />
              <span class="min-w-0 flex-1 truncate">{{ node.name }}</span>
            </button>
            <p v-if="!vault.nodes.value.length && !vault.loading.value" class="px-3 py-4 text-center text-xs opacity-40">
              {{ t("files.noFolders") }}
            </p>
          </div>

          <!-- Files -->
          <div class="min-w-0 flex-1 space-y-2 overflow-y-auto p-3">
            <div v-for="file in vault.visibleFiles.value" :key="file.key"
                 class="group flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
                 :data-testid="`file-${file.key}`">
              <font-awesome-icon :icon="file.is_encrypted ? 'lock' : 'file'"
                                 class="shrink-0" :class="file.is_encrypted ? 'opacity-60' : 'opacity-40'" />
              <button type="button" class="min-w-0 flex-1 text-left"
                      :class="file.is_encrypted ? 'cursor-not-allowed opacity-60' : 'transition hover:opacity-80'"
                      :disabled="file.is_encrypted || busy"
                      :data-testid="`open-${file.key}`"
                      @click="openVaultFile(file)">
                <p class="truncate text-sm font-semibold">{{ file.title || file.key }}</p>
                <p class="truncate text-xs opacity-50">
                  {{ formatSize(file.file_size_bytes) }} · {{ formatDate(file.uploaded_at) }}
                </p>
              </button>
              <span v-if="file.is_encrypted"
                    class="shrink-0 rounded-full border border-current/25 px-2 py-0.5 text-[10px] font-semibold uppercase"
                    :data-testid="`encrypted-${file.key}`">
                {{ t("files.encrypted") }}
              </span>
              <span class="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button type="button" class="rounded p-1.5 transition hover:bg-accent-light/10"
                        :title="t('files.download')" :data-testid="`download-${file.key}`"
                        :disabled="busy" @click="downloadFile(file)">
                  <font-awesome-icon icon="download" class="text-xs" />
                </button>
                <button type="button" class="rounded p-1.5 transition hover:bg-accent-light/10"
                        :title="t('files.delete')" :data-testid="`delete-${file.key}`"
                        :disabled="busy" @click="confirming = { kind: 'file', file }">
                  <font-awesome-icon icon="trash" class="text-xs" />
                </button>
              </span>
            </div>

            <div v-if="vault.loading.value && !vault.visibleFiles.value.length" class="flex justify-center pt-8">
              <font-awesome-icon icon="spinner" spin class="text-2xl opacity-50" />
            </div>
            <p v-else-if="!vault.visibleFiles.value.length" class="pt-8 text-center text-xs opacity-40"
               data-testid="files-empty">
              {{ vault.search.value ? t("files.noMatches") : t("files.emptyFolder") }}
            </p>
          </div>
        </div>
      </template>
    </div>

    <!-- ── local ──────────────────────────────────────────────────────────── -->
    <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1">
      <div v-if="!workspace.root.value" class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
           data-testid="workspace-empty">
        <font-awesome-icon icon="folder-open" class="text-3xl opacity-30" />
        <p class="max-w-sm text-sm opacity-70">{{ t("files.pickWorkspaceHint") }}</p>
        <button type="button" data-testid="workspace-pick"
                class="rounded-lg bg-accent-light px-4 py-2 text-sm font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
                @click="workspace.pickRoot()">
          {{ t("files.pickWorkspace") }}
        </button>
      </div>

      <template v-else>
        <div class="flex flex-wrap items-center gap-2 border-b border-current/10 px-3 py-2">
          <nav class="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
            <template v-for="(crumb, i) in workspace.crumbs.value" :key="crumb.rel">
              <font-awesome-icon v-if="i > 0" icon="chevron-right" class="shrink-0 text-[10px] opacity-40" />
              <button v-if="i < workspace.crumbs.value.length - 1" type="button"
                      class="max-w-40 truncate font-semibold opacity-70 transition hover:underline hover:opacity-100"
                      @click="workspace.goTo(crumb.rel)">{{ crumb.name }}</button>
              <span v-else class="max-w-40 truncate font-semibold">{{ crumb.name }}</span>
            </template>
          </nav>
          <button type="button" data-testid="workspace-refresh"
                  class="rounded-lg border border-accent-2 px-2.5 py-1 text-xs transition hover:opacity-80 dark:border-accent-1"
                  @click="workspace.refresh()">
            <font-awesome-icon :icon="workspace.loading.value ? 'spinner' : 'rotate-right'" :spin="workspace.loading.value" />
          </button>
          <button type="button" data-testid="workspace-change"
                  class="rounded-lg border border-accent-2 px-2.5 py-1 text-xs transition hover:opacity-80 dark:border-accent-1"
                  @click="workspace.pickRoot()">
            {{ t("files.changeWorkspace") }}
          </button>
        </div>

        <p v-if="workspace.error.value" class="border-b border-current/10 px-3 py-1.5 text-xs text-warn-dark"
           data-testid="workspace-error">{{ shown(workspace.error.value) }}</p>

        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          <button v-for="entry in workspace.entries.value" :key="entry.path" type="button"
                  class="flex w-full items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 text-left dark:border-accent-1"
                  :class="entry.isDirectory || looksOpenable(entry.name)
                    ? 'transition hover:opacity-80'
                    : 'cursor-default opacity-45'"
                  :data-testid="`entry-${entry.name}`"
                  @click="openLocalFile(entry)">
            <font-awesome-icon :icon="entry.isDirectory ? 'folder' : 'file'"
                               class="shrink-0"
                               :class="entry.isDirectory ? 'text-accent-light dark:text-accent-dark' : 'opacity-40'" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold">{{ entry.name }}</span>
              <span v-if="!entry.isDirectory" class="block truncate text-xs opacity-50">
                {{ formatSize(entry.size) }} · {{ formatDate(entry.modified) }}
              </span>
            </span>
            <font-awesome-icon v-if="entry.isDirectory" icon="chevron-right" class="shrink-0 text-xs opacity-40" />
          </button>

          <p v-if="!workspace.entries.value.length && !workspace.loading.value"
             class="pt-8 text-center text-xs opacity-40" data-testid="workspace-empty-folder">
            {{ t("files.emptyFolder") }}
          </p>
        </div>
      </template>
    </div>

    <p v-if="actionError" class="text-xs text-warn-dark" data-testid="files-action-error">
      {{ shown(actionError) }}
    </p>

    <!-- Confirm a deletion. Irreversible, so it is never a single click. -->
    <OyaModal :open="confirming !== null" @close="confirming = null">
      <ModalPanel :title="t('files.deleteTitle')">
        <p class="text-sm opacity-70">{{ t("files.deleteBody") }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1"
                  @click="confirming = null">{{ t("common.cancel") }}</button>
          <button type="button" data-testid="files-confirm-delete"
                  class="rounded-lg bg-warn-dark px-3 py-1.5 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-40"
                  :disabled="busy" @click="confirmDelete">
            <font-awesome-icon :icon="busy ? 'spinner' : 'trash'" :spin="busy" />
            {{ t("files.delete") }}
          </button>
        </div>
      </ModalPanel>
    </OyaModal>

    <OyaModal :open="newFolderOpen" @close="newFolderOpen = false">
      <ModalPanel :title="t('files.newFolderTitle')">
        <input v-model="newFolderName" type="text" data-testid="files-folder-name"
               class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
               @keydown.enter="submitNewFolder" />
        <div class="flex justify-end gap-2">
          <button type="button" class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1"
                  @click="newFolderOpen = false">{{ t("common.cancel") }}</button>
          <button type="button" data-testid="files-create-folder"
                  class="rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                  :disabled="busy || !newFolderName.trim()" @click="submitNewFolder">
            {{ t("files.create") }}
          </button>
        </div>
      </ModalPanel>
    </OyaModal>
  </div>
</template>
