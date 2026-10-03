<script setup lang="ts">
// "Out of Security Mana — encrypt some files?"
//
// Opened by the app when the bar reaches zero with plain files still in the
// workspace, once per time it runs out (and again after a workspace switch),
// and on purpose from workspace security. It lists the costliest plain files
// — Rust's list, most expensive first — with enough of them ticked that,
// once encrypted, Mana would start coming back; the user can change the
// ticks. One passphrase, typed twice, encrypts the ticked ones file by file.
//
// It asks; it never blocks. "Not now" closes it and nothing is held back.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModalPanel from "petalite/ModalPanel.vue";
import { OyaModal } from "petalite/primitives";
import { formatSize, useWorkspace } from "petalite/files";
import { lockErrorKey, rememberPassphrase } from "padova";
import { dialogErrorKey, errorText } from "../files/fs";
import { filesLock, type FolderReport } from "./folder";
import { formatMana, manaPrompt, manaRecord, manaStatus, refreshMana, type ManaStatus, type PlainFile } from "./mana";

const emit = defineEmits<{
  /** Files were encrypted: the caller re-reads the tree and the open file. */
  done: [FolderReport];
}>();

const { t } = useI18n({ useScope: "global" });
const workspace = useWorkspace();

// ── when it opens by itself ─────────────────────────────────────────────────
/** Asked already this time the bar ran out. Cleared when Mana comes back
 *  above zero and when the workspace changes, so the next time it runs out
 *  asks again. */
let asked = false;
watch(() => manaStatus.value, (s) => {
  if (!s || !s.exhausted) {
    asked = false;
    return;
  }
  if (!asked && s.plainFiles > 0 && s.top.length > 0 && manaPrompt.value === null) {
    asked = true;
    manaPrompt.value = "empty";
  }
});
watch(() => workspace.root.value, () => { asked = false; });

// ── the dialog ──────────────────────────────────────────────────────────────
const open = computed(() => manaPrompt.value !== null);
const candidates = ref<PlainFile[]>([]);
const chosen = ref<Set<string>>(new Set());
const password = ref("");
const confirm = ref("");
const remember = ref(false);
const busy = ref(false);
const error = ref("");
const report = ref<FolderReport | null>(null);

/** Tick from the top until what is left drains less than comes back — the
 *  smallest set that turns the bar around, if the listed files can. At least
 *  one either way. */
function preselect(s: ManaStatus): Set<string> {
  const pick = new Set<string>();
  let drain = s.drainPerHour;
  for (const file of s.top) {
    if (pick.size > 0 && drain < s.regenPerHour) break;
    pick.add(file.path);
    drain -= file.perHour;
  }
  return pick;
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  const s = manaStatus.value;
  candidates.value = s?.top ?? [];
  chosen.value = s ? preselect(s) : new Set();
  password.value = "";
  confirm.value = "";
  remember.value = false;
  error.value = "";
  report.value = null;
  busy.value = false;
});

