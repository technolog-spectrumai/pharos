<script setup lang="ts">
// The password prompt for locking and unlocking a file.
//
// It knows nothing about how a file is encrypted — the caller passes an
// `action` and this asks for the password it needs. That is why it survived the
// cloud being parked and the sealing format being replaced underneath it
// without a line changing: it was written against the question, not the answer.
//
// The password is a ref that is cleared the moment the action settles, success
// or failure — a failed attempt must not leave it sitting in a field for the
// next person at the keyboard.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModalPanel from "petalite/ModalPanel.vue";
import { lockErrorKey } from "../lock";
import { OyaModal } from "petalite/primitives";

const props = defineProps<{
  open: boolean;
  mode: "lock" | "unlock";
  name: string;
  action: (password: string, remember: boolean) => Promise<void>;
  /** Offer to keep the passphrase in the OS secret store. Absent where there is
   *  no Rust to keep it in. */
  offerRemember?: boolean;
}>();

const emit = defineEmits<{ "update:open": [boolean]; done: [] }>();

const { t } = useI18n({ useScope: "global" });

const password = ref("");
const confirm = ref("");
const remember = ref(false);
const busy = ref(false);
const error = ref("");

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    password.value = "";
    confirm.value = "";
    remember.value = false;
    busy.value = false;
    error.value = "";
  },
);

async function submit() {
  if (busy.value) return;
  error.value = "";
  if (!password.value) {
    error.value = t("lock.passwordRequired");
    return;
  }
  if (props.mode === "lock" && password.value !== confirm.value) {
    error.value = t("lock.passwordMismatch");
    return;
  }
  busy.value = true;
  try {
    await props.action(password.value, remember.value);
    emit("done");
    emit("update:open", false);
  } catch (err) {
    // Tauri rejects a `Result<_, String>` with the bare string.
    const message = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
    const key = lockErrorKey(message);
    // A filesystem message has no key and says more verbatim than "something
    // failed" would; a Rust prefix always has one. The list lives in
    // ../security/lock so it can be tested against lock.rs itself.
    error.value = key ? t(key) : message;
  } finally {
    password.value = "";
    confirm.value = "";
    busy.value = false;
  }
}
</script>

<template>
  <OyaModal :open="open" @close="!busy && emit('update:open', false)">
    <ModalPanel :title="t(mode === 'lock' ? 'lock.lockTitle' : 'lock.unlockTitle')">
      <p class="truncate text-xs opacity-60">{{ name }}</p>
      <p v-if="mode === 'lock'" class="text-xs opacity-70">{{ t("lock.lockHint") }}</p>

      <input v-model="password" type="password" autocomplete="off"
             :placeholder="t('lock.password')" data-testid="lock-password"
             class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
             @keydown.enter="submit" />
      <input v-if="mode === 'lock'" v-model="confirm" type="password" autocomplete="off"
             :placeholder="t('lock.confirm')" data-testid="lock-confirm"
             class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
             @keydown.enter="submit" />

      <label v-if="offerRemember" class="flex cursor-pointer items-start gap-2 text-xs opacity-80">
        <input v-model="remember" type="checkbox" data-testid="lock-remember"
               class="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent-light dark:accent-accent-dark" />
        <span>{{ t("lock.remember") }}</span>
      </label>

      <p v-if="error" class="text-sm text-warn-dark" data-testid="lock-error">{{ error }}</p>

      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1"
                :disabled="busy" @click="emit('update:open', false)">
          {{ t("common.cancel") }}
        </button>
        <button type="button" data-testid="lock-submit"
                class="rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light
                       transition hover:opacity-90 disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                :disabled="busy || !password" @click="submit">
          <font-awesome-icon :icon="busy ? 'spinner' : mode === 'lock' ? 'lock' : 'lock-open'" :spin="busy" />
          {{ t(mode === "lock" ? "lock.lock" : "lock.unlock") }}
        </button>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
