<script setup lang="ts">
// Passphrase prompt for locking / unlocking a local file. One form, two modes:
//  - "lock": passphrase + confirm (min-length enforced), encrypts the file in place.
//  - "unlock": single passphrase, decrypts in place; wrong passphrase keeps the
//    modal open with an inline error (the file on disk is left untouched).
// Modeled on CloudLoginModal + the App.vue vault gate. The passphrase is never
// stored; on success we emit the result and let the parent update its record.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaModal, OyaTextField, OyaButton } from "rakotis";
import { lockLocalFile, unlockLocalFile, type LockedFileResult } from "rakotis";

const props = defineProps<{
  open: boolean;
  mode: "lock" | "unlock";
  path: string;
  name: string;
  minLen: number;
}>();
const emit = defineEmits<{
  "update:open": [boolean];
  locked: [LockedFileResult];
  unlocked: [LockedFileResult];
}>();

const { t } = useI18n({ useScope: "global" });

const passphrase = ref("");
const confirm = ref("");
const busy = ref(false);
const error = ref("");

// Fresh form every time the modal opens.
watch(
  () => props.open,
  (o) => {
    if (!o) return;
    passphrase.value = "";
    confirm.value = "";
    busy.value = false;
    error.value = "";
  },
);

function close() {
  if (busy.value) return;
  emit("update:open", false);
}

async function submit() {
  if (busy.value) return;
  error.value = "";
  if (!passphrase.value) {
    error.value = t("local.passphraseRequired");
    return;
  }
  if (props.mode === "lock") {
    if (passphrase.value.length < props.minLen) {
      error.value = t("local.passphraseTooShort", { n: props.minLen });
      return;
    }
    if (passphrase.value !== confirm.value) {
      error.value = t("local.passphraseMismatch");
      return;
    }
  }
  busy.value = true;
  try {
    if (props.mode === "lock") {
      const res = await lockLocalFile(props.path, passphrase.value);
      emit("locked", res);
    } else {
      const res = await unlockLocalFile(props.path, passphrase.value);
      emit("unlocked", res);
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
        <font-awesome-icon :icon="mode === 'lock' ? 'lock' : 'lock-open'" />
        {{ mode === 'lock' ? $t('local.lockTitle') : $t('local.unlockTitle') }}
      </p>
      <p class="truncate text-sm opacity-70">{{ name }}</p>
      <p v-if="mode === 'lock'" class="text-xs opacity-60">{{ $t('local.lockHint') }}</p>
      <OyaTextField
        v-model="passphrase"
        type="password"
        :placeholder="$t('local.passphrase')"
        :disabled="busy"
        @enter="submit"
      />
      <OyaTextField
        v-if="mode === 'lock'"
        v-model="confirm"
        type="password"
        :placeholder="$t('local.confirmPassphrase')"
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
          <font-awesome-icon
            :icon="busy ? 'spinner' : (mode === 'lock' ? 'lock' : 'lock-open')"
            :spin="busy"
          />
          {{ mode === 'lock' ? $t('local.lock') : $t('local.unlock') }}
        </OyaButton>
      </div>
    </template>
  </OyaModal>
</template>
