<script setup lang="ts">
// The password prompt for locking, unlocking and re-keying a file.
//
// It knows nothing about how a file is encrypted — the caller passes an
// `action` and this asks for the password it needs. That is why it survived the
// cloud being parked and the sealing format being replaced underneath it
// without a line changing: it was written against the question, not the answer.
//
// The passwords are refs cleared the moment the action settles, success or
// failure — a failed attempt must not leave one sitting in a field for the
// next person at the keyboard.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModalPanel from "petalite/ModalPanel.vue";
import { lockErrorKey } from "../lock";
import { OyaModal } from "petalite/primitives";

const props = defineProps<{
  open: boolean;
  /** `open` is decrypting INTO MEMORY for an edit — the file on disk stays
   *  encrypted — as opposed to `unlock`, which rewrites it plain. `rekey`
   *  asks for the current password and a new one, twice. */
  mode: "lock" | "unlock" | "open" | "rekey";
  name: string;
  /** `next` is the new password, in `rekey` mode only; `remember` then means
   *  the new one. */
  action: (password: string, remember: boolean, next?: string) => Promise<void>;
  /** Offer to keep the passphrase in the OS secret store. Absent where there is
   *  no Rust to keep it in. */
  offerRemember?: boolean;
}>();

const emit = defineEmits<{ "update:open": [boolean]; done: [] }>();

/** Named, so the submit button's icon binding holds nothing but icon names —
 *  the app's icon test reads every quoted word there as one. */
const rekeying = computed(() => props.mode === "rekey");

const { t } = useI18n({ useScope: "global" });

const password = ref("");
/** The new password, in `rekey` mode. */
const next = ref("");
const confirm = ref("");
const remember = ref(false);
const busy = ref(false);
const error = ref("");

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    password.value = "";
    next.value = "";
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
  if (props.mode === "rekey") {
    if (!next.value) {
      error.value = t("lock.newRequired");
      return;
    }
    if (next.value !== confirm.value) {
      error.value = t("lock.passwordMismatch");
      return;
    }
    if (next.value === password.value) {
      error.value = t("lock.samePassword");
      return;
    }
  }
  busy.value = true;
  try {
    if (props.mode === "rekey") await props.action(password.value, remember.value, next.value);
    else await props.action(password.value, remember.value);
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
    next.value = "";
    confirm.value = "";
    busy.value = false;
  }
}
</script>

<template>
  <OyaModal :open="open" @close="!busy && emit('update:open', false)">
    <ModalPanel :title="t(mode === 'lock' ? 'lock.lockTitle' : mode === 'open' ? 'lock.openTitle' : mode === 'rekey' ? 'lock.rekeyTitle' : 'lock.unlockTitle')">
      <p class="truncate text-xs opacity-60">{{ name }}</p>
      <p v-if="mode === 'lock'" class="text-xs opacity-70">{{ t("lock.lockHint") }}</p>
      <p v-else-if="mode === 'open'" class="text-xs opacity-70" data-testid="lock-open-hint">{{ t("lock.openHint") }}</p>
      <p v-else-if="mode === 'rekey'" class="text-xs opacity-70" data-testid="lock-rekey-hint">{{ t("lock.rekeyHint") }}</p>
      <p v-else class="text-xs opacity-70" data-testid="lock-unlock-hint">{{ t("lock.unlockHint") }}</p>
      <!-- Whatever the app wants said before the password is typed: a price,
           a warning. The modal does not know what it is. -->
      <slot name="notice" />

      <input v-model="password" type="password" autocomplete="off"
             :placeholder="t(mode === 'rekey' ? 'lock.currentPassword' : 'lock.password')" data-testid="lock-password"
             class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
             @keydown.enter="submit" />
      <input v-if="mode === 'rekey'" v-model="next" type="password" autocomplete="off"
             :placeholder="t('lock.newPassword')" data-testid="lock-new"
             class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
             @keydown.enter="submit" />
      <input v-if="mode === 'lock' || mode === 'rekey'" v-model="confirm" type="password" autocomplete="off"
             :placeholder="t(mode === 'rekey' ? 'lock.confirmNew' : 'lock.confirm')" data-testid="lock-confirm"
             class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
             @keydown.enter="submit" />

      <label v-if="offerRemember" class="flex cursor-pointer items-start gap-2 text-xs opacity-80">
        <input v-model="remember" type="checkbox" data-testid="lock-remember"
               class="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent-light dark:accent-accent-dark" />
        <span>{{ t(mode === "rekey" ? "lock.rememberNew" : "lock.remember") }}</span>
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
                :disabled="busy || !password || (mode === 'rekey' && !next)" @click="submit">
          <font-awesome-icon :icon="busy ? 'spinner' : mode === 'lock' ? 'lock' : rekeying ? 'key' : 'lock-open'" :spin="busy" />
          {{ t(mode === "lock" ? "lock.lock" : mode === "open" ? "lock.open" : mode === "rekey" ? "lock.rekey" : "lock.unlock") }}
        </button>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
