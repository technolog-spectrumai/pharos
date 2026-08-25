<script setup lang="ts">
// Files — a folder on this machine.
//
// One pane, because there is only one place files live now. The vault half —
// the server's buckets, its folder tree, its delete and new-folder calls — is
// parked in limbo/cloud; the sub-tab bar that used to switch between the two
// went with it rather than staying on as a bar with one button.
//
// What survives is the local browser: a root the user picked, breadcrumbs, and
// a listing that hands a file to whichever editor its bytes call for.
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspace, type Entry } from "../files/useWorkspace";
import { formatDate, formatSize } from "../files/format";
import { kindForFile, looksOpenable } from "../files/openWith";
import type { EditorKind } from "../tabs";

const { t } = useI18n({ useScope: "global" });
const emit = defineEmits<{
  open: [{ kind: EditorKind; name: string; content: string }];
}>();

const workspace = useWorkspace();

const busy = ref(false);
const actionError = ref("");

onMounted(() => {
  if (workspace.root.value) void workspace.refresh();
});

// ── opening ─────────────────────────────────────────────────────────────────

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
    actionError.value = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
  } finally {
    busy.value = false;
  }
}

/** Errors are i18n keys where we have one and raw text otherwise (a filesystem
 *  message has no key and is more useful verbatim than as "something failed"). */
function shown(message: string): string {
  return message.includes(".") && !message.includes(" ") ? t(message) : message;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1">
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
                  :disabled="busy"
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
  </div>
</template>
