<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import { useVaultStore } from "../stores/vault";
import type { VaultFile, VaultDirectory } from "../services/api";

// Ace editor — bundled (not loaded from a CDN) so it works offline in the
// Tauri desktop build. Mode/theme imports register themselves on the core.
import ace from "ace-builds/src-noconflict/ace";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/mode-yaml";
import "ace-builds/src-noconflict/mode-xml";
import "ace-builds/src-noconflict/mode-latex";
import "ace-builds/src-noconflict/mode-python";
import "ace-builds/src-noconflict/mode-html";
import "ace-builds/src-noconflict/theme-monokai";
import "ace-builds/src-noconflict/theme-chrome";

// No web-workers: avoids bundler worker-URL resolution and keeps it offline.
ace.config.set("useWorker", false);

const props = defineProps<{ darkMode: boolean }>();

const store = useVaultStore();
const { files, buckets, loading, uploading, error, metrics, metricsLoading } = storeToRefs(store);

type Tab = "files" | "metrics";
const tab = ref<Tab>("files");
type ViewMode = "grid" | "tree";
const viewMode = ref<ViewMode>("tree");

const search = ref("");
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploadTargetBucket = ref<string | null>(null);

onMounted(() => store.fetchFiles());

watch(tab, (t) => { if (t === "metrics" && !metrics.value) store.fetchMetrics(); });

// ── File icons ────────────────────────────────────────────────────────────────
const FILE_ICONS: Record<string, string> = {
  pdf: "file-pdf", image: "image", audio: "music", video: "film",
  text: "file-lines", json: "code", yaml: "code", csv: "table",
  html: "file-code", xml: "file-code", svg: "object-group",
  latex: "file-lines", bib: "book", python: "file-code", notebook: "file-lines",
  default: "file",
};
const FILE_TYPE_COLORS: Record<string, string> = {
  pdf: "text-red-400", image: "text-pink-400", audio: "text-purple-400",
  video: "text-orange-400", text: "text-blue-400", json: "text-green-400",
  yaml: "text-green-400", csv: "text-teal-400", html: "text-amber-400",
  python: "text-yellow-400", svg: "text-fuchsia-400", default: "text-gray-400",
};
const FILE_TYPE_LABELS: Record<string, string> = {
  pdf: "PDF", image: "Image", html: "HTML", text: "Text", json: "JSON",
  yaml: "YAML", xml: "XML", latex: "LaTeX", bib: "BibTeX", csv: "CSV",
  svg: "SVG", audio: "Audio", video: "Video", python: "Python", notebook: "Notebook",
  default: "File",
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

// ── Search (flat results, bypasses folders) ────────────────────────────────────
const searching = computed(() => search.value.trim().length > 0);
const searchResults = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return [];
  return files.value.filter((f) => f.title.toLowerCase().includes(q));
});

// ── Folder forest: bucket → nested directories → files ─────────────────────────
interface DirNode { id: number; name: string; path: string; bucketSlug: string; dirs: DirNode[]; files: VaultFile[]; }
interface BucketNode { slug: string; name: string; dirs: DirNode[]; files: VaultFile[]; fileCount: number; }

