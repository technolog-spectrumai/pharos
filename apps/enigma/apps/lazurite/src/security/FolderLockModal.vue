<script setup lang="ts">
// Encrypt or decrypt every file under one folder, with one passphrase.
//
// The modal asks Rust what is there first, so the choice is made against
// numbers — "12 plain, 3 already encrypted" — and the run's report lists what
// happened to each file. It knows nothing about how a file is sealed; that is
// padova's, behind the folder command.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModalPanel from "petalite/ModalPanel.vue";
import { OyaModal } from "petalite/primitives";
import { lockErrorKey, passphraseStatus } from "padova";
import { dialogErrorKey, errorText } from "../files/fs";
import { folderLock, folderPreview, type FolderPreview, type FolderReport } from "./folder";
import ManaCost from "./ManaCost.vue";
import { manaCharge, manaQuote, manaRecord, type ManaQuote } from "./mana";

const props = defineProps<{
  open: boolean;
  name: string;
  path: string;
}>();

const emit = defineEmits<{
  "update:open": [boolean];
  /** A run finished (whatever its report says); the caller re-reads. */
  done: [FolderReport, "lock" | "unlock"];
}>();

const { t } = useI18n({ useScope: "global" });

const preview = ref<FolderPreview | null>(null);
const previewError = ref("");
const mode = ref<"lock" | "unlock">("lock");
const password = ref("");
const confirm = ref("");
const remembered = ref(false);
const busy = ref(false);
const error = ref("");
const report = ref<FolderReport | null>(null);
/** What decrypting everything encrypted here would cost; shown in unlock
 *  mode, before the run. Charged afterwards by what was actually decrypted. */
const quote = ref<ManaQuote | null>(null);

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return;
  preview.value = null;
  previewError.value = "";
  password.value = "";
  confirm.value = "";
  error.value = "";
  report.value = null;
  busy.value = false;
  try {
    remembered.value = (await passphraseStatus()).remembered;
  } catch {
    remembered.value = false;
  }
  try {
    preview.value = await folderPreview(props.path);
    // Offer the direction that has something to do.
    mode.value = preview.value.plain === 0 && preview.value.sealed > 0 ? "unlock" : "lock";
    quote.value = preview.value.sealed > 0 ? await manaQuote("decrypt_folder", preview.value.sealed) : null;
  } catch (err) {
    previewError.value = sentence(errorText(err));
  }
});

/** Decrypting may use the remembered passphrase; encrypting always asks, and
 *  asks twice. */
function ready(): boolean {
  if (busy.value || !preview.value) return false;
  if (mode.value === "lock") return password.value.length > 0 && password.value === confirm.value;
  return password.value.length > 0 || remembered.value;
}

/** Both fields typed and different: said as they are typed, not on submit,
 *  because the button is disabled until they match. */
const mismatch = () => mode.value === "lock" && confirm.value.length > 0 && password.value !== confirm.value;

/** A Rust answer as a sentence: workspace refusals and sealing refusals both
 *  have words, chosen as the passphrase dialog chooses them — an encrypt run
 *  says "too big to encrypt", a decrypt run "too big to open here". Anything
 *  else (a filesystem message) is shown as it came. */
function sentence(message: string): string {
  const key = dialogErrorKey(message, mode.value) ?? lockErrorKey(message);
  return key ? t(key) : message;
}

async function run() {
  if (!ready()) return;
  error.value = "";
  busy.value = true;
  try {
    const result = await folderLock(props.path, password.value || null, mode.value === "unlock");
    report.value = result;
    // Paid, or recorded, for what happened — not for what was asked.
    if (mode.value === "unlock") await manaCharge("decrypt_folder", result.done.length, props.path);
    else if (result.done.length) await manaRecord("encrypt_folder", props.path);
    emit("done", result, mode.value);
  } catch (err) {
    error.value = sentence(errorText(err));
  } finally {
    password.value = "";
    confirm.value = "";
    busy.value = false;
  }
}

function failureText(failure: { path: string; error: string }): string {
  return `${failure.path}: ${sentence(failure.error)}`;
}
</script>

