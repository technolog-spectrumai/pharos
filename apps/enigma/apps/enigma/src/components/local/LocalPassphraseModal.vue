<script setup lang="ts">
// Passphrase prompt for locking / unlocking / rotating a local file, and for the notes
// editor. One form, five modes:
//  - "lock": passphrase + confirm (min-length enforced), encrypts the file in place.
//  - "unlock": single passphrase, decrypts in place; wrong passphrase keeps the modal
//    open with an inline error (the file on disk is left untouched).
//  - "rotate": current passphrase + optional new passphrase (blank = keep the same);
//    re-keys the file under a fresh random key. Wrong current passphrase → inline error.
//  - "open": single passphrase, to decrypt a locked file into the editor.
//  - "encrypt": new passphrase + confirm, to seal a plain note from the editor.
// The last two don't map to a fixed command — what "submit" does depends on the editor's
// state — so the parent supplies it as `action`. A rejected action keeps the modal open
// with its message inline, same as a wrong passphrase anywhere else.
// Modeled on the App.vue vault gate. The passphrase is never stored;
// on success we emit the result and let the parent update its record.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaModal, OyaTextField, OyaButton } from "rakotis";
import {
  keyringLock, keyringUnlock,
  lockLocalFile, unlockLocalFile, rotateLocalFile,
  type KeyringSummary, type LockedFileResult,
} from "rakotis";

/** What the ring flows add on top of the per-file result: which method locked
 *  the file, and where it now lives (keyring renames to `.enigr`, unlock
 *  restores the original name — unlike ENIGLOCK's seal-in-place). */
export type LockOutcome = LockedFileResult & {
  ring?: boolean;
  /** Which ring holds the key — unlock must go back to the same one. */
  ringId?: string;
  newPath?: string;
};

const props = defineProps<{
  open: boolean;
  mode: "lock" | "unlock" | "rotate" | "open" | "encrypt";
  path: string;
  name: string;
  minLen: number;
  /** Required by the "open" and "encrypt" modes; ignored by the others. */
  action?: (passphrase: string) => Promise<void>;
  /** Lock mode: the rings available to lock into. Empty = no ring option. */
  rings?: KeyringSummary[];
  /** Unlock mode: the ring that holds this file's key. */
  ringId?: string;
  /** Unlock mode: the file IS ring-locked — no method choice, the ring's one
   *  passphrase is the only thing that opens it. */
  ringForced?: boolean;
  /** Plaintext size for the record, when the caller knows it (ring outcomes
   *  don't carry one). */
  fileSize?: number;
}>();
const emit = defineEmits<{
  "update:open": [boolean];
  locked: [LockOutcome];
  unlocked: [LockOutcome];
  rotated: [LockedFileResult];
}>();

const { t } = useI18n({ useScope: "global" });

// `passphrase` is the primary field: the new passphrase (lock), the passphrase
// (unlock), or the CURRENT passphrase (rotate). `newPass` is the rotate-only new
// passphrase. `confirm` verifies the new passphrase (lock, or rotate when changing).
const passphrase = ref("");
const newPass = ref("");
const confirm = ref("");
const busy = ref(false);
const error = ref("");
/** Lock-mode method: a fresh per-file passphrase, or the ring's one. */
const method = ref<"pass" | "ring">("pass");
const ringOffered = computed(() => (props.rings?.length ?? 0) > 0);
const usingRing = computed(
  () => props.ringForced || (props.mode === "lock" && ringOffered.value && method.value === "ring"),
);
/** Which ring a lock goes into; unlock is pinned to the file's own ring. */
const chosenRing = ref("");
const activeRing = computed(() => props.ringId || chosenRing.value || props.rings?.[0]?.id || "");

// Fresh form every time the modal opens.
watch(
  () => props.open,
  (o) => {
    if (!o) return;
    passphrase.value = "";
    newPass.value = "";
    confirm.value = "";
    busy.value = false;
    error.value = "";
    method.value = props.ringForced ? "ring" : "pass";
    chosenRing.value = props.rings?.[0]?.id ?? "";
  },
);

const TITLE_KEYS = {
  lock: "local.lockTitle",
  unlock: "local.unlockTitle",
  rotate: "local.rotateTitle",
  open: "local.openTitle",
  encrypt: "local.encryptTitle",
} as const;
const HINT_KEYS = {
  lock: "local.lockHint",
  unlock: "",
  rotate: "local.rotateHint",
  open: "",
  encrypt: "local.encryptHint",
} as const;
const PRIMARY_ICONS = {
  lock: "lock",
  unlock: "lock-open",
  rotate: "rotate-right",
  open: "lock-open",
  encrypt: "lock",
} as const;
const PRIMARY_LABEL_KEYS = {
  lock: "local.lock",
  unlock: "local.unlock",
  rotate: "local.rotate",
  open: "local.open",
  encrypt: "local.encrypt",
} as const;

const titleKey = computed(() => TITLE_KEYS[props.mode]);
const hintKey = computed(() => HINT_KEYS[props.mode]);
const primaryIcon = computed(() => PRIMARY_ICONS[props.mode]);
const primaryLabelKey = computed(() => PRIMARY_LABEL_KEYS[props.mode]);
// Confirm field: whenever a new passphrase is being set — always for lock and encrypt,
// for rotate only when actually changing it.
const showConfirm = computed(
  () =>
    !usingRing.value &&
    (props.mode === "lock" ||
      props.mode === "encrypt" ||
      (props.mode === "rotate" && newPass.value.trim() !== "")),
);

function close() {
  if (busy.value) return;
  emit("update:open", false);
}

/** Validate a new passphrase against min-length + its confirm field. */
function newPassInvalid(value: string): string | null {
  if (value.length < props.minLen) return t("local.passphraseTooShort", { n: props.minLen });
  if (value !== confirm.value) return t("local.passphraseMismatch");
  return null;
}

