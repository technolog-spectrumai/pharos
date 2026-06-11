<script setup lang="ts">
import { computed, watch } from "vue";
import { storeToRefs } from "pinia";
import { useVaultStore } from "../stores/vault";
import type { VaultFile } from "../services/api";

const props = defineProps<{ darkMode: boolean; open: boolean }>();
const emit = defineEmits<{ (e: "close"): void; (e: "insert", file: VaultFile): void }>();

const vault = useVaultStore();
const { files, loading, error } = storeToRefs(vault);

// Only image files can be inserted into the chat.
const images = computed(() => files.value.filter((f) => f.file_type === "image" && f.download_url));

watch(() => props.open, (o) => { if (o) vault.fetchFiles(); });
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4"
    @click.self="emit('close')"
  >
    <div
      :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
      class="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border p-4 shadow-xl"
    >
      <div class="flex items-center justify-between border-b border-current/10 pb-3">
        <h2 class="flex items-center gap-2 text-sm font-bold">
          <font-awesome-icon icon="hard-drive" />{{ $t('chat.vaultInsert') }}
        </h2>
        <button type="button" class="opacity-70 hover:opacity-100" @click="emit('close')">
          <font-awesome-icon icon="xmark" />
        </button>
      </div>

      <p v-if="error" class="mt-3 text-xs text-warn-dark">{{ error }}</p>
      <p v-else-if="loading" class="mt-6 text-center text-xs opacity-50">{{ $t('common.loading') }}</p>

      <div v-else class="mt-3 grid grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
        <button
          v-for="f in images"
          :key="f.key"
          type="button"
          class="overflow-hidden rounded-lg border border-current/15 text-left transition hover:opacity-80"
          :title="f.title"
          @click="emit('insert', f); emit('close')"
        >
          <img :src="f.download_url ?? ''" :alt="f.title" class="h-24 w-full object-cover" />
          <span class="block truncate px-1.5 py-1 text-[10px]">{{ f.title }}</span>
        </button>

        <p v-if="!images.length" class="col-span-full py-10 text-center text-xs opacity-50">
          {{ $t('chat.vaultNoImages') }}
        </p>
      </div>
    </div>
  </div>
</template>
