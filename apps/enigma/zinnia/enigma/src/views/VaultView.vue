<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useVaultStore } from "../stores/vault";
import type { VaultFile } from "../services/api";

defineProps<{ darkMode: boolean }>();

const store = useVaultStore();
const { files, loading, uploading, error, metrics, metricsLoading } = storeToRefs(store);

type Tab = "files" | "metrics";
const tab = ref<Tab>("files");
type ViewMode = "grid" | "tree";
const viewMode = ref<ViewMode>("tree");

const search = ref("");
const selectedBucket = ref<string | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploadTargetBucket = ref<string | null>(null);

onMounted(() => store.fetchFiles());

watch(tab, (t) => { if (t === "metrics" && !metrics.value) store.fetchMetrics(); });

// ── Buckets ───────────────────────────────────────────────────────────────────
const allBuckets = computed(() => {
  const seen = new Map<string, number>();
  for (const f of files.value) {
    const slug = f.bucket_slug ?? "personal";
    seen.set(slug, (seen.get(slug) ?? 0) + 1);
  }
  return [...seen.entries()].map(([slug, count]) => ({ slug, count }));
});

// ── File icons ────────────────────────────────────────────────────────────────
const FILE_ICONS: Record<string, string> = {
  pdf: "file-pdf", image: "image", audio: "music", video: "film",
  text: "file-lines", json: "code", yaml: "code", csv: "table",
  html: "file-code", xml: "file-code", svg: "object-group",
  latex: "file-lines", bib: "book", default: "file",
};
const FILE_TYPE_COLORS: Record<string, string> = {
  pdf: "text-red-400", image: "text-pink-400", audio: "text-purple-400",
  video: "text-orange-400", text: "text-blue-400", json: "text-green-400",
  yaml: "text-green-400", csv: "text-teal-400", html: "text-amber-400",
  default: "text-gray-400",
};
const FILE_TYPE_LABELS: Record<string, string> = {
  pdf: "PDF", image: "Image", html: "HTML", text: "Text", json: "JSON",
  yaml: "YAML", xml: "XML", latex: "LaTeX", bib: "BibTeX", csv: "CSV",
  svg: "SVG", audio: "Audio", video: "Video", default: "File",
};
function fileIcon(type: string) { return FILE_ICONS[type] ?? FILE_ICONS.default; }
function fileColor(type: string) { return FILE_TYPE_COLORS[type] ?? FILE_TYPE_COLORS.default; }
function fileLabel(type: string) { return FILE_TYPE_LABELS[type] ?? type.toUpperCase(); }

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Upload ────────────────────────────────────────────────────────────────────
function triggerPick(bucketSlug?: string) {
  uploadTargetBucket.value = bucketSlug ?? null;
  fileInputRef.value?.click();
}
async function onFileSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await store.upload(file, file.name, uploadTargetBucket.value ?? undefined);
  uploadTargetBucket.value = null;
  if (fileInputRef.value) fileInputRef.value.value = "";
}

// ── Filtered files ────────────────────────────────────────────────────────────
const filteredFiles = computed(() => {
  const q = search.value.trim().toLowerCase();
  return files.value.filter((f) => {
    if (selectedBucket.value && (f.bucket_slug ?? "personal") !== selectedBucket.value) return false;
    if (q && !f.title.toLowerCase().includes(q)) return false;
    return true;
  });
});

// ── Tree view: group by bucket ────────────────────────────────────────────────
const bucketGroups = computed(() => {
  const map = new Map<string, { label: string; files: VaultFile[] }>();
  for (const f of filteredFiles.value) {
    const slug = f.bucket_slug ?? "personal";
    if (!map.has(slug)) map.set(slug, { label: slug, files: [] });
    map.get(slug)!.files.push(f);
  }
  return [...map.entries()].map(([slug, g]) => ({ slug, label: g.label, files: g.files }));
});
const expandedBuckets = ref<Set<string>>(new Set());
function toggleBucket(slug: string) {
  if (expandedBuckets.value.has(slug)) expandedBuckets.value.delete(slug);
  else expandedBuckets.value.add(slug);
}
// auto-expand all buckets on first load
watch(bucketGroups, (groups) => {
  for (const g of groups) expandedBuckets.value.add(g.slug);
}, { immediate: true });

