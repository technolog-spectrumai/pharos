<script setup lang="ts">
// Enigma Cloud login / registration modal. One form, two modes (a link-style
// toggle switches between them); submits through the cloud store, which stores
// the session token in the encrypted kv (Rust side) and refreshes the listing.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaModal, OyaTextField, OyaButton } from "rakotis";
import { useCloudStore } from "../../stores/cloud";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const { t } = useI18n({ useScope: "global" });
const cloud = useCloudStore();

const mode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const confirm = ref("");
const busy = ref(false);
const error = ref("");

// Fresh form every time the modal opens.
watch(
  () => props.open,
  (o) => {
    if (!o) return;
    mode.value = "login";
    username.value = "";
    password.value = "";
    confirm.value = "";
    busy.value = false;
    error.value = "";
  },
);

function close() {
  if (busy.value) return;
  emit("update:open", false);
}

function toggleMode() {
  mode.value = mode.value === "login" ? "register" : "login";
  error.value = "";
}

async function submit() {
  if (busy.value) return;
  error.value = "";
  const user = username.value.trim();
  if (!user || !password.value) {
    error.value = t("cloud.credentialsRequired");
    return;
  }
  if (mode.value === "register") {
    // The server enforces the same minimum (400 "Password must be at least 8
    // characters.") — checking here just saves a round trip.
    if (password.value.length < 8) {
      error.value = t("cloud.passwordTooShort", { n: 8 });
      return;
    }
    if (password.value !== confirm.value) {
      error.value = t("cloud.passwordMismatch");
      return;
    }
  }
  busy.value = true;
  try {
    if (mode.value === "login") await cloud.login(user, password.value);
    else await cloud.register(user, password.value);
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
        <font-awesome-icon icon="cloud" />
        {{ mode === 'login' ? $t('cloud.loginTitle') : $t('cloud.registerTitle') }}
      </p>
      <OyaTextField
        v-model="username"
        :placeholder="$t('cloud.username')"
        :disabled="busy"
        @enter="submit"
      />
      <OyaTextField
        v-model="password"
        type="password"
        :placeholder="$t('cloud.password')"
        :disabled="busy"
        @enter="submit"
      />
      <OyaTextField
        v-if="mode === 'register'"
        v-model="confirm"
        type="password"
        :placeholder="$t('cloud.confirmPassword')"
        :disabled="busy"
        @enter="submit"
      />
      <p v-if="error" class="text-sm text-warn-dark">{{ error }}</p>
      <button
        type="button"
        class="text-xs underline opacity-70 transition hover:opacity-100"
        @click="toggleMode"
      >
        {{ mode === 'login' ? $t('cloud.switchToRegister') : $t('cloud.switchToLogin') }}
      </button>
    </div>

    <template #footer>
      <div class="flex gap-2">
        <OyaButton variant="secondary" @click="close">
          {{ $t('common.cancel') }}
        </OyaButton>
        <OyaButton :class="{ 'pointer-events-none opacity-60': busy }" @click="submit">
          <font-awesome-icon :icon="busy ? 'spinner' : 'right-to-bracket'" :spin="busy" />
          {{ mode === 'login' ? $t('cloud.login') : $t('cloud.register') }}
        </OyaButton>
      </div>
    </template>
  </OyaModal>
</template>
