<script setup lang="ts">
// Enigma Cloud login modal. Login only — registration is deliberately NOT
// offered in the app: accounts are created in a browser on the server's /sso/
// page (the hint below the form points there). Submits through the cloud
// store, which stores the session token in the encrypted kv (Rust side) and
// refreshes the listing.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaModal, OyaTextField, OyaButton } from "rakotis";
import { useCloudStore } from "../../stores/cloud";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const { t } = useI18n({ useScope: "global" });
const cloud = useCloudStore();

const username = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");

// Fresh form every time the modal opens.
watch(
  () => props.open,
  (o) => {
    if (!o) return;
    username.value = "";
    password.value = "";
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
  const user = username.value.trim();
  if (!user || !password.value) {
    error.value = t("cloud.credentialsRequired");
    return;
  }
  busy.value = true;
  try {
    await cloud.login(user, password.value);
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
        {{ $t('cloud.loginTitle') }}
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
      <p v-if="error" class="text-sm text-warn-dark">{{ error }}</p>
      <p class="text-xs opacity-60">
        {{ $t('cloud.registerExternalHint', { url: `${cloud.serverUrl}/sso/` }) }}
      </p>
    </div>

    <template #footer>
      <div class="flex gap-2">
        <OyaButton variant="secondary" @click="close">
          {{ $t('common.cancel') }}
        </OyaButton>
        <OyaButton :class="{ 'pointer-events-none opacity-60': busy }" @click="submit">
          <font-awesome-icon :icon="busy ? 'spinner' : 'right-to-bracket'" :spin="busy" />
          {{ $t('cloud.login') }}
        </OyaButton>
      </div>
    </template>
  </OyaModal>
</template>
