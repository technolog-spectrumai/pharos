<script setup lang="ts">
// Export the workspace as one password-protected .zip, or import one.
//
// Export: every file goes in as it is — encrypted files stay encrypted inside
// the archive — and the archive is sealed with AES-256 under a password typed
// twice here and kept nowhere. Import: an archive's files are unpacked into
// the workspace; a file already there is kept, never overwritten. In both,
// Rust opens the native dialog that picks the file, after the password is in.
//
// What a zip cannot hide is said before an export: the names, sizes and dates
// of the files inside it.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModalPanel from "petalite/ModalPanel.vue";
import { OyaModal } from "petalite/primitives";
import { baseName, formatSize } from "petalite/files";
import { errorText, fsErrorKey } from "./fs";
import { archiveExport, archiveImport, type ExportReport, type ImportReport } from "./archive";

const props = defineProps<{
  open: boolean;
  mode: "export" | "import";
  /** The workspace's folder, for the words. */
  root: string;
}>();

const emit = defineEmits<{
  "update:open": [boolean];
  /** Files came in: the caller reads the workspace again. */
  imported: [ImportReport];
}>();

const { t } = useI18n({ useScope: "global" });

const password = ref("");
const confirm = ref("");
const busy = ref(false);
const error = ref("");
const exported = ref<ExportReport | null>(null);
const imported = ref<ImportReport | null>(null);

watch(() => props.open, (isOpen) => {
  if (!isOpen) return;
  password.value = "";
  confirm.value = "";
  busy.value = false;
  error.value = "";
  exported.value = null;
  imported.value = null;
});

const done = computed(() => exported.value !== null || imported.value !== null);
/** Named, so the button's icon binding holds nothing but icon names. */
const exporting = computed(() => props.mode === "export");
const mismatch = computed(() => props.mode === "export" && confirm.value.length > 0 && password.value !== confirm.value);
const ready = computed(() => {
  if (busy.value || done.value) return false;
  if (props.mode === "import") return true; // a zip may have no password
  return password.value.length > 0 && password.value === confirm.value;
});

function sentence(message: string): string {
  const key = fsErrorKey(message);
  return key ? t(key) : message;
}

async function run() {
  if (!ready.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (props.mode === "export") {
      exported.value = await archiveExport(password.value);
    } else {
      const report = await archiveImport(password.value);
      imported.value = report;
      if (report) emit("imported", report);
    }
  } catch (err) {
    error.value = sentence(errorText(err));
  } finally {
    // The password is gone once it has been used, or refused.
    password.value = "";
    confirm.value = "";
    busy.value = false;
  }
}
</script>

<template>
  <OyaModal :open="open" @close="!busy && emit('update:open', false)">
    <ModalPanel :title="t(mode === 'export' ? 'archive.exportTitle' : 'archive.importTitle')">
      <div class="flex flex-col gap-3" :data-testid="`archive-${mode}-modal`">
        <p class="truncate text-xs opacity-60" :title="root">{{ baseName(root) }}</p>

        <template v-if="!done">
          <p class="text-sm" data-testid="archive-what">
            {{ t(mode === "export" ? "archive.exportWhat" : "archive.importWhat") }}
          </p>
          <p v-if="mode === 'export'" class="rounded-lg border border-dashed border-accent-2 px-3 py-2 text-xs opacity-80 dark:border-accent-1"
             data-testid="archive-limits">
            {{ t("archive.limits") }}
          </p>
          <p v-else class="text-xs opacity-70" data-testid="archive-mana">{{ t("archive.importMana") }}</p>

          <input v-model="password" type="password" autocomplete="off" data-testid="archive-password" :disabled="busy"
                 :placeholder="t(mode === 'export' ? 'archive.password' : 'archive.passwordOptional')"
                 class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
                 @keydown.enter="run" />
          <input v-if="mode === 'export'" v-model="confirm" type="password" autocomplete="off" data-testid="archive-confirm"
                 :disabled="busy" :placeholder="t('archive.confirm')"
                 class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
                 @keydown.enter="run" />
          <p v-if="mismatch" class="text-xs text-warn-dark" data-testid="archive-mismatch">{{ t("lock.passwordMismatch") }}</p>
          <p v-if="mode === 'export'" class="text-xs opacity-60">{{ t("archive.notStored") }}</p>
          <p v-if="error" class="text-sm text-warn-dark" data-testid="archive-error">{{ error }}</p>
        </template>

        <div v-else-if="exported" class="flex flex-col gap-1 text-sm" data-testid="archive-exported">
          <p>{{ t("archive.exported", { files: exported.files, sealed: exported.sealed, size: formatSize(exported.bytes) }) }}</p>
          <p class="break-all text-xs opacity-70">{{ exported.path }}</p>
          <p v-if="exported.links" class="text-xs opacity-60">{{ t("folder.links", { n: exported.links }) }}</p>
        </div>

        <div v-else-if="imported" class="flex flex-col gap-1 text-sm" data-testid="archive-imported">
          <p>{{ t("archive.written", { n: imported.written.length }) }}</p>
          <p v-if="imported.kept.length" class="opacity-70" data-testid="archive-kept">{{ t("archive.kept", { n: imported.kept.length }) }}</p>
          <p v-if="imported.tagged" class="opacity-70">{{ t("archive.tagged", { n: imported.tagged }) }}</p>
          <p v-if="imported.skipped.length" class="text-warn-dark">{{ t("archive.skipped", { n: imported.skipped.length }) }}</p>
          <ul v-if="imported.skipped.length" class="max-h-32 overflow-y-auto text-xs opacity-80">
            <li v-for="(s, i) in imported.skipped" :key="i" :data-testid="`archive-skipped-${i}`">{{ s.path }}: {{ sentence(s.reason) }}</li>
          </ul>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" data-testid="archive-close" :disabled="busy"
                  class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1"
                  @click="emit('update:open', false)">
            {{ t(done ? "common.close" : "common.cancel") }}
          </button>
          <button v-if="!done" type="button" data-testid="archive-run" :disabled="!ready"
                  class="rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light
                         transition hover:opacity-90 disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                  @click="run">
            <font-awesome-icon :icon="busy ? 'spinner' : exporting ? 'file-export' : 'file-import'" :spin="busy" />
            {{ t(mode === "export" ? "archive.exportRun" : "archive.importRun") }}
          </button>
        </div>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