// ── Rename ────────────────────────────────────────────────────────────────────
const renamingKey = ref<string | null>(null);
const renameValue = ref("");
function startRename(f: VaultFile) {
  renamingKey.value = f.key;
  renameValue.value = f.title;
}
async function submitRename(key: string) {
  if (!renameValue.value.trim()) { renamingKey.value = null; return; }
  await store.rename(key, renameValue.value.trim());
  renamingKey.value = null;
}

// ── Delete ────────────────────────────────────────────────────────────────────
const confirmDeleteKey = ref<string | null>(null);
async function del(key: string) {
  await store.remove(key);
  confirmDeleteKey.value = null;
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────
type CryptoAction = { key: string; mode: "encrypt" | "decrypt" };
const cryptoModal = ref<CryptoAction | null>(null);
const cryptoPassword = ref("");
const cryptoError = ref("");
const cryptoBusy = ref(false);

function openCrypto(f: VaultFile) {
  cryptoModal.value = { key: f.key, mode: f.is_encrypted ? "decrypt" : "encrypt" };
  cryptoPassword.value = "";
  cryptoError.value = "";
}
async function submitCrypto() {
  if (!cryptoModal.value || !cryptoPassword.value.trim()) return;
  cryptoBusy.value = true;
  cryptoError.value = "";
  try {
    if (cryptoModal.value.mode === "encrypt") {
      await store.encrypt(cryptoModal.value.key, cryptoPassword.value);
    } else {
      await store.decrypt(cryptoModal.value.key, cryptoPassword.value);
    }
    cryptoModal.value = null;
  } catch (e: any) {
    cryptoError.value = e.message ?? "Operation failed";
  } finally {
    cryptoBusy.value = false;
  }
}

// ── Metrics helpers ───────────────────────────────────────────────────────────
function metricSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function maxCount(arr: { count: number }[]) {
  return arr.length ? Math.max(...arr.map((x) => x.count), 1) : 1;
}
function sparkPoints(data: number[]) {
  if (data.length < 2) return "";
  const max = Math.max(...data, 1);
  return data
    .map((v, i) => `${(i / (data.length - 1)) * 100},${40 - (v / max) * 38}`)
    .join(" ");
}
</script>

<template>
  <div class="flex w-full flex-col gap-3" style="min-height:calc(100vh - 9rem)">

    <!-- Hidden file input -->
    <input ref="fileInputRef" type="file" class="hidden" @change="onFileSelected" />

    <!-- ── Header ────────────────────────────────────────────────────────────── -->
    <div class="flex items-center justify-between gap-3 shrink-0 flex-wrap">
      <div class="flex items-center gap-2">
        <font-awesome-icon icon="hard-drive" class="opacity-60" />
        <h2 class="text-xl font-bold">Storage</h2>
      </div>
      <div class="flex items-center gap-2">
        <!-- view toggle (only in files tab) -->
        <template v-if="tab === 'files'">
          <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="flex rounded-lg border overflow-hidden shrink-0">
            <button @click="viewMode = 'tree'"
              :class="viewMode === 'tree' ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light') : 'opacity-50 hover:opacity-100'"
              class="px-3 py-1.5 text-xs font-semibold transition flex items-center gap-1">
              <font-awesome-icon icon="list" /> Tree
            </button>
            <button @click="viewMode = 'grid'"
              :class="viewMode === 'grid' ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light') : 'opacity-50 hover:opacity-100'"
              class="px-3 py-1.5 text-xs font-semibold transition flex items-center gap-1">
              <font-awesome-icon icon="table-cells" /> Grid
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- ── Tab bar ────────────────────────────────────────────────────────────── -->
    <div class="flex gap-1 shrink-0">
      <button v-for="[key, icon, label] in [['files','hard-drive','Files'],['metrics','chart-bar','Metrics']] as any"
        :key="key" @click="tab = key"
        :class="[
          'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border transition',
          tab === key
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'
        ]">
        <font-awesome-icon :icon="icon" />{{ label }}
      </button>
    </div>

    <div v-if="error" class="shrink-0 rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ error }}</div>

    <!-- ══════════════════════════ FILES TAB ══════════════════════════════════ -->
    <template v-if="tab === 'files'">
      <!-- Bucket filter chips -->
      <div v-if="allBuckets.length > 1" class="flex flex-wrap items-center gap-2 shrink-0">
        <button @click="selectedBucket = null"
          :class="selectedBucket === null
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'"
          class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold transition">
          <font-awesome-icon icon="folder-open" class="text-[10px]" />
          All buckets
          <span class="opacity-60">({{ files.length }})</span>
        </button>
        <button v-for="b in allBuckets" :key="b.slug"
          @click="selectedBucket = b.slug"
          :class="selectedBucket === b.slug
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'"
          class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold transition">
          <font-awesome-icon icon="folder" class="text-[10px]" />
          {{ b.slug }}
          <span class="opacity-60">({{ b.count }})</span>
        </button>
      </div>

      <!-- Search -->
      <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="flex items-center gap-2 rounded-xl border px-3 py-2 shrink-0">
        <font-awesome-icon icon="magnifying-glass" class="opacity-40 text-xs" />
        <input v-model="search" type="text" placeholder="Search files…"
          :class="darkMode ? 'text-text-main-dark' : 'text-text-main-light'"
          class="flex-1 bg-transparent text-sm outline-none placeholder:opacity-40" />
        <button v-if="search" @click="search = ''" class="opacity-40 hover:opacity-80 transition text-xs">
          <font-awesome-icon icon="xmark" />
        </button>
      </div>

      <div v-if="loading" class="flex flex-1 items-center justify-center opacity-50">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>

      <div v-else-if="filteredFiles.length === 0" class="flex flex-1 flex-col items-center justify-center opacity-40 gap-3 py-16">
        <font-awesome-icon icon="folder-open" class="text-4xl" />
        <p class="text-sm">{{ search ? 'No files match your search' : 'No files yet. Upload something!' }}</p>
      </div>

      <!-- ── TREE VIEW ──────────────────────────────────────────────────────── -->
      <template v-else-if="viewMode === 'tree'">
        <div class="flex-1 overflow-y-auto space-y-2">
          <div v-for="group in bucketGroups" :key="group.slug"
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border shadow-sm overflow-hidden">
            <!-- Bucket header row -->
            <div class="flex w-full items-center gap-2.5 px-4 py-3">
              <button @click="toggleBucket(group.slug)"
                class="flex flex-1 items-center gap-2.5 text-left transition hover:opacity-80 min-w-0">
                <font-awesome-icon
                  :icon="expandedBuckets.has(group.slug) ? 'chevron-down' : 'chevron-right'"
                  class="text-xs opacity-50 w-3 shrink-0" />
                <font-awesome-icon
                  :icon="expandedBuckets.has(group.slug) ? 'folder-open' : 'folder'"
                  :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                  class="text-sm shrink-0" />
                <span class="text-sm font-bold truncate">{{ group.label }}</span>
                <span class="text-xs opacity-40 shrink-0">{{ group.files.length }} file{{ group.files.length !== 1 ? 's' : '' }}</span>
              </button>
              <button @click.stop="triggerPick(group.slug)" :disabled="uploading"
                class="shrink-0 rounded border border-current/20 px-2 py-0.5 text-xs opacity-50 hover:opacity-100 transition disabled:opacity-30"
                title="Upload to this folder">
                <font-awesome-icon :icon="uploading && uploadTargetBucket === group.slug ? 'spinner' : 'upload'"
                  :spin="uploading && uploadTargetBucket === group.slug" />
              </button>
            </div>

            <!-- File rows -->
            <div v-if="expandedBuckets.has(group.slug)" class="border-t border-current/10">
              <div v-for="f in group.files" :key="f.key"
                :class="darkMode ? 'border-accent-1/30 hover:bg-white/3' : 'border-accent-2/30 hover:bg-black/3'"
                class="flex items-center gap-3 border-b px-4 py-2.5 text-xs transition last:border-0">

                <!-- File icon -->
                <font-awesome-icon :icon="fileIcon(f.file_type)" :class="fileColor(f.file_type)" class="text-sm shrink-0 w-4" />

                <!-- Name (rename inline) -->
                <div class="flex-1 min-w-0">
                  <template v-if="renamingKey === f.key">
                    <input v-model="renameValue"
                      @keydown.enter="submitRename(f.key)"
                      @keydown.escape="renamingKey = null"
                      @blur="submitRename(f.key)"
                      :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
                      class="w-full rounded border px-2 py-0.5 text-xs outline-none"
                      autofocus />
                  </template>
                  <span v-else class="font-semibold truncate block" :title="f.title">{{ f.title }}</span>
                </div>

                <!-- Type badge -->
                <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                  class="shrink-0 rounded border px-1.5 py-0.5 uppercase tracking-wide text-[10px] opacity-60">
                  {{ fileLabel(f.file_type) }}
                </span>

                <!-- Encrypt badge -->
                <font-awesome-icon v-if="f.is_encrypted" icon="lock" class="shrink-0 text-yellow-400 text-xs" title="Encrypted" />

                <!-- Size + date -->
                <span class="shrink-0 opacity-40 hidden sm:block">{{ formatSize(f.file_size_bytes) }}</span>
                <span class="shrink-0 opacity-40 hidden md:block">{{ formatDate(f.uploaded_at) }}</span>

                <!-- Actions -->
                <div class="flex items-center gap-1 shrink-0">
                  <!-- Download -->
                  <a v-if="f.download_url" :href="f.download_url" target="_blank" rel="noopener"
                    class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:opacity-100 transition" title="Download">
                    <font-awesome-icon icon="download" />
                  </a>
                  <!-- Rename -->
                  <button @click="startRename(f)"
                    class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:opacity-100 transition" title="Rename">
                    <font-awesome-icon icon="pencil" />
                  </button>
                  <!-- Encrypt/Decrypt -->
                  <button @click="openCrypto(f)"
                    :class="f.is_encrypted ? 'text-yellow-400 border-yellow-400/30' : 'border-current/15'"
                    class="rounded border px-1.5 py-0.5 opacity-60 hover:opacity-100 transition"
                    :title="f.is_encrypted ? 'Decrypt' : 'Encrypt'">
                    <font-awesome-icon :icon="f.is_encrypted ? 'lock-open' : 'lock'" />
                  </button>
                  <!-- Delete -->
                  <template v-if="confirmDeleteKey !== f.key">
                    <button @click="confirmDeleteKey = f.key"
                      class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:text-red-400 hover:opacity-100 transition" title="Delete">
                      <font-awesome-icon icon="trash" />
                    </button>
                  </template>
                  <template v-else>
                    <button @click="del(f.key)" class="rounded bg-red-500 px-2 py-0.5 text-white font-bold text-xs">Yes</button>
                    <button @click="confirmDeleteKey = null" class="rounded border border-current/20 px-1.5 py-0.5 opacity-60 hover:opacity-100 transition text-xs">✕</button>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ── GRID VIEW ──────────────────────────────────────────────────────── -->
      <div v-else class="flex-1 overflow-y-auto">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          <div v-for="f in filteredFiles" :key="f.key"
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="relative flex flex-col gap-2 rounded-xl border p-3 shadow-sm">
            <!-- Icon -->
            <div class="flex items-center justify-center h-12 opacity-60">
              <font-awesome-icon :icon="fileIcon(f.file_type)" :class="fileColor(f.file_type)" class="text-3xl" />
            </div>
            <!-- Encrypt badge -->
            <div v-if="f.is_encrypted" class="absolute top-2 right-2">
              <font-awesome-icon icon="lock" class="text-xs text-yellow-400" />
            </div>
            <!-- Name -->
            <template v-if="renamingKey === f.key">
              <input v-model="renameValue"
                @keydown.enter="submitRename(f.key)"
                @keydown.escape="renamingKey = null"
                @blur="submitRename(f.key)"
                :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded border px-2 py-0.5 text-xs outline-none"
                autofocus />
            </template>
            <p v-else class="truncate text-xs font-semibold" :title="f.title">{{ f.title }}</p>
            <p class="text-xs opacity-40">{{ formatSize(f.file_size_bytes) }} · {{ formatDate(f.uploaded_at) }}</p>
            <!-- Actions -->
            <div class="flex gap-1 mt-auto flex-wrap">
              <a v-if="f.download_url" :href="f.download_url" target="_blank" rel="noopener"
                class="rounded-lg border border-current/20 px-2 py-1 text-xs transition hover:opacity-80" title="Download">
                <font-awesome-icon icon="download" />
              </a>
              <button @click="startRename(f)"
                class="rounded-lg border border-current/20 px-2 py-1 text-xs opacity-60 hover:opacity-100 transition" title="Rename">
                <font-awesome-icon icon="pencil" />
              </button>
              <button @click="openCrypto(f)"
                :class="f.is_encrypted ? 'text-yellow-400' : ''"
                class="rounded-lg border border-current/20 px-2 py-1 text-xs opacity-60 hover:opacity-100 transition"
                :title="f.is_encrypted ? 'Decrypt' : 'Encrypt'">
                <font-awesome-icon :icon="f.is_encrypted ? 'lock-open' : 'lock'" />
              </button>
              <template v-if="confirmDeleteKey !== f.key">
                <button @click="confirmDeleteKey = f.key"
                  class="rounded-lg border border-current/20 px-2 py-1 text-xs opacity-60 hover:text-red-400 hover:opacity-100 transition" title="Delete">
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

    <!-- ══════════════════════════ METRICS TAB ════════════════════════════════ -->
    <template v-else-if="tab === 'metrics'">
      <div v-if="metricsLoading" class="flex flex-1 items-center justify-center opacity-50">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>
      <div v-else-if="metrics" class="flex-1 overflow-y-auto space-y-4">

        <!-- Stat cards row -->
        <div class="grid grid-cols-3 gap-3 lg:grid-cols-6">
          <div v-for="[label, val, icon] in [
            ['Total Files', metrics.total_files, 'file'],
            ['Public', metrics.public_files, 'eye'],
            ['Encrypted', metrics.encrypted_files, 'lock'],
            ['Last 7 days', metrics.recent_count, 'rotate-right'],
            ['Storage', metricSize(metrics.total_size_bytes), 'hard-drive'],
            ['Buckets', metrics.bucket_stats.length, 'folder'],
          ] as any" :key="label"
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border p-3 shadow-sm">
            <div class="flex items-center gap-1.5 text-xs opacity-50 mb-1">
              <font-awesome-icon :icon="icon" />
              <span class="uppercase tracking-wide">{{ label }}</span>
            </div>
            <p class="text-2xl font-bold">{{ val }}</p>
          </div>
        </div>

        <!-- Charts row -->
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">

          <!-- Files by type -->
          <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border p-4 shadow-md">
            <h4 class="text-xs font-bold opacity-60 mb-4 flex items-center gap-1.5 uppercase tracking-wide">
              <font-awesome-icon icon="file" /> Files by type
            </h4>
            <div v-if="metrics.files_by_type.length" class="space-y-2.5">
              <div v-for="t in metrics.files_by_type" :key="t.file_type">
                <div class="flex justify-between text-xs opacity-60 mb-0.5">
                  <span class="uppercase font-semibold" :class="fileColor(t.file_type)">{{ t.file_type }}</span>
                  <span>{{ t.count }}</span>
                </div>
                <div :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'" class="h-2.5 rounded overflow-hidden">
                  <div :class="darkMode ? 'bg-accent-dark' : 'bg-accent-light'" class="h-full rounded transition-all"
                    :style="`width:${Math.round((t.count / maxCount(metrics.files_by_type)) * 100)}%`"></div>
                </div>
              </div>
            </div>
            <p v-else class="text-xs opacity-30">No data</p>
          </div>

          <!-- Upload activity -->
          <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border p-4 shadow-md">
            <h4 class="text-xs font-bold opacity-60 mb-4 flex items-center gap-1.5 uppercase tracking-wide">
              <font-awesome-icon icon="chart-line" /> Uploads (30 days)
            </h4>
            <div class="relative h-28">
              <svg class="w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 40">
                <polyline
                  :points="sparkPoints(metrics.daily_series.map((d: any) => d.count))"
                  fill="none"
                  :stroke="darkMode ? '#4f5fa1' : '#2f3d63'"
                  stroke-width="2"
                />
                <circle
                  v-for="(d, i) in metrics.daily_series.filter((_: any, j: number) => j % 5 === 0)" :key="i"
                  :cx="(metrics.daily_series.indexOf(d) / (metrics.daily_series.length - 1)) * 100"
                  :cy="40 - (d.count / Math.max(...metrics.daily_series.map((x: any) => x.count), 1)) * 38"
                  r="1.5"
                  :fill="darkMode ? '#4f5fa1' : '#2f3d63'"
                />
              </svg>
            </div>
            <div class="flex justify-between text-xs opacity-30 mt-1">
              <span>{{ metrics.daily_series[0]?.date }}</span>
              <span>{{ metrics.daily_series[metrics.daily_series.length - 1]?.date }}</span>
            </div>
          </div>
        </div>

        <!-- Bucket breakdown table -->
        <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border shadow-md overflow-hidden">
          <div class="border-b border-current/10 px-4 py-3 flex items-center gap-2">
            <font-awesome-icon icon="folder" class="opacity-60" />
            <h3 class="text-sm font-bold">Bucket breakdown</h3>
          </div>
          <div v-if="metrics.bucket_stats.length" class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                  class="border-b uppercase tracking-wide opacity-50">
                  <th class="px-4 py-2.5 text-left">Bucket</th>
                  <th class="px-4 py-2.5 text-right">Files</th>
                  <th class="px-4 py-2.5 text-right">Public</th>
                  <th class="px-4 py-2.5 text-right">Encrypted</th>
                  <th class="px-4 py-2.5 text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in metrics.bucket_stats" :key="b.slug"
                  :class="darkMode ? 'border-accent-1/40 hover:bg-white/3' : 'border-accent-2/40 hover:bg-black/3'"
                  class="border-b transition last:border-0">
                  <td class="px-4 py-3 font-semibold flex items-center gap-2">
                    <font-awesome-icon icon="folder" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
                    {{ b.name }}
                  </td>
                  <td class="px-4 py-3 text-right">{{ b.file_count }}</td>
                  <td class="px-4 py-3 text-right">
                    <span :class="b.public_count > 0 ? 'text-sky-400' : 'opacity-30'">{{ b.public_count }}</span>
                  </td>
                  <td class="px-4 py-3 text-right">
                    <span :class="b.encrypted_count > 0 ? 'text-yellow-400' : 'opacity-30'">{{ b.encrypted_count }}</span>
                  </td>
                  <td class="px-4 py-3 text-right opacity-60">{{ metricSize(b.total_size) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="px-4 py-6 text-xs opacity-30 text-center">No buckets</p>
        </div>

      </div>
      <div v-else class="flex-1 flex items-center justify-center opacity-40 text-xs">No metrics data</div>
    </template>

    <!-- ══════════════════════ ENCRYPT / DECRYPT MODAL ════════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="cryptoModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        :class="darkMode ? 'bg-black/60' : 'bg-black/30'"
        @click.self="cryptoModal = null">
        <div :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark [color-scheme:dark]' : 'bg-primary-bg-light border-accent-2 text-text-main-light [color-scheme:light]'"
          class="w-full max-w-sm rounded-xl border shadow-2xl overflow-hidden">
          <div class="flex items-center justify-between border-b border-current/10 px-5 py-3">
            <h3 class="text-sm font-bold flex items-center gap-2">
              <font-awesome-icon :icon="cryptoModal.mode === 'encrypt' ? 'lock' : 'lock-open'" />
              {{ cryptoModal.mode === 'encrypt' ? 'Encrypt file' : 'Decrypt file' }}
            </h3>
            <button @click="cryptoModal = null" class="opacity-50 hover:opacity-100 transition">
              <font-awesome-icon icon="xmark" />
            </button>
          </div>
          <div class="p-5 space-y-4">
            <div>
              <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Password</label>
              <input v-model="cryptoPassword" type="password" placeholder="Enter password…"
                @keydown.enter="submitCrypto"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                autofocus />
            </div>
            <p v-if="cryptoError" class="text-xs text-red-400">{{ cryptoError }}</p>
            <p v-if="cryptoModal.mode === 'encrypt'" class="text-xs opacity-40">
              File will be encrypted and made private.
            </p>
          </div>
          <div class="flex justify-end gap-2 border-t border-current/10 px-5 py-3">
            <button @click="cryptoModal = null"
              class="rounded-lg border border-current/20 px-3 py-1.5 text-xs transition hover:opacity-80">Cancel</button>
            <button @click="submitCrypto" :disabled="cryptoBusy || !cryptoPassword"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="rounded-lg px-4 py-1.5 text-xs font-bold transition disabled:opacity-50">
              {{ cryptoBusy ? 'Working…' : (cryptoModal.mode === 'encrypt' ? 'Encrypt' : 'Decrypt') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>
