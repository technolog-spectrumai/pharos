<script setup lang="ts">
// Add or edit a saved cloud connection (name + address).
//
// Address changes are called out before saving, not explained afterwards: the
// session token is keyed by the normalized URL (Rust, `cloud:auth/<url>/`), so
// a different address IS a different account slot — the user is signed out of
// this connection the moment it is saved.
//
// Duplicate addresses are refused by rakotis rather than warned about: two
// entries sharing a normalized URL would share one token slot, so signing out
// of one would silently sign out the other. `sameCloudServer` catches the
// softer case (https://host vs https://host:443 — same socket, different kv
// scope) and warns, because normalization is deliberately frozen.
import { computed, ref, watch } from "vue";
import {
  OyaModal,
  OyaTextField,
  OyaButton,
  CLOUD_SERVER_URL_DEFAULT,
  cloudServerDefaultName,
  normalizeCloudServerUrl,
  sameCloudServer,
  type CloudServerEntry,
} from "rakotis";
import { useCloudStore } from "../../stores/cloud";

const props = defineProps<{ open: boolean; entry?: CloudServerEntry | null }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const cloud = useCloudStore();

const name = ref("");
const url = ref("");
const busy = ref(false);
const error = ref("");

const editing = computed(() => !!props.entry);

// Fresh form every time the modal opens (the CloudLoginModal pattern).
watch(
  () => props.open,
  (o) => {
    if (!o) return;
    name.value = props.entry?.name ?? "";
    url.value = props.entry?.url ?? "";
    busy.value = false;
    error.value = "";
  },
);

/** True once the typed address differs from what was saved — the point at which
 *  the sign-out warning becomes relevant. */
const urlChanged = computed(
  () => editing.value && normalizeCloudServerUrl(url.value) !== props.entry?.url,
);

/** Another entry that reaches the same server under a different spelling. Not
 *  an error (the addresses differ, so the kv scopes differ), but it means two
 *  independent sign-ins to one account — worth saying out loud. */
const twin = computed(() => {
  const v = normalizeCloudServerUrl(url.value);
  return cloud.servers.find(
    (s) => s.id !== props.entry?.id && s.url !== v && sameCloudServer(s.url, v),
  );
});

function close() {
  if (busy.value) return;
  emit("update:open", false);
}

async function submit() {
  if (busy.value) return;
  error.value = "";
  const v = normalizeCloudServerUrl(url.value);
  const label = name.value.trim() || cloudServerDefaultName(v);
  busy.value = true;
  try {
    if (props.entry) await cloud.editServer(props.entry.id, { name: label, url: v });
    else await cloud.addServer(label, v);
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
        <font-awesome-icon icon="server" />
        {{ editing ? $t('cloud.connectionEdit') : $t('cloud.connectionAdd') }}
      </p>
      <OyaTextField
        v-model="name"
        :placeholder="$t('cloud.connectionNamePlaceholder')"
        :disabled="busy"
        data-testid="cloud-connection-name"
        @enter="submit"
      />
      <OyaTextField
        v-model="url"
        :placeholder="CLOUD_SERVER_URL_DEFAULT"
        :disabled="busy"
        data-testid="cloud-connection-url"
        @enter="submit"
      />
      <p
        v-if="urlChanged"
        class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark"
        data-testid="cloud-connection-url-warning"
      >
        {{ $t('cloud.connectionUrlChangeWarning') }}
      </p>
      <p v-if="twin" class="text-xs opacity-70" data-testid="cloud-connection-twin">
        {{ $t('cloud.connectionSameServer', { name: twin.name }) }}
      </p>
      <p v-if="error" class="text-sm text-warn-dark" data-testid="cloud-connection-error">{{ error }}</p>
    </div>

    <template #footer>
      <div class="flex gap-2">
        <OyaButton variant="secondary" @click="close">
          {{ $t('common.cancel') }}
        </OyaButton>
        <OyaButton
          :class="{ 'pointer-events-none opacity-60': busy }"
          data-testid="cloud-connection-save"
          @click="submit"
        >
          <font-awesome-icon :icon="busy ? 'spinner' : 'floppy-disk'" :spin="busy" />
          {{ $t('common.save') }}
        </OyaButton>
      </div>
    </template>
  </OyaModal>
</template>
