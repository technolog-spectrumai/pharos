<script setup lang="ts">
import { ref, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useVaultStore } from "../stores/vault";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

defineProps<{ darkMode: boolean }>();

const store = useVaultStore();
const { files, loading, uploading, error } = storeToRefs(store);

const confirmDeleteKey = ref<string | null>(null);

onMounted(() => store.fetchFiles());

const FILE_ICONS: Record<string, string> = {
  pdf: "file-pdf",
  image: "image",
  audio: "music",
  video: "film",
  text: "file-lines",
  json: "code",
  yaml: "code",
  csv: "table",
  html: "file-code",
  xml: "file-code",
  svg: "vector-square",
  latex: "file-lines",
  bib: "book",
  default: "file",
};

function fileIcon(type: string) {
  return FILE_ICONS[type] ?? FILE_ICONS.default;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function pickAndUpload() {
  try {
    const selected = await open({ multiple: false, directory: false });
    if (!selected || typeof selected !== "string") return;

    const parts = selected.split(/[\\/]/);
    const fileName = parts[parts.length - 1];
    const fileBytes = await readFile(selected);
    const blob = new Blob([fileBytes]);
    const file = new File([blob], fileName);
    await store.upload(file, fileName);
  } catch (e: any) {
    // User cancelled or error — store already sets error
  }
}

async function del(key: string) {
  await store.remove(key);
  confirmDeleteKey.value = null;
}
</script>

<template>
  <div class="flex w-full flex-col gap-4">

    <!-- Header -->
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-bold">Storage</h2>
      <button
        @click="pickAndUpload"
        :disabled="uploading"
        :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
        class="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold shadow transition hover:opacity-90 disabled:opacity-50"
      >
        <font-awesome-icon :icon="uploading ? 'spinner' : 'upload'" :spin="uploading" />
        {{ uploading ? "Uploading…" : "Upload file" }}
      </button>
    </div>

    <div v-if="error" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ error }}</div>

    <!-- File grid -->
    <div v-if="loading" class="flex items-center justify-center py-16 opacity-50">
      <font-awesome-icon icon="spinner" spin class="text-2xl" />
    </div>

    <div v-else-if="files.length === 0" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
      <font-awesome-icon icon="folder-open" class="text-4xl" />
      <p class="text-sm">No files yet. Upload something!</p>
    </div>

    <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      <div
        v-for="f in files"
        :key="f.key"
        :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="relative flex flex-col gap-2 rounded-xl border p-3 shadow-sm"
      >
        <!-- Icon -->
        <div class="flex items-center justify-center h-12 opacity-60">
          <font-awesome-icon :icon="fileIcon(f.file_type)" class="text-3xl" />
        </div>

        <!-- Info -->
        <p class="truncate text-xs font-semibold" :title="f.title">{{ f.title }}</p>
        <p class="text-xs opacity-40">{{ formatSize(f.file_size_bytes) }} · {{ formatDate(f.uploaded_at) }}</p>

        <!-- Actions -->
        <div class="flex gap-1 mt-auto">
          <a
            v-if="f.download_url"
            :href="f.download_url"
            target="_blank"
            rel="noopener"
            class="flex-1 rounded-lg border border-current/20 py-1 text-center text-xs transition hover:opacity-80"
            title="Download"
          >
            <font-awesome-icon icon="download" />
          </a>
          <template v-if="confirmDeleteKey !== f.key">
            <button
              @click="confirmDeleteKey = f.key"
              class="rounded-lg border border-current/20 px-2 py-1 text-xs opacity-60 transition hover:opacity-100"
              title="Delete"
            >
              <font-awesome-icon icon="trash" />
            </button>
          </template>
          <template v-else>
            <button @click="del(f.key)" class="rounded-lg bg-red-500 px-2 py-1 text-xs text-white font-bold">Del</button>
            <button @click="confirmDeleteKey = null" class="rounded-lg border border-current/20 px-2 py-1 text-xs transition hover:opacity-80">✕</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
