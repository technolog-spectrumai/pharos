<script setup lang="ts">
// The platform vault: sign in, list your files, open one into the editor.
// Read-only toward the vault itself — writing happens through the editor
// host's save path, which PUTs back through the content API.
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import OyaButton from "../components/OyaButton.vue";
import OyaTextField from "../components/OyaTextField.vue";
import { useSessionStore } from "../stores/session";
import { getContent, listFiles, type VaultFileDto } from "../api/vault";
import { ApiFailure } from "../api/errors";

const emit = defineEmits<{
  /** A vault file, fetched and ready for an editor. */
  "open-file": [{ key: string; name: string; content: string }];
}>();

const { t } = useI18n({ useScope: "global" });
const session = useSessionStore();
const { serverUrl, loggedIn, username, busy, error } = storeToRefs(session);

// ── login form ──────────────────────────────────────────────────────────────
const formUser = ref("");
const formPass = ref("");

async function submit() {
  if (await session.login(formUser.value.trim(), formPass.value)) {
    formPass.value = "";
    await refresh();
  }
}

// ── the listing ─────────────────────────────────────────────────────────────
const files = ref<VaultFileDto[]>([]);
const listError = ref("");
const loading = ref(false);
const opening = ref<string | null>(null);

async function refresh() {
  if (!loggedIn.value) return;
  loading.value = true;
  listError.value = "";
  try {
    files.value = await listFiles(session.client);
  } catch (e) {
    if (!session.authFailed(e)) {
      listError.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    loading.value = false;
  }
}

async function openFile(f: VaultFileDto) {
  if (opening.value) return;
  opening.value = f.key;
  listError.value = "";
  try {
    const res = await getContent(session.client, f.key);
    emit("open-file", { key: f.key, name: f.title, content: res.content });
  } catch (e) {
    if (!session.authFailed(e)) {
      const detail = e instanceof ApiFailure ? e.message : String(e);
      listError.value = `${t("vault.openFailed")} ${detail}`;
    }
  } finally {
    opening.value = null;
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(() => { void refresh(); });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Signed out: server + credentials. -->
    <form v-if="!loggedIn" class="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-3 p-6"
          @submit.prevent="submit">
      <p class="text-lg font-semibold">{{ t("vault.signIn") }}</p>
      <label class="text-xs opacity-70">{{ t("vault.server") }}</label>
      <OyaTextField v-model="serverUrl" mono placeholder="http://localhost:8000" />
      <label class="text-xs opacity-70">{{ t("vault.username") }}</label>
      <OyaTextField v-model="formUser" data-testid="vault-user" />
      <label class="text-xs opacity-70">{{ t("vault.password") }}</label>
      <OyaTextField v-model="formPass" type="password" data-testid="vault-pass" @enter="submit" />
      <p v-if="error" class="text-sm text-warn-dark" data-testid="vault-error">{{ error }}</p>
      <OyaButton type="submit" :disabled="busy">{{ t("vault.signIn") }}</OyaButton>
    </form>

    <!-- Signed in: the listing. -->
    <template v-else>
      <div class="flex items-center gap-2 border-b border-current/10 px-3 py-2">
        <p class="min-w-0 flex-1 truncate text-sm">
          <span class="font-semibold">{{ username }}</span>
          <span class="opacity-50"> @ {{ serverUrl }}</span>
        </p>
        <OyaButton variant="secondary" :disabled="loading" @click="refresh">
          {{ t("vault.refresh") }}
        </OyaButton>
        <OyaButton variant="secondary" @click="session.logout()">{{ t("vault.signOut") }}</OyaButton>
      </div>

      <p v-if="listError" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
        {{ listError }}
      </p>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <p v-if="loading" class="p-6 text-center text-sm opacity-60">{{ t("common.loading") }}</p>
        <p v-else-if="files.length === 0" class="p-6 text-center text-sm opacity-60">
          {{ t("vault.empty") }}
        </p>
        <table v-else class="w-full text-left text-sm">
          <tbody>
            <tr v-for="f in files" :key="f.id"
                class="border-b border-current/5 transition"
                :class="f.is_editable ? 'cursor-pointer hover:bg-bubble-bg-light dark:hover:bg-bubble-bg-dark' : 'opacity-45'"
                :data-testid="`vault-row-${f.id}`"
                @click="f.is_editable && openFile(f)">
              <td class="px-3 py-2">
                <font-awesome-icon
                  :icon="opening === f.key ? 'spinner' : f.file_type === 'svg' ? 'file-image' : 'file'"
                  :spin="opening === f.key" class="mr-2 opacity-60" />
                <span class="font-medium">{{ f.title }}</span>
              </td>
              <td class="px-3 py-2 font-mono text-xs opacity-60">{{ f.file_type }}</td>
              <td class="px-3 py-2 text-xs opacity-60">{{ fmtSize(f.file_size_bytes) }}</td>
              <td class="px-3 py-2 text-right text-xs opacity-40">
                {{ f.is_editable ? "" : t("vault.notEditable") }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
