<script setup lang="ts">
// Files → Keys: the key ring — ONE passphrase locking and unlocking MANY files.
// A generalization of Local locked files: entries live sealed inside
// <profile>/keyring.enig, each file is encrypted in place with its own DEK
// wrapped under the ring's passphrase-derived KEK. Everything is device-local
// by design: the ring never syncs, so a ring-locked file pushed to another
// device will not open there (files:local precedent — see keyring.rs).
//
// The passphrase is never stored, not even in memory beyond the operation in
// flight: every action takes it fresh from the field (the LocalPanel rule).
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  OyaButton, OyaCard, OyaEmptyState, OyaModal, isTauri,
  getKeyringStatus, keyringChangePassphrase, keyringEntries, keyringInit,
  keyringLock, keyringRotate, keyringUnlock, keyringUnlockAll,
  type KeyringEntry, type KeyringFileOutcome,
} from "rakotis";

defineProps<{ darkMode?: boolean }>();
const { t } = useI18n({ useScope: "global" });

const exists = ref(false);
const ringName = ref("");
const showCreate = ref(false);
const createName = ref("");
const entries = ref<KeyringEntry[]>([]);
const listed = ref(false); // entries require the passphrase; empty ≠ unlisted
const passphrase = ref("");
const passphraseRepeat = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const outcomes = ref<KeyringFileOutcome[]>([]);
const selection = ref(new Set<string>());

// Change-passphrase (collapsed until opened; both fields fresh each time).
const changing = ref(false);
const changeNew = ref("");

const canAct = computed(() => isTauri() && !busy.value && passphrase.value.length > 0);

const OUTCOME_KEYS: Record<string, string> = {
  locked: "keys.outcomeLocked",
  unlocked: "keys.outcomeUnlocked",
  "already-locked": "keys.outcomeAlreadyLocked",
  rotated: "keys.outcomeRotated",
  missing: "keys.fileMissing",
  failed: "keys.outcomeFailed",
};

function fail(e: unknown): void {
  const message = (e as Error)?.message ?? String(e);
  error.value = /passphrase|decrypt|aead|tag/i.test(message) ? t("keys.wrongPassphrase") : message;
}

async function refreshStatus(): Promise<void> {
  if (!isTauri()) return;
  try {
    const status = await getKeyringStatus();
    exists.value = status.exists;
    ringName.value = status.name;
  } catch {
    /* gate errors surface on action, not on mount */
  }
}