<template>
  <OyaModal :open="open" @close="!busy && emit('update:open', false)">
    <ModalPanel :title="t('folder.title', { name })">
      <p class="truncate text-xs opacity-60" :title="path">{{ path }}</p>

      <p v-if="previewError" class="text-sm text-warn-dark" data-testid="folder-preview-error">{{ previewError }}</p>
      <p v-else-if="!preview" class="text-xs opacity-60">{{ t("common.loading") }}</p>
      <p v-else class="text-sm" data-testid="folder-preview">
        {{ t("folder.preview", { files: preview.files, plain: preview.plain, sealed: preview.sealed }) }}
        <span v-if="preview.links" class="opacity-60"> {{ t("folder.links", { n: preview.links }) }}</span>
        <span v-if="preview.truncated" class="text-warn-dark"> {{ t("folder.truncated") }}</span>
      </p>

      <template v-if="preview && !report">
        <div class="flex gap-2" role="radiogroup">
          <label class="flex cursor-pointer items-center gap-1.5 text-sm">
            <input v-model="mode" type="radio" value="lock" data-testid="folder-mode-lock" :disabled="busy" />
            {{ t("folder.encryptAll") }}
          </label>
          <label class="flex cursor-pointer items-center gap-1.5 text-sm">
            <input v-model="mode" type="radio" value="unlock" data-testid="folder-mode-unlock" :disabled="busy" />
            {{ t("folder.decryptAll") }}
          </label>
        </div>

        <p class="text-xs opacity-70" data-testid="folder-note">
          {{ t(mode === "lock" ? "folder.noteLock" : "folder.noteUnlock") }}
          {{ t("folder.noteCommon") }}
        </p>
        <template v-if="mode === 'unlock' && quote">
          <p class="text-xs" data-testid="folder-consequence">{{ t("mana.consequence.decrypt_folder") }}</p>
          <ManaCost :quote="quote" />
        </template>

        <input v-model="password" type="password" autocomplete="off"
               :placeholder="mode === 'unlock' && remembered ? t('folder.rememberedPlaceholder') : t('lock.password')"
               data-testid="folder-password" :disabled="busy"
               class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
               @keydown.enter="run" />
        <input v-if="mode === 'lock'" v-model="confirm" type="password" autocomplete="off"
               :placeholder="t('lock.confirm')" data-testid="folder-confirm" :disabled="busy"
               class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
               @keydown.enter="run" />

        <p v-if="mismatch()" class="text-xs text-warn-dark" data-testid="folder-mismatch">{{ t("lock.passwordMismatch") }}</p>
        <p v-if="error" class="text-sm text-warn-dark" data-testid="folder-error">{{ error }}</p>
      </template>

      <div v-if="report" class="flex flex-col gap-1 text-sm" data-testid="folder-report">
        <p>{{ t("folder.reportDone", { n: report.done.length }) }}</p>
        <p v-if="report.skipped.length" class="opacity-70">{{ t("folder.reportSkipped", { n: report.skipped.length }) }}</p>
        <p v-if="report.untried.length" class="text-warn-dark" data-testid="folder-untried">
          {{ t("folder.reportUntried", { n: report.untried.length }) }}
        </p>
        <p v-if="report.failed.length" class="text-warn-dark">{{ t("folder.reportFailed", { n: report.failed.length }) }}</p>
        <ul v-if="report.failed.length" class="max-h-32 overflow-y-auto text-xs opacity-80">
          <li v-for="f in report.failed" :key="f.path" data-testid="folder-failure">{{ failureText(f) }}</li>
        </ul>
      </div>

      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1"
                data-testid="folder-close" :disabled="busy" @click="emit('update:open', false)">
          {{ t(report ? "common.close" : "common.cancel") }}
        </button>
        <button v-if="!report" type="button" data-testid="folder-run"
                class="rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light
                       transition hover:opacity-90 disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                :disabled="!ready()" @click="run">
          <font-awesome-icon :icon="busy ? 'spinner' : mode === 'lock' ? 'lock' : 'lock-open'" :spin="busy" />
          {{ t(mode === "lock" ? "folder.encryptAll" : "folder.decryptAll") }}
        </button>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