const forest = computed<BucketNode[]>(() => {
  const filesByBucket = new Map<string, VaultFile[]>();
  for (const f of files.value) {
    const slug = f.bucket_slug ?? "personal";
    (filesByBucket.get(slug) ?? filesByBucket.set(slug, []).get(slug)!).push(f);
  }

  const bucketMeta = new Map<string, { name: string; dirs: VaultDirectory[] }>();
  for (const b of buckets.value) bucketMeta.set(b.slug, { name: b.name, dirs: b.directories });
  for (const slug of filesByBucket.keys()) if (!bucketMeta.has(slug)) bucketMeta.set(slug, { name: slug, dirs: [] });

  const sortDirs = (arr: DirNode[]) => {
    arr.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of arr) { sortDirs(n.dirs); n.files.sort((a, b) => a.title.localeCompare(b.title)); }
  };

  const out: BucketNode[] = [];
  for (const [slug, meta] of bucketMeta) {
    const bucketFiles = filesByBucket.get(slug) ?? [];
    const nodeById = new Map<number, DirNode>();
    for (const d of meta.dirs) nodeById.set(d.id, { id: d.id, name: d.name, path: d.path, bucketSlug: slug, dirs: [], files: [] });

    const rootDirs: DirNode[] = [];
    for (const d of meta.dirs) {
      const node = nodeById.get(d.id)!;
      if (d.parent_id != null && nodeById.has(d.parent_id)) nodeById.get(d.parent_id)!.dirs.push(node);
      else rootDirs.push(node);
    }

    const rootFiles: VaultFile[] = [];
    for (const f of bucketFiles) {
      if (f.directory_id != null && nodeById.has(f.directory_id)) nodeById.get(f.directory_id)!.files.push(f);
      else rootFiles.push(f);
    }

    sortDirs(rootDirs);
    rootFiles.sort((a, b) => a.title.localeCompare(b.title));
    out.push({ slug, name: meta.name, dirs: rootDirs, files: rootFiles, fileCount: bucketFiles.length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});

// ── Tree view: flatten the forest using the expansion set ──────────────────────
const expanded = ref<Set<string>>(new Set());
function toggle(key: string) {
  const next = new Set(expanded.value);
  next.has(key) ? next.delete(key) : next.add(key);
  expanded.value = next;
}
// Auto-expand buckets the first time the forest is populated.
watch(forest, (f) => {
  if (expanded.value.size === 0 && f.length) {
    const next = new Set<string>();
    for (const b of f) next.add(`b:${b.slug}`);
    expanded.value = next;
  }
}, { immediate: true });

interface Row {
  key: string; kind: "bucket" | "dir" | "file"; depth: number;
  label?: string; count?: number; expandable?: boolean; isOpen?: boolean;
  bucketSlug?: string; file?: VaultFile;
}
const treeRows = computed<Row[]>(() => {
  const rows: Row[] = [];
  const pushDir = (d: DirNode, depth: number) => {
    const key = `d:${d.id}`;
    const isOpen = expanded.value.has(key);
    rows.push({ key, kind: "dir", depth, label: d.name, count: d.files.length, expandable: d.dirs.length + d.files.length > 0, isOpen, bucketSlug: d.bucketSlug });
    if (isOpen) {
      for (const c of d.dirs) pushDir(c, depth + 1);
      for (const f of d.files) rows.push({ key: `f:${f.key}`, kind: "file", depth: depth + 1, file: f });
    }
  };
  for (const b of forest.value) {
    const key = `b:${b.slug}`;
    const isOpen = expanded.value.has(key);
    rows.push({ key, kind: "bucket", depth: 0, label: b.name, count: b.fileCount, expandable: b.dirs.length + b.files.length > 0, isOpen, bucketSlug: b.slug });
    if (isOpen) {
      for (const c of b.dirs) pushDir(c, 1);
      for (const f of b.files) rows.push({ key: `f:${f.key}`, kind: "file", depth: 1, file: f });
    }
  }
  return rows;
});

// ── Grid view: folder navigation (cards + breadcrumb) ──────────────────────────
const gridBucket = ref<string | null>(null);
const gridDirId = ref<number | null>(null);

const currentBucketNode = computed(() => forest.value.find((b) => b.slug === gridBucket.value) ?? null);
function findDir(nodes: DirNode[], id: number): DirNode | null {
  for (const n of nodes) { if (n.id === id) return n; const r = findDir(n.dirs, id); if (r) return r; }
  return null;
}
const currentDirNode = computed(() =>
  currentBucketNode.value && gridDirId.value != null ? findDir(currentBucketNode.value.dirs, gridDirId.value) : null);
const gridDirs = computed<DirNode[]>(() =>
  !currentBucketNode.value ? [] : (currentDirNode.value ? currentDirNode.value.dirs : currentBucketNode.value.dirs));
const gridFiles = computed<VaultFile[]>(() =>
  !currentBucketNode.value ? [] : (currentDirNode.value ? currentDirNode.value.files : currentBucketNode.value.files));

function dirChain(nodes: DirNode[], id: number): DirNode[] {
  for (const n of nodes) {
    if (n.id === id) return [n];
    const sub = dirChain(n.dirs, id);
    if (sub.length) return [n, ...sub];
  }
  return [];
}
interface Crumb { label: string; bucket: string | null; dir: number | null; }
const breadcrumb = computed<Crumb[]>(() => {
  const crumbs: Crumb[] = [{ label: "Storage", bucket: null, dir: null }];
  if (currentBucketNode.value) {
    crumbs.push({ label: currentBucketNode.value.name, bucket: currentBucketNode.value.slug, dir: null });
    if (gridDirId.value != null) {
      for (const d of dirChain(currentBucketNode.value.dirs, gridDirId.value))
        crumbs.push({ label: d.name, bucket: currentBucketNode.value.slug, dir: d.id });
    }
  }
  return crumbs;
});
function openBucketCard(slug: string) { gridBucket.value = slug; gridDirId.value = null; }
function openDirCard(id: number) { gridDirId.value = id; }
function gotoCrumb(c: Crumb) { gridBucket.value = c.bucket; gridDirId.value = c.dir; }

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

// ── Ace editor (text-ish files) ────────────────────────────────────────────────
const ACE_MODE: Record<string, string> = {
  text: "text", json: "json", yaml: "yaml", xml: "xml", csv: "text",
  latex: "latex", bib: "latex", python: "python", svg: "xml", html: "html",
};

const editorFile = ref<VaultFile | null>(null);
const editorContent = ref("");
const editorOriginal = ref("");
const editorLoading = ref(false);
const editorSaving = ref(false);
const editorError = ref("");
const editorContainer = ref<HTMLElement | null>(null);
let aceEditor: any = null;
const editorDirty = computed(() => editorContent.value !== editorOriginal.value);

async function openEditor(f: VaultFile) {
  editorFile.value = f;
  editorError.value = "";
  editorContent.value = "";
  editorOriginal.value = "";
  editorLoading.value = true;
  try {
    const data = await store.loadContent(f.key);
    editorContent.value = data.content;
    editorOriginal.value = data.content;
    await nextTick();
    if (!editorContainer.value) return;
    aceEditor = ace.edit(editorContainer.value);
    aceEditor.setTheme(`ace/theme/${props.darkMode ? "monokai" : "chrome"}`);
    aceEditor.session.setMode(`ace/mode/${ACE_MODE[f.file_type] ?? "text"}`);
    aceEditor.setOptions({ fontSize: "13px", showPrintMargin: false, wrap: true, useWorker: false });
    aceEditor.setValue(editorContent.value, -1);
    aceEditor.session.on("change", () => { editorContent.value = aceEditor.getValue(); });
  } catch (e: any) {
    editorError.value = e.message ?? "Failed to open file";
  } finally {
    editorLoading.value = false;
  }
}
async function saveEditor() {
  if (!editorFile.value || !editorDirty.value) return;
  editorSaving.value = true;
  editorError.value = "";
  try {
    await store.saveContent(editorFile.value.key, editorContent.value);
    editorOriginal.value = editorContent.value;
  } catch (e: any) {
    editorError.value = e.message ?? "Save failed";
  } finally {
    editorSaving.value = false;
  }
}
function destroyAce() {
  if (aceEditor) { aceEditor.destroy(); aceEditor = null; }
}
function closeEditor() {
  destroyAce();
  editorFile.value = null;
}
watch(() => props.darkMode, () => {
  if (aceEditor) aceEditor.setTheme(`ace/theme/${props.darkMode ? "monokai" : "chrome"}`);
});
onBeforeUnmount(destroyAce);

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

      <div v-else-if="files.length === 0" class="flex flex-1 flex-col items-center justify-center opacity-40 gap-3 py-16">
        <font-awesome-icon icon="folder-open" class="text-4xl" />
        <p class="text-sm">No files yet. Upload something!</p>
        <button @click="triggerPick()" :disabled="uploading"
          :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
          class="rounded-lg px-4 py-1.5 text-xs font-bold transition hover:opacity-90 disabled:opacity-50">
          <font-awesome-icon :icon="uploading ? 'spinner' : 'upload'" :spin="uploading" /> Upload
        </button>
      </div>

      <!-- ── SEARCH RESULTS (flat, bypasses folders) ────────────────────────── -->
      <template v-else-if="searching">
        <div v-if="searchResults.length === 0" class="flex flex-1 items-center justify-center opacity-40 text-sm py-16">
          No files match “{{ search }}”
        </div>
        <div v-else class="flex-1 overflow-y-auto">
          <p class="text-xs opacity-50 mb-2">{{ searchResults.length }} result{{ searchResults.length !== 1 ? 's' : '' }}</p>
          <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border shadow-sm overflow-hidden">
            <div v-for="f in searchResults" :key="f.key"
              :class="darkMode ? 'border-accent-1/30 hover:bg-white/3' : 'border-accent-2/30 hover:bg-black/3'"
              class="flex items-center gap-3 border-b px-4 py-2.5 text-xs transition last:border-0">
              <font-awesome-icon :icon="fileIcon(f.file_type)" :class="fileColor(f.file_type)" class="text-sm shrink-0 w-4" />
              <span class="flex-1 min-w-0 font-semibold truncate" :title="f.title">{{ f.title }}</span>
              <span class="shrink-0 opacity-40 hidden sm:block">{{ formatSize(f.file_size_bytes) }}</span>
              <div class="flex items-center gap-1 shrink-0">
                <button v-if="f.is_editable" @click="openEditor(f)"
                  class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:opacity-100 transition" title="Edit">
                  <font-awesome-icon icon="code" />
                </button>
                <a v-if="f.download_url" :href="f.download_url" target="_blank" rel="noopener"
                  class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:opacity-100 transition" title="Download">
                  <font-awesome-icon icon="download" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ── TREE VIEW ──────────────────────────────────────────────────────── -->
      <template v-else-if="viewMode === 'tree'">
        <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="flex-1 overflow-y-auto rounded-xl border shadow-sm">
          <div v-for="row in treeRows" :key="row.key"
            :class="darkMode ? 'border-accent-1/20 hover:bg-white/3' : 'border-accent-2/20 hover:bg-black/3'"
            class="flex items-center gap-2 border-b px-3 py-2 text-xs transition last:border-0">

            <span :style="{ width: `${row.depth * 16}px` }" class="shrink-0"></span>

            <!-- BUCKET / DIR row -->
            <template v-if="row.kind !== 'file'">
              <button @click="toggle(row.key)" class="flex flex-1 items-center gap-2 text-left min-w-0 transition hover:opacity-80">
                <font-awesome-icon v-if="row.expandable"
                  :icon="row.isOpen ? 'chevron-down' : 'chevron-right'" class="text-[10px] opacity-50 w-2.5 shrink-0" />
                <span v-else class="w-2.5 shrink-0"></span>
                <font-awesome-icon
                  :icon="row.isOpen ? 'folder-open' : 'folder'"
                  :class="row.kind === 'bucket' ? (darkMode ? 'text-accent-dark' : 'text-accent-light') : 'opacity-60'"
                  class="text-sm shrink-0" />
                <span :class="row.kind === 'bucket' ? 'font-bold' : 'font-semibold'" class="truncate">{{ row.label }}</span>
                <span class="text-[10px] opacity-40 shrink-0">{{ row.count }}</span>
              </button>
              <button v-if="row.kind === 'bucket'" @click.stop="triggerPick(row.bucketSlug)" :disabled="uploading"
                class="shrink-0 rounded border border-current/20 px-2 py-0.5 opacity-50 hover:opacity-100 transition disabled:opacity-30"
                title="Upload to this bucket">
                <font-awesome-icon :icon="uploading && uploadTargetBucket === row.bucketSlug ? 'spinner' : 'upload'"
                  :spin="uploading && uploadTargetBucket === row.bucketSlug" />
              </button>
            </template>

            <!-- FILE row -->
            <template v-else>
              <font-awesome-icon :icon="fileIcon(row.file!.file_type)" :class="fileColor(row.file!.file_type)" class="text-sm shrink-0 w-4" />
              <div class="flex-1 min-w-0">
                <template v-if="renamingKey === row.file!.key">
                  <input v-model="renameValue"
                    @keydown.enter="submitRename(row.file!.key)"
                    @keydown.escape="renamingKey = null"
                    @blur="submitRename(row.file!.key)"
                    :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
                    class="w-full rounded border px-2 py-0.5 text-xs outline-none" autofocus />
                </template>
                <button v-else-if="row.file!.is_editable" @click="openEditor(row.file!)"
                  class="font-semibold truncate block text-left hover:underline underline-offset-2" :title="`Edit ${row.file!.title}`">
                  {{ row.file!.title }}
                </button>
                <span v-else class="font-semibold truncate block" :title="row.file!.title">{{ row.file!.title }}</span>
              </div>

              <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                class="shrink-0 rounded border px-1.5 py-0.5 uppercase tracking-wide text-[10px] opacity-60">
                {{ fileLabel(row.file!.file_type) }}
              </span>
              <font-awesome-icon v-if="row.file!.is_encrypted" icon="lock" class="shrink-0 text-yellow-400 text-xs" title="Encrypted" />
              <span class="shrink-0 opacity-40 hidden sm:block">{{ formatSize(row.file!.file_size_bytes) }}</span>
              <span class="shrink-0 opacity-40 hidden md:block">{{ formatDate(row.file!.uploaded_at) }}</span>

              <div class="flex items-center gap-1 shrink-0">
                <button v-if="row.file!.is_editable" @click="openEditor(row.file!)"
                  class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:opacity-100 transition" title="Edit">
                  <font-awesome-icon icon="code" />
                </button>
                <a v-if="row.file!.download_url" :href="row.file!.download_url" target="_blank" rel="noopener"
                  class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:opacity-100 transition" title="Download">
                  <font-awesome-icon icon="download" />
                </a>
                <button @click="startRename(row.file!)"
                  class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:opacity-100 transition" title="Rename">
                  <font-awesome-icon icon="pencil" />
                </button>
                <button @click="openCrypto(row.file!)"
                  :class="row.file!.is_encrypted ? 'text-yellow-400 border-yellow-400/30' : 'border-current/15'"
                  class="rounded border px-1.5 py-0.5 opacity-60 hover:opacity-100 transition"
                  :title="row.file!.is_encrypted ? 'Decrypt' : 'Encrypt'">
                  <font-awesome-icon :icon="row.file!.is_encrypted ? 'lock-open' : 'lock'" />
                </button>
                <template v-if="confirmDeleteKey !== row.file!.key">
                  <button @click="confirmDeleteKey = row.file!.key"
                    class="rounded border border-current/15 px-1.5 py-0.5 opacity-50 hover:text-red-400 hover:opacity-100 transition" title="Delete">
                    <font-awesome-icon icon="trash" />
                  </button>
                </template>
                <template v-else>
                  <button @click="del(row.file!.key)" class="rounded bg-red-500 px-2 py-0.5 text-white font-bold text-xs">Yes</button>
                  <button @click="confirmDeleteKey = null" class="rounded border border-current/20 px-1.5 py-0.5 opacity-60 hover:opacity-100 transition text-xs">✕</button>
                </template>
              </div>
            </template>
          </div>
        </div>
      </template>

      <!-- ── GRID VIEW (folder navigation) ──────────────────────────────────── -->
      <template v-else>
        <!-- Breadcrumb -->
        <div class="flex items-center gap-1 flex-wrap text-xs shrink-0">
          <template v-for="(c, i) in breadcrumb" :key="i">
            <font-awesome-icon v-if="i > 0" icon="chevron-right" class="text-[9px] opacity-30" />
            <button @click="gotoCrumb(c)"
              :class="i === breadcrumb.length - 1
                ? (darkMode ? 'text-accent-dark' : 'text-accent-light') + ' font-bold'
                : 'opacity-60 hover:opacity-100'"
              class="rounded px-1.5 py-0.5 transition flex items-center gap-1">
              <font-awesome-icon v-if="i === 0" icon="hard-drive" class="text-[10px]" />
              <font-awesome-icon v-else icon="folder" class="text-[10px]" />
              {{ c.label }}
            </button>
          </template>
          <button v-if="gridBucket" @click="triggerPick(gridBucket)" :disabled="uploading"
            class="ml-auto rounded border border-current/20 px-2 py-0.5 opacity-60 hover:opacity-100 transition disabled:opacity-30"
            title="Upload to this bucket">
            <font-awesome-icon :icon="uploading ? 'spinner' : 'upload'" :spin="uploading" /> Upload
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <!-- Bucket cards (root) -->
          <div v-if="!gridBucket" class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            <button v-for="b in forest" :key="b.slug" @click="openBucketCard(b.slug)"
              :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
              class="flex flex-col items-center gap-2 rounded-xl border p-4 shadow-sm transition hover:opacity-80">
              <font-awesome-icon icon="folder" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-3xl" />
              <span class="text-xs font-semibold truncate w-full text-center" :title="b.name">{{ b.name }}</span>
              <span class="text-[10px] opacity-40">{{ b.fileCount }} file{{ b.fileCount !== 1 ? 's' : '' }}</span>
            </button>
          </div>

          <!-- Folder contents -->
          <div v-else>
            <div v-if="gridDirs.length === 0 && gridFiles.length === 0"
              class="flex flex-col items-center justify-center opacity-40 gap-2 py-16 text-sm">
              <font-awesome-icon icon="folder-open" class="text-3xl" />
              Empty folder
            </div>
            <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              <!-- Subfolder cards -->
              <button v-for="d in gridDirs" :key="`d${d.id}`" @click="openDirCard(d.id)"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
                class="flex flex-col items-center gap-2 rounded-xl border p-3 shadow-sm transition hover:opacity-80">
                <font-awesome-icon icon="folder" class="text-3xl opacity-70" />
                <span class="text-xs font-semibold truncate w-full text-center" :title="d.name">{{ d.name }}</span>
                <span class="text-[10px] opacity-40">{{ d.files.length }} · {{ d.dirs.length }} sub</span>
              </button>

              <!-- File cards -->
              <div v-for="f in gridFiles" :key="f.key"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
                class="relative flex flex-col gap-2 rounded-xl border p-3 shadow-sm">
                <div class="flex items-center justify-center h-12 opacity-60">
                  <font-awesome-icon :icon="fileIcon(f.file_type)" :class="fileColor(f.file_type)" class="text-3xl" />
                </div>
                <div v-if="f.is_encrypted" class="absolute top-2 right-2">
                  <font-awesome-icon icon="lock" class="text-xs text-yellow-400" />
                </div>
                <template v-if="renamingKey === f.key">
                  <input v-model="renameValue"
                    @keydown.enter="submitRename(f.key)"
                    @keydown.escape="renamingKey = null"
                    @blur="submitRename(f.key)"
                    :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
                    class="w-full rounded border px-2 py-0.5 text-xs outline-none" autofocus />
                </template>
                <button v-else-if="f.is_editable" @click="openEditor(f)" class="truncate text-xs font-semibold text-left hover:underline underline-offset-2" :title="`Edit ${f.title}`">{{ f.title }}</button>
                <p v-else class="truncate text-xs font-semibold" :title="f.title">{{ f.title }}</p>
                <p class="text-xs opacity-40">{{ formatSize(f.file_size_bytes) }} · {{ formatDate(f.uploaded_at) }}</p>
                <div class="flex gap-1 mt-auto flex-wrap">
                  <button v-if="f.is_editable" @click="openEditor(f)"
                    class="rounded-lg border border-current/20 px-2 py-1 text-xs opacity-60 hover:opacity-100 transition" title="Edit">
                    <font-awesome-icon icon="code" />
                  </button>
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
        </div>
      </template>
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

    <!-- ══════════════════════════ ACE EDITOR MODAL ═══════════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="editorFile"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        :class="darkMode ? 'bg-black/60' : 'bg-black/30'"
        @click.self="closeEditor">
        <div :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
          class="flex w-full max-w-4xl flex-col rounded-xl border shadow-2xl overflow-hidden" style="height:80vh">
          <!-- Header -->
          <div class="flex items-center justify-between gap-3 border-b border-current/10 px-5 py-3 shrink-0">
            <h3 class="flex items-center gap-2 text-sm font-bold min-w-0">
              <font-awesome-icon :icon="fileIcon(editorFile.file_type)" :class="fileColor(editorFile.file_type)" />
              <span class="truncate">{{ editorFile.title }}</span>
              <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                class="shrink-0 rounded border px-1.5 py-0.5 uppercase tracking-wide text-[10px] opacity-60">
                {{ fileLabel(editorFile.file_type) }}
              </span>
              <span v-if="editorDirty" class="shrink-0 text-[10px] text-amber-400">● unsaved</span>
            </h3>
            <div class="flex items-center gap-2 shrink-0">
              <button @click="saveEditor" :disabled="editorSaving || !editorDirty || editorLoading"
                :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                class="rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5">
                <font-awesome-icon :icon="editorSaving ? 'spinner' : 'floppy-disk'" :spin="editorSaving" />
                {{ editorSaving ? 'Saving…' : 'Save' }}
              </button>
              <button @click="closeEditor" class="opacity-50 hover:opacity-100 transition">
                <font-awesome-icon icon="xmark" />
              </button>
            </div>
          </div>

          <!-- Error -->
          <div v-if="editorError" class="shrink-0 border-b border-current/10 px-5 py-2 text-xs text-red-400 flex items-center gap-2">
            <font-awesome-icon icon="triangle-exclamation" /> {{ editorError }}
          </div>

          <!-- Body -->
          <div class="relative flex-1 min-h-0">
            <div v-if="editorLoading" class="absolute inset-0 z-10 flex items-center justify-center opacity-50"
              :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'">
              <font-awesome-icon icon="spinner" spin class="text-2xl" />
            </div>
            <div ref="editorContainer" class="absolute inset-0 w-full h-full text-sm"></div>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>