async function createRing(): Promise<void> {
  error.value = "";
  if (!createName.value.trim()) {
    error.value = t("keys.nameRequired");
    return;
  }
  if (passphrase.value !== passphraseRepeat.value) {
    error.value = t("keys.passphraseMismatch");
    return;
  }
  busy.value = true;
  try {
    await keyringInit(passphrase.value, createName.value.trim());
    exists.value = true;
    ringName.value = createName.value.trim();
    passphraseRepeat.value = "";
    createName.value = "";
    showCreate.value = false;
    await listEntries();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function listEntries(): Promise<void> {
  error.value = "";
  busy.value = true;
  try {
    entries.value = await keyringEntries(passphrase.value);
    listed.value = true;
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function lockFiles(): Promise<void> {
  error.value = "";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, directory: false });
  const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  if (!paths.length) return;
  busy.value = true;
  try {
    outcomes.value = await keyringLock(passphrase.value, paths);
    await listEntries();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function unlockSelected(): Promise<void> {
  error.value = "";
  const paths = [...selection.value];
  if (!paths.length) return;
  busy.value = true;
  try {
    outcomes.value = await keyringUnlock(passphrase.value, paths);
    selection.value = new Set();
    await listEntries();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function unlockAll(): Promise<void> {
  error.value = "";
  busy.value = true;
  try {
    outcomes.value = await keyringUnlockAll(passphrase.value);
    selection.value = new Set();
    await listEntries();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function changePassphrase(): Promise<void> {
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    await keyringChangePassphrase(passphrase.value, changeNew.value);
    notice.value = t("keys.changed");
    passphrase.value = changeNew.value;
    changeNew.value = "";
    changing.value = false;
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

/** Rotate: new passphrase AND fresh keys, every locked file re-sealed. The
 *  outcomes list shows what happened per file. */
async function rotateRing(): Promise<void> {
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    outcomes.value = await keyringRotate(passphrase.value, changeNew.value);
    notice.value = t("keys.rotated");
    passphrase.value = changeNew.value;
    changeNew.value = "";
    changing.value = false;
    await listEntries();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

function toggle(path: string): void {
  const next = new Set(selection.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selection.value = next;
}

onMounted(refreshStatus);
</script>

<template>
  <OyaCard :padded="true" class="space-y-3">
    <div>
      <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
        <font-awesome-icon icon="key" class="mr-1" />{{ t('keys.title') }}
        <span v-if="ringName" class="normal-case tracking-normal opacity-70" data-testid="keys-name">
          · {{ ringName }}
        </span>
      </p>
      <p class="mt-1 text-sm opacity-65">{{ t('keys.hint') }}</p>
    </div>

    <p v-if="!isTauri()" class="text-sm font-semibold text-amber-500">{{ t('keys.desktopOnly') }}</p>
    <p v-if="error" class="text-sm font-semibold text-red-500" data-testid="keys-error">{{ error }}</p>
    <p v-if="notice" class="text-sm font-semibold text-emerald-500">{{ notice }}</p>

    <!-- First run: creation lives in a modal (name + passphrase twice). -->
    <template v-if="isTauri() && !exists">
      <p class="text-xs opacity-65">{{ t('keys.createHint') }}</p>
      <OyaButton data-testid="keys-create-open" @click="showCreate = true">
        <font-awesome-icon icon="key" />{{ t('keys.createTitle') }}
      </OyaButton>
    </template>


    <!-- Ring exists: passphrase field + actions. -->
    <template v-else-if="isTauri()">
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="passphrase"
          type="password"
          :placeholder="t('keys.passphrase')"
          class="min-w-48 flex-1 rounded-lg border border-accent-2 bg-transparent px-3 py-2 text-sm dark:border-accent-1"
          data-testid="keys-pass"
          @keyup.enter="listEntries()"
        />
        <OyaButton variant="secondary" :disabled="!canAct" data-testid="keys-list" @click="listEntries()">
          {{ t('keys.entriesTitle') }}
        </OyaButton>
        <OyaButton :disabled="!canAct" data-testid="keys-lock" @click="lockFiles()">
          <font-awesome-icon icon="key" />{{ t('keys.addFiles') }}
        </OyaButton>
        <OyaButton
          variant="secondary"
          :disabled="!canAct || !selection.size"
          data-testid="keys-unlock"
          @click="unlockSelected()"
        >
          {{ t('keys.unlockSelected') }}
        </OyaButton>
        <OyaButton variant="secondary" :disabled="!canAct" data-testid="keys-unlock-all" @click="unlockAll()">
          {{ t('keys.unlockAll') }}
        </OyaButton>
      </div>

      <template v-if="listed">
        <OyaEmptyState v-if="!entries.length" icon="key" class="py-6">
          {{ t('keys.empty') }}
        </OyaEmptyState>
        <ul v-else class="space-y-1" data-testid="keys-entries">
          <li
            v-for="entry in entries"
            :key="entry.path"
            class="flex items-center gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
          >
            <input
              type="checkbox"
              class="h-4 w-4 shrink-0 accent-accent-light dark:accent-accent-dark"
              :checked="selection.has(entry.path)"
              :disabled="!entry.present"
              @change="toggle(entry.path)"
            />
            <font-awesome-icon icon="key" class="shrink-0 text-accent-light dark:text-accent-dark" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ entry.name }}</p>
              <p class="truncate text-xs opacity-60">{{ entry.path }}</p>
            </div>
            <span class="shrink-0 text-xs" :class="entry.present ? 'opacity-60' : 'text-amber-500'">
              {{ entry.present ? t('keys.filePresent') : t('keys.fileMissing') }}
            </span>
          </li>
        </ul>
      </template>

      <ul v-if="outcomes.length" class="space-y-0.5 text-xs opacity-75" data-testid="keys-outcomes">
        <li v-for="o in outcomes" :key="o.path">
          <span class="font-semibold">{{ o.path.split('/').pop() }}</span> ·
          <span :class="o.status === 'failed' ? 'text-red-500' : ''">
            {{ t(OUTCOME_KEYS[o.status] ?? 'keys.outcomeFailed') }}
          </span>
        </li>
      </ul>

      <!-- Change passphrase, tucked at the bottom. -->
      <div class="border-t border-accent-2/60 pt-2 dark:border-accent-1/60">
        <button
          type="button"
          class="text-xs font-semibold opacity-60 hover:opacity-100"
          data-testid="keys-change-toggle"
          @click="changing = !changing"
        >
          {{ t('keys.changeTitle') }}
        </button>
        <div v-if="changing" class="mt-2 flex flex-wrap items-center gap-2">
          <input
            v-model="changeNew"
            type="password"
            :placeholder="t('keys.changeNew')"
            class="min-w-48 flex-1 rounded-lg border border-accent-2 bg-transparent px-3 py-2 text-sm dark:border-accent-1"
            data-testid="keys-change-new"
          />
          <OyaButton :disabled="!canAct || !changeNew" data-testid="keys-change" @click="changePassphrase()">
            {{ t('keys.change') }}
          </OyaButton>
          <OyaButton
            variant="secondary"
            :disabled="!canAct || !changeNew"
            data-testid="keys-rotate"
            :title="t('keys.rotateHint')"
            @click="rotateRing()"
          >
            <font-awesome-icon icon="rotate-right" />{{ t('keys.rotate') }}
          </OyaButton>
        </div>
        <p v-if="changing" class="mt-1 text-xs opacity-50">
          {{ t('keys.changeCurrent') }}: ↑ {{ t('keys.passphrase') }} · {{ t('keys.rotateHint') }}
        </p>
      </div>
    </template>
    <OyaModal :open="showCreate" @close="busy || (showCreate = false)">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="key" />{{ t('keys.createTitle') }}
        </p>
        <p class="text-xs opacity-60">{{ t('keys.createHint') }}</p>
        <input
          v-model="createName"
          type="text"
          :placeholder="t('keys.name')"
          class="w-full rounded-lg border border-accent-2 bg-transparent px-3 py-2 text-sm dark:border-accent-1"
          data-testid="keys-create-name"
        />
        <input
          v-model="passphrase"
          type="password"
          :placeholder="t('keys.passphrase')"
          class="w-full rounded-lg border border-accent-2 bg-transparent px-3 py-2 text-sm dark:border-accent-1"
          data-testid="keys-pass"
        />
        <input
          v-model="passphraseRepeat"
          type="password"
          :placeholder="t('keys.passphraseRepeat')"
          class="w-full rounded-lg border border-accent-2 bg-transparent px-3 py-2 text-sm dark:border-accent-1"
          data-testid="keys-pass-repeat"
          @keyup.enter="createRing()"
        />
        <p v-if="error && showCreate" class="text-sm text-warn-dark">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" :disabled="busy" @click="showCreate = false">
            {{ t('common.cancel') }}
          </OyaButton>
          <OyaButton :disabled="!canAct" data-testid="keys-create" @click="createRing()">
            {{ t('keys.create') }}
          </OyaButton>
        </div>
      </div>
    </OyaModal>
  </OyaCard>
</template>
