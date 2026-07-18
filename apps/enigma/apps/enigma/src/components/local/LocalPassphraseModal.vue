<script setup lang="ts">
// Passphrase prompt for locking / unlocking / rotating a local file. One form, three
// modes:
//  - "lock": passphrase + confirm (min-length enforced), encrypts the file in place.
//  - "unlock": single passphrase, decrypts in place; wrong passphrase keeps the modal
//    open with an inline error (the file on disk is left untouched).
//  - "rotate": current passphrase + optional new passphrase (blank = keep the same);
//    re-keys the file under a fresh random key. Wrong current passphrase → inline error.
// Modeled on CloudLoginModal + the App.vue vault gate. The passphrase is never stored;
// on success we emit the result and let the parent update its record.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaModal, OyaTextField, OyaButton } from "rakotis";
import { lockLocalFile, unlockLocalFile, rotateLocalFile, type LockedFileResult } from "rakotis";

const props = defineProps<{
  open: boolean;
  mode: "lock" | "unlock" | "rotate";
  path: string;
  name: string;
  minLen: number;
}>();
const emit = defineEmits<{
  "update:open": [boolean];
  locked: [LockedFileResult];
  unlocked: [LockedFileResult];
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
  },
);

const titleKey = computed(() =>
  props.mode === "lock" ? "local.lockTitle" : props.mode === "unlock" ? "local.unlockTitle" : "local.rotateTitle",
);
const hintKey = computed(() =>
  props.mode === "lock" ? "local.lockHint" : props.mode === "rotate" ? "local.rotateHint" : "",
);
const primaryIcon = computed(() =>
  props.mode === "lock" ? "lock" : props.mode === "unlock" ? "lock-open" : "rotate-right",
);
const primaryLabelKey = computed(() =>
  props.mode === "lock" ? "local.lock" : props.mode === "unlock" ? "local.unlock" : "local.rotate",
);
// Confirm field: always for lock; for rotate only when actually setting a new passphrase.
const showConfirm = computed(
  () => props.mode === "lock" || (props.mode === "rotate" && newPass.value.trim() !== ""),
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
  if (props.mode === "lock") {
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
    if (props.mode === "lock") {
      emit("locked", await lockLocalFile(props.path, passphrase.value));
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
      <p v-if="hintKey" class="text-xs opacity-60">{{ $t(hintKey) }}</p>
      <OyaTextField
        v-model="passphrase"
        type="password"
        :placeholder="mode === 'rotate' ? $t('local.currentPassphrase') : $t('local.passphrase')"
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
