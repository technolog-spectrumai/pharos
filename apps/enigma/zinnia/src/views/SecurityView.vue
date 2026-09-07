<script setup lang="ts">
// Security — encrypting a file with a passphrase.
//
// This tab hosts no editor, so `App.showFiles` gives it no files sidepanel and
// it brings its own listing. That listing is the SAME workspace store the
// sidepanel drives: expanding a folder here expands it there, and the sealed
// probes fill one cache for both. A second tree would be a second opinion about
// what is on disk.
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import LockModal from "../files/LockModal.vue";
import FileTree from "petalite/FileTree.vue";
import { filterRows, useWorkspace, type Row } from "../files/useWorkspace";
import {
  forgetPassphrase, lockErrorKey, passphraseStatus, rememberPassphrase,
  sealFile, unsealFile, type SecretStatus,
} from "../security/lock";

const { t } = useI18n({ useScope: "global" });
const workspace = useWorkspace();

const filter = ref("");
const visible = computed<Row[]>(() => filterRows(workspace.rows.value, filter.value));

/** The row a passphrase is being asked about, or null. One ref, because only
 *  one thing is ever pending — a modal that could be about two files at once is
 *  a modal that eventually encrypts the wrong one. */
const target = ref<Row | null>(null);
const modalOpen = ref(false);
const actionError = ref("");

/** Whether the OS secret store is holding a passphrase, and which store it is.
 *  Never the passphrase itself — no command returns it. */
const secret = ref<SecretStatus>({ remembered: false, storage: null });
async function refreshSecret() {
  try {
    secret.value = await passphraseStatus();
  } catch {
    secret.value = { remembered: false, storage: null };
  }
}
onMounted(refreshSecret);

// The picked folder can be unreadable by the next launch (the grant does not
// survive a restart), so this tab reads it itself rather than assuming the
// sidepanel already has — it is reachable without the sidepanel ever mounting.
watch(() => workspace.root.value, (root) => {
  if (root && !workspace.rows.value.length) void workspace.refresh();
}, { immediate: true });

const mode = computed<"lock" | "unlock">(() =>
  target.value && workspace.isSealed(target.value.path) ? "unlock" : "lock");

async function activate(row: Row) {
  if (row.isDirectory) {
    void workspace.toggle(row.path);
    return;
  }
  target.value = row;
  actionError.value = "";

  // A remembered passphrase is a standing answer to the only question the
  // dialog asks, so asking it again would be theatre. Rust reads it from the
  // secret store itself; `null` is how this says "use that one".
  if (secret.value.remembered) {
    try {
      await apply(null, false);
    } catch (err) {
      const message = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      actionError.value = lockErrorKey(message) ?? message;
    }
    return;
  }
  // `looksOpenable` is deliberately NOT consulted: a .png is perfectly
  // encryptable. The sidepanel greys what it cannot open because it is trying
  // to open things; this list is trying to seal them.
  modalOpen.value = true;
}

/** Handed to the modal, which supplies the passphrase and owns the busy state.
 *  A throw here surfaces as the mapped message; a success closes the dialog. */
async function apply(password: string | null, remember: boolean): Promise<void> {
  const row = target.value;
  if (!row) return;
  const sealed = workspace.isSealed(row.path);
  await (sealed ? unsealFile : sealFile)(row.path, password);
  // Only after the passphrase has been proven to work on a real file. Storing
  // it first would remember a typo.
  if (remember && password) {
    try {
      await rememberPassphrase(password);
      await refreshSecret();
    } catch {
      // The file is sealed either way; failing to remember is not a failure to
      // seal, and reporting it as one would be a lie about the file.
    }
  }
  try {
    await workspace.reprobe(row.path);
  } catch {
    // The seal itself succeeded; a failed probe must never report otherwise.
    // The badge corrects itself on the next listing.
  }
}

</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto p-6">
    <div class="mx-auto w-full max-w-2xl">
      <!-- ── encrypting a file ─────────────────────────────────────────── -->
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="shield-halved" class="opacity-60" />
        {{ t("security.files.title") }}
      </h2>
      <p class="mt-1 text-sm opacity-70">{{ t("security.files.help") }}</p>

      <!-- What is remembered, and the way to stop remembering it. Never the
           passphrase itself: nothing can fetch it back up here. -->
      <div class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-accent-2 px-4 py-2.5 text-sm dark:border-accent-1"
           data-testid="secret-row">
        <span class="min-w-0 flex-1">
          <template v-if="secret.remembered">
            {{ t("security.secret.held") }}
            <span class="opacity-60">{{ t(`security.secret.${secret.storage ?? "memory"}`) }}</span>
          </template>
          <span v-else class="opacity-60">{{ t("security.secret.none") }}</span>
        </span>
        <button v-if="secret.remembered" type="button" data-testid="secret-forget"
                class="shrink-0 rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:opacity-80 dark:border-accent-1"
                @click="forgetPassphrase().then(refreshSecret)">
          {{ t("security.secret.forget") }}
        </button>
      </div>

      <p v-if="actionError" class="mt-3 text-sm text-warn-dark" data-testid="security-action-error">
        {{ t(actionError) }}
      </p>


      <div v-if="!workspace.root.value"
           class="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-accent-2 px-4 py-3 dark:border-accent-1"
           data-testid="security-files-none">
        <span class="min-w-0 flex-1 text-sm opacity-60">{{ t("security.files.noWorkspace") }}</span>
        <button type="button" data-testid="security-files-pick"
                class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
                @click="workspace.pickRoot()">
          {{ t("files.pickWorkspace") }}
        </button>
      </div>

      <template v-else>
        <div class="mt-5 flex flex-wrap items-center gap-2">
          <input v-model="filter" type="search" :placeholder="t('common.search')"
                 data-testid="security-files-filter"
                 class="min-w-0 flex-1 rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1" />
          <button type="button" data-testid="security-files-refresh"
                  class="shrink-0 rounded-lg border border-accent-2 px-2.5 py-1.5 text-sm transition hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
                  :title="t('security.files.refresh')" :aria-label="t('security.files.refresh')"
                  :disabled="workspace.loading.value" @click="workspace.refresh()">
            <font-awesome-icon :icon="workspace.loading.value ? 'spinner' : 'rotate-right'"
                               :spin="workspace.loading.value" />
          </button>
        </div>

        <div class="mt-3 overflow-hidden rounded-xl border border-accent-2 dark:border-accent-1"
             data-testid="security-files">
          <!-- The same tree the sidepanel draws, at the Security tab's own
               density. What differs is the right edge: a SEALED badge instead
               of a file size, because here that is the whole point. -->
          <FileTree :rows="visible" :is-expanded="workspace.isExpanded"
                    :is-sealed="workspace.isSealed" testid-prefix="security-row"
                    density="roomy" @activate="activate">
            <template #trailing="{ row }">
              <span v-if="!row.isDirectory && workspace.isSealed(row.path)"
                    class="shrink-0 rounded-full border border-current/25 px-2 py-0.5 text-[10px] font-semibold uppercase"
                    :data-testid="`security-sealed-${row.name}`">
                {{ t("security.files.sealed") }}
              </span>
            </template>
          </FileTree>

          <p v-if="!visible.length" class="px-4 py-6 text-center text-xs opacity-40"
             data-testid="security-files-empty">
            {{ filter ? t("files.noMatches") : t("security.files.empty") }}
          </p>
        </div>
      </template>

    </div>

    <LockModal v-model:open="modalOpen" :mode="mode" :name="target?.name ?? ''"
               :action="apply" offer-remember />
  </div>
</template>