function toggle(path: string) {
  const next = new Set(chosen.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  chosen.value = next;
}

/** What the ticked files cost an hour together: what encrypting them saves. */
const saving = computed(() =>
  candidates.value.filter((f) => chosen.value.has(f.path)).reduce((sum, f) => sum + f.perHour, 0));

const mismatch = computed(() => confirm.value.length > 0 && password.value !== confirm.value);
const ready = computed(() =>
  !busy.value && chosen.value.size > 0 && password.value.length > 0 && password.value === confirm.value);

function close() {
  if (busy.value) return;
  manaPrompt.value = null;
}

function sentence(message: string): string {
  const key = dialogErrorKey(message, "lock") ?? lockErrorKey(message);
  return key ? t(key) : message;
}

async function run() {
  if (!ready.value) return;
  busy.value = true;
  error.value = "";
  const paths = candidates.value.filter((f) => chosen.value.has(f.path)).map((f) => f.path);
  try {
    const result = await filesLock(paths, password.value);
    report.value = result;
    for (const rel of result.done) await manaRecord("encrypt_file", rel);
    if (remember.value && result.done.length) await rememberPassphrase(password.value);
    await refreshMana();
    emit("done", result);
  } catch (err) {
    error.value = sentence(errorText(err));
  } finally {
    password.value = "";
    confirm.value = "";
    busy.value = false;
  }
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <ModalPanel :title="t(manaPrompt === 'empty' ? 'mana.prompt.titleEmpty' : 'mana.prompt.title')">
      <div data-testid="mana-prompt" class="flex flex-col gap-3">
        <p v-if="manaStatus" class="text-sm" data-testid="mana-prompt-why">
          {{ t("mana.prompt.why", { drain: formatMana(manaStatus.drainPerHour), regen: formatMana(manaStatus.regenPerHour) }) }}
        </p>

        <template v-if="!report">
          <ul class="max-h-56 overflow-y-auto rounded-lg border border-accent-2 text-xs dark:border-accent-1">
            <li v-for="(file, i) in candidates" :key="file.path"
                class="border-b border-current/10 last:border-0">
              <label class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
                <input type="checkbox" :checked="chosen.has(file.path)" :disabled="busy"
                       :data-testid="`mana-prompt-file-${i}`" @change="toggle(file.path)" />
                <span class="min-w-0 flex-1 truncate" :title="file.relPath">{{ file.relPath }}</span>
                <span class="shrink-0 opacity-50">{{ formatSize(file.bytes) }}</span>
                <span class="w-16 shrink-0 text-right font-semibold tabular-nums" :data-testid="`mana-prompt-rate-${i}`">
                  {{ t("mana.perHour", { rate: formatMana(file.perHour) }) }}
                </span>
              </label>
            </li>
          </ul>
          <p v-if="manaStatus && manaStatus.plainFiles > candidates.length" class="text-xs opacity-60">
            {{ t("mana.prompt.more", { n: manaStatus.plainFiles - candidates.length }) }}
          </p>
          <p class="text-xs font-semibold" data-testid="mana-prompt-saving">
            {{ t("mana.prompt.saving", { n: chosen.size, rate: formatMana(saving) }, chosen.size) }}
          </p>

          <input v-model="password" type="password" autocomplete="off" :placeholder="t('lock.password')"
                 data-testid="mana-prompt-password" :disabled="busy"
                 class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
                 @keydown.enter="run" />
          <input v-model="confirm" type="password" autocomplete="off" :placeholder="t('lock.confirm')"
                 data-testid="mana-prompt-confirm" :disabled="busy"
                 class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
                 @keydown.enter="run" />
          <p v-if="mismatch" class="text-xs text-warn-dark" data-testid="mana-prompt-mismatch">{{ t("lock.passwordMismatch") }}</p>
          <label class="flex cursor-pointer items-start gap-2 text-xs opacity-80">
            <input v-model="remember" type="checkbox" data-testid="mana-prompt-remember" :disabled="busy"
                   class="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent-light dark:accent-accent-dark" />
            <span>{{ t("lock.remember") }}</span>
          </label>
          <p class="text-xs opacity-60">{{ t("mana.prompt.advisory") }}</p>
          <p v-if="error" class="text-sm text-warn-dark" data-testid="mana-prompt-error">{{ error }}</p>
        </template>

        <div v-else class="flex flex-col gap-1 text-sm" data-testid="mana-prompt-report">
          <p>{{ t("folder.reportDone", { n: report.done.length }) }}</p>
          <p v-if="report.skipped.length" class="opacity-70">{{ t("folder.reportSkipped", { n: report.skipped.length }) }}</p>
          <p v-if="report.failed.length" class="text-warn-dark">{{ t("folder.reportFailed", { n: report.failed.length }) }}</p>
          <ul v-if="report.failed.length" class="max-h-32 overflow-y-auto text-xs opacity-80">
            <li v-for="(f, i) in report.failed" :key="i">{{ f.path ? `${f.path}: ` : "" }}{{ sentence(f.error) }}</li>
          </ul>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" data-testid="mana-prompt-later" :disabled="busy"
                  class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1" @click="close">
            {{ t(report ? "common.close" : "mana.prompt.later") }}
          </button>
          <button v-if="!report" type="button" data-testid="mana-prompt-run" :disabled="!ready"
                  class="rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light
                         transition hover:opacity-90 disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                  @click="run">
            <font-awesome-icon :icon="busy ? 'spinner' : 'lock'" :spin="busy" />
            {{ t("mana.prompt.run", { n: chosen.size }, chosen.size) }}
          </button>
        </div>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