async function submit() {
  if (busy.value) return;
  error.value = "";
  if (!passphrase.value) {
    error.value = t("local.passphraseRequired");
    return;
  }
  if ((props.mode === "lock" && !usingRing.value) || props.mode === "encrypt") {
    const bad = newPassInvalid(passphrase.value);
    if (bad) {
      error.value = bad;
      return;
    }
  } else if (props.mode === "rotate" && newPass.value) {
    const bad = newPassInvalid(newPass.value);
    if (bad) {
      error.value = bad;
      return;
    }
  }
  busy.value = true;
  try {
    if (props.mode === "open" || props.mode === "encrypt") {
      // The parent decides what to do with the passphrase (read, save, or seal).
      await props.action?.(passphrase.value);
    } else if (props.mode === "lock" && usingRing.value) {
      // Verifies the ring passphrase, mints a DEK, seals the file as .enigr.
      const [outcome] = await keyringLock(activeRing.value, passphrase.value, [props.path]);
      if (outcome?.status !== "locked") {
        throw new Error(outcome?.error || t(`keys.outcome${outcome?.status === "already-locked" ? "AlreadyLocked" : "Failed"}`));
      }
      emit("locked", {
        name: (outcome.newPath ?? props.path).split(/[\\/]/).pop() ?? props.name,
        size: props.fileSize ?? 0,
        ring: true,
        ringId: activeRing.value,
        newPath: outcome.newPath,
      });
    } else if (props.mode === "lock") {
      emit("locked", await lockLocalFile(props.path, passphrase.value));
    } else if (props.mode === "unlock" && usingRing.value) {
      const [outcome] = await keyringUnlock(activeRing.value, passphrase.value, [props.path]);
      if (outcome?.status !== "unlocked") {
        throw new Error(outcome?.error || t("keys.outcomeFailed"));
      }
      emit("unlocked", {
        name: (outcome.newPath ?? props.path).split(/[\\/]/).pop() ?? props.name,
        size: props.fileSize ?? 0,
        ring: true,
        ringId: activeRing.value,
        newPath: outcome.newPath,
      });
    } else if (props.mode === "unlock") {
      emit("unlocked", await unlockLocalFile(props.path, passphrase.value));
    } else {
      // Blank new passphrase ⇒ keep the same one (still rolls the key).
      const next = newPass.value || passphrase.value;
      emit("rotated", await rotateLocalFile(props.path, passphrase.value, next));
    }
    emit("update:open", false);
  } catch (e) {
    error.value = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon :icon="primaryIcon" />
        {{ $t(titleKey) }}
      </p>
      <p class="truncate text-sm opacity-70">{{ name }}</p>
      <p v-if="hintKey && !usingRing" class="text-xs opacity-60">{{ $t(hintKey) }}</p>

      <!-- Lock method: a fresh passphrase for this one file, or the ring's. -->
      <div v-if="mode === 'lock' && ringOffered" class="flex gap-1 rounded-lg border border-current/15 p-1 text-xs font-semibold">
        <button
          type="button"
          class="flex-1 rounded-md px-2 py-1.5 transition"
          :class="method === 'pass' ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60 hover:opacity-100'"
          data-testid="lock-method-pass"
          @click="method = 'pass'"
        >
          <font-awesome-icon icon="lock" /> {{ $t('local.methodPassphrase') }}
        </button>
        <button
          type="button"
          class="flex-1 rounded-md px-2 py-1.5 transition"
          :class="method === 'ring' ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60 hover:opacity-100'"
          data-testid="lock-method-ring"
          @click="method = 'ring'"
        >
          <font-awesome-icon icon="key" /> {{ $t('local.methodKeyring') }}
        </button>
      </div>
      <p v-if="usingRing" class="text-xs opacity-60">{{ $t('local.ringLockHint') }}</p>
      <!-- Which ring: only worth asking when there is more than one. -->
      <select
        v-if="mode === 'lock' && usingRing && (rings?.length ?? 0) > 1"
        v-model="chosenRing"
        class="w-full rounded-lg border border-accent-2 bg-transparent px-3 py-2 text-sm dark:border-accent-1"
        data-testid="lock-ring-select"
      >
        <option v-for="r in rings" :key="r.id" :value="r.id">{{ r.name || r.id }}</option>
      </select>

      <OyaTextField
        v-model="passphrase"
        type="password"
        :placeholder="usingRing ? $t('local.ringPassphrase') : (mode === 'rotate' ? $t('local.currentPassphrase') : $t('local.passphrase'))"
        :disabled="busy"
        @enter="submit"
      />
      <OyaTextField
        v-if="mode === 'rotate'"
        v-model="newPass"
        type="password"
        :placeholder="$t('local.newPassphrase')"
        :disabled="busy"
        @enter="submit"
      />
      <OyaTextField
        v-if="showConfirm"
        v-model="confirm"
        type="password"
        :placeholder="mode === 'rotate' ? $t('local.confirmNewPassphrase') : $t('local.confirmPassphrase')"
        :disabled="busy"
        @enter="submit"
      />
      <p v-if="error" class="text-sm text-warn-dark">{{ error }}</p>
    </div>

    <template #footer>
      <div class="flex gap-2">
        <OyaButton variant="secondary" @click="close">
          {{ $t('common.cancel') }}
        </OyaButton>
        <OyaButton :class="{ 'pointer-events-none opacity-60': busy }" @click="submit">
          <font-awesome-icon :icon="busy ? 'spinner' : primaryIcon" :spin="busy" />
          {{ $t(primaryLabelKey) }}
        </OyaButton>
      </div>
    </template>
  </OyaModal>
</template>
