<script setup lang="ts">
// GeoJSON editor for the Locations tab: load from disk or the vault, edit the raw
// GeoJSON (Ace, JSON mode) with a live Leaflet preview, then save back to disk or
// the vault. Disk I/O uses the native dialog + Rust fs commands under Tauri, and
// falls back to <input type=file> / blob download in a plain browser.

import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import ace from "ace-builds/src-noconflict/ace";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/theme-monokai";
import "ace-builds/src-noconflict/theme-chrome";
import { useVaultStore } from "../stores/vault";
import { api, type VaultFile } from "../services/api";
import {
  parseGeoJson,
  featureCount as countFeatures,
  ensureGeojsonName,
  isGeoJsonVaultFile,
  formatGeoJson,
  SAMPLE_GEOJSON,
} from "../lib/geojson";

ace.config.set("useWorker", false);

const props = defineProps<{ darkMode: boolean }>();

const vault = useVaultStore();

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

// ── Editor state ───────────────────────────────────────────────────────────────
const text = ref<string>(SAMPLE_GEOJSON);
const fileName = ref("untitled.geojson");
const parseError = ref<string | null>(null);
const status = ref<string | null>(null);
const busy = ref(false);
// When set, the document is tied to this vault file (in-place save if editable).
const vaultFile = ref<VaultFile | null>(null);

const featureCount = computed(() => {
  const res = parseGeoJson(text.value);
  return res.ok ? countFeatures(res.data) : 0;
});

function flash(msg: string) {
  status.value = msg;
  setTimeout(() => { if (status.value === msg) status.value = null; }, 3000);
}

// ── Leaflet preview ──────────────────────────────────────────────────────────────
const mapEl = ref<HTMLElement | null>(null);
let map: L.Map | null = null;
let tile: L.TileLayer | null = null;
let layer: L.GeoJSON | null = null;

function makeTiles(dark: boolean): L.TileLayer {
  return dark
    ? L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> © CARTO',
      })
    : L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      });
}

function initMap() {
  if (!mapEl.value || map) return;
  map = L.map(mapEl.value, { zoomControl: false, scrollWheelZoom: true }).setView([52, 19], 4);
  tile = makeTiles(props.darkMode).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
}

let renderDebounce: ReturnType<typeof setTimeout> | null = null;
watch(text, () => {
  if (renderDebounce) clearTimeout(renderDebounce);
  renderDebounce = setTimeout(renderPreview, 300);
});

function renderPreview(fit = true) {
  const res = parseGeoJson(text.value);
  if (!res.ok) {
    parseError.value = res.error;
    return;
  }
  parseError.value = null;
  if (!map) return;
  if (layer) { map.removeLayer(layer); layer = null; }
  try {
    layer = L.geoJSON(res.data as any, {
      style: () => ({ color: "#4f5fa1", fillColor: "#4f5fa1", fillOpacity: 0.3, opacity: 0.9, weight: 2 }),
      pointToLayer: (_f, latlng) =>
        L.circleMarker(latlng, { radius: 6, color: "#10b981", fillColor: "#10b981", fillOpacity: 0.85, weight: 2 }),
      onEachFeature: (f, lyr) => {
        const name = (f.properties && (f.properties.name ?? f.properties.title)) as string | undefined;
        if (name) lyr.bindPopup(String(name));
      },
    }).addTo(map);
    if (fit) {
      const b = layer.getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [24, 24], maxZoom: 14 });
    }
  } catch (e: any) {
    parseError.value = `Could not render: ${e.message ?? e}`;
  }
}

// ── Ace editor ───────────────────────────────────────────────────────────────────
const editorEl = ref<HTMLElement | null>(null);
let editor: any = null;

function initEditor() {
  if (!editorEl.value || editor) return;
  editor = ace.edit(editorEl.value);
  editor.setTheme(`ace/theme/${props.darkMode ? "monokai" : "chrome"}`);
  editor.session.setMode("ace/mode/json");
  editor.setOptions({ fontSize: "13px", showPrintMargin: false, wrap: true, useWorker: false, tabSize: 2 });
  editor.setValue(text.value, -1);
  editor.session.on("change", () => { text.value = editor.getValue(); });
}

/** Push new content into both the model and the editor without losing the cursor noise. */
function setDocument(content: string) {
  text.value = content;
  if (editor) editor.setValue(content, -1);
}

// ── Load: disk ───────────────────────────────────────────────────────────────────
const fileInputRef = ref<HTMLInputElement | null>(null);

async function loadFromDisk() {
  parseError.value = null;
  if (_isTauri()) {
    busy.value = true;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
      });
      if (typeof path !== "string" || !path) return;
      const { invoke } = await import("@tauri-apps/api/core");
      const content = await invoke<string>("fs_read_text_file", { path });
      setDocument(content);
      fileName.value = path.split(/[\\/]/).pop() || "untitled.geojson";
      vaultFile.value = null;
      await nextTick();
      renderPreview();
      flash(`Loaded ${fileName.value}`);
    } catch (e: any) {
      parseError.value = e?.message ?? "Failed to read file";
    } finally {
      busy.value = false;
    }
    return;
  }
  fileInputRef.value?.click();
}

async function onDiskInput(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    setDocument(await file.text());
    fileName.value = file.name;
    vaultFile.value = null;
    await nextTick();
    renderPreview();
    flash(`Loaded ${file.name}`);
  } catch (err: any) {
    parseError.value = err?.message ?? "Failed to read file";
  } finally {
    if (fileInputRef.value) fileInputRef.value.value = "";
  }
}

// ── Load: vault ──────────────────────────────────────────────────────────────────
const vaultPickerOpen = ref(false);
const vaultFilter = ref("");

const vaultGeoFiles = computed(() => {
  const q = vaultFilter.value.trim().toLowerCase();
  return vault.files.filter((f) => isGeoJsonVaultFile(f) && (!q || f.title.toLowerCase().includes(q)));
});

async function openVaultPicker() {
  vaultPickerOpen.value = true;
  if (!vault.files.length) await vault.fetchFiles();
}

async function loadFromVault(f: VaultFile) {
  busy.value = true;
  parseError.value = null;
  try {
    const content = await api.getFileContent(f.key);
    setDocument(content.content);
    fileName.value = f.title;
    vaultFile.value = f;
    vaultPickerOpen.value = false;
    await nextTick();
    renderPreview();
    flash(`Loaded ${f.title} from vault`);
  } catch (e: any) {
    parseError.value = e?.message ?? "Failed to load from vault";
  } finally {
    busy.value = false;
  }
}

// ── Save: disk ───────────────────────────────────────────────────────────────────
async function saveToDisk() {
  const name = ensureGeojsonName(fileName.value);
  parseError.value = null;
  if (_isTauri()) {
    busy.value = true;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: name,
        filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
      });
      if (!dest) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("fs_write_text_file", { path: dest, contents: text.value });
      flash(`Saved to ${dest}`);
    } catch (e: any) {
      parseError.value = e?.message ?? "Save failed";
    } finally {
      busy.value = false;
    }
    return;
  }
  // Browser: trigger a download.
  const blob = new Blob([text.value], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  flash(`Downloaded ${name}`);
}

// ── Save: vault ──────────────────────────────────────────────────────────────────
async function saveToVault() {
  busy.value = true;
  parseError.value = null;
  try {
    if (vaultFile.value && vaultFile.value.is_editable) {
      const vf = await vault.saveContent(vaultFile.value.key, text.value);
      vaultFile.value = vf;
      flash(`Updated ${vf.title} in vault`);
    } else {
      const name = ensureGeojsonName(fileName.value);
      const file = new File([text.value], name, { type: "application/geo+json" });
      const vf = await vault.upload(file, name);
      vaultFile.value = vf;
      fileName.value = vf.title;
      flash(`Saved ${name} to vault`);
    }
  } catch (e: any) {
    parseError.value = e?.message ?? "Vault save failed";
  } finally {
    busy.value = false;
  }
}

// ── Toolbar actions ──────────────────────────────────────────────────────────────
function format() {
  const res = formatGeoJson(text.value);
  if (!res.ok) { parseError.value = res.error; return; }
  setDocument(res.text!);
  flash("Formatted");
}

function newDoc() {
  setDocument(SAMPLE_GEOJSON);
  fileName.value = "untitled.geojson";
  vaultFile.value = null;
  parseError.value = null;
  nextTick().then(() => renderPreview());
}

// ── Lifecycle ────────────────────────────────────────────────────────────────────
onMounted(async () => {
  await nextTick();
  initMap();
  initEditor();
  renderPreview();
});

onBeforeUnmount(() => {
  if (editor) { editor.destroy(); editor = null; }
  if (map) { map.remove(); map = null; }
});

watch(() => props.darkMode, (dark) => {
  if (editor) editor.setTheme(`ace/theme/${dark ? "monokai" : "chrome"}`);
  if (map) {
    if (tile) map.removeLayer(tile);
    tile = makeTiles(dark).addTo(map);
  }
});

function panelCls() {
  return `rounded-xl border shadow-sm ${props.darkMode ? "bg-bubble-bg-dark border-accent-1" : "bg-bubble-bg-light border-accent-2"}`;
}
function btnCls() {
  return props.darkMode
    ? "bg-accent-dark text-primary-bg-dark"
    : "bg-accent-light text-primary-bg-light";
}
function ghostBtnCls() {
  return "border border-current/20 opacity-70 hover:opacity-100";
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- Hidden disk input (browser fallback / non-Tauri) -->
    <input
      ref="fileInputRef"
      type="file"
      accept=".geojson,.json,application/geo+json,application/json"
      class="hidden"
      @change="onDiskInput"
    />

    <!-- Toolbar -->
    <div :class="panelCls()" class="flex flex-wrap items-center gap-2 p-3">
      <span class="text-xs font-bold uppercase tracking-wide opacity-50 mr-1">Load</span>
      <button @click="loadFromDisk" :disabled="busy" :class="ghostBtnCls()"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40">
        <font-awesome-icon icon="folder-open" />Disk
      </button>
      <button @click="openVaultPicker" :disabled="busy" :class="ghostBtnCls()"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40">
        <font-awesome-icon icon="hard-drive" />Vault
      </button>

      <span class="mx-1 h-5 w-px bg-current/15"></span>
      <span class="text-xs font-bold uppercase tracking-wide opacity-50 mr-1">Save</span>
      <button @click="saveToDisk" :disabled="busy" :class="btnCls()"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90 disabled:opacity-40">
        <font-awesome-icon icon="download" />Disk
      </button>
      <button @click="saveToVault" :disabled="busy" :class="btnCls()"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90 disabled:opacity-40">
        <font-awesome-icon icon="hard-drive" />{{ vaultFile && vaultFile.is_editable ? "Update vault" : "Vault" }}
      </button>

      <span class="mx-1 h-5 w-px bg-current/15"></span>
      <button @click="format" :class="ghostBtnCls()"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition">
        <font-awesome-icon icon="code" />Format
      </button>
      <button @click="newDoc" :class="ghostBtnCls()"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition">
        <font-awesome-icon icon="file" />New
      </button>

      <!-- Filename + counts -->
      <div class="ml-auto flex items-center gap-2">
        <input v-model="fileName" type="text" spellcheck="false"
          :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
          class="w-44 rounded-lg border px-2 py-1.5 text-xs font-mono outline-none" />
        <span class="text-xs opacity-50 whitespace-nowrap">{{ featureCount }} feat.</span>
      </div>
    </div>

    <!-- Status / error line -->
    <div v-if="parseError" class="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-400">
      <font-awesome-icon icon="triangle-exclamation" class="mr-1" />{{ parseError }}
    </div>
    <div v-else-if="status" class="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-400">
      <font-awesome-icon icon="check" class="mr-1" />{{ status }}
    </div>

    <!-- Editor + preview, side by side on desktop -->
    <div class="flex flex-col lg:flex-row gap-3 h-[64vh]">
      <div :class="panelCls()" class="relative overflow-hidden flex-1 min-h-[240px]">
        <div ref="editorEl" class="absolute inset-0"></div>
      </div>
      <div :class="panelCls()" class="relative overflow-hidden flex-1 min-h-[240px] z-[1]">
        <div ref="mapEl" class="absolute inset-0" :class="{ 'dark-map': darkMode }"></div>
      </div>
    </div>

    <!-- ── Vault picker modal ── -->
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0"
      enter-to-class="opacity-100" leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100" leave-to-class="opacity-0">
      <div v-if="vaultPickerOpen" class="fixed inset-0 z-[2000] flex items-center justify-center p-4"
        :class="darkMode ? 'bg-black/60' : 'bg-black/30'" @click.self="vaultPickerOpen = false">
        <div :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
          class="w-full max-w-md rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
          <div class="flex items-center justify-between border-b border-current/10 px-4 py-3 shrink-0">
            <h3 class="text-sm font-bold flex items-center gap-2">
              <font-awesome-icon icon="hard-drive" class="opacity-60" />Open GeoJSON from vault
            </h3>
            <button @click="vaultPickerOpen = false" class="opacity-50 hover:opacity-100 transition">
              <font-awesome-icon icon="xmark" />
            </button>
          </div>
          <div class="p-3 border-b border-current/10 shrink-0">
            <div class="relative">
              <font-awesome-icon icon="magnifying-glass" class="absolute left-3 top-1/2 -translate-y-1/2 text-xs opacity-40 pointer-events-none" />
              <input v-model="vaultFilter" type="text" placeholder="Filter files…"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
                class="w-full rounded-lg border pl-8 pr-3 py-2 text-xs outline-none" />
            </div>
          </div>
          <div class="overflow-y-auto">
            <div v-if="vault.loading" class="flex items-center justify-center py-8 opacity-40">
              <font-awesome-icon icon="spinner" spin class="text-xl" />
            </div>
            <div v-else-if="!vaultGeoFiles.length" class="px-4 py-8 text-center text-xs opacity-40">
              No .geojson / .json files in your vault.
            </div>
            <button v-for="f in vaultGeoFiles" :key="f.key" @click="loadFromVault(f)"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-left text-xs hover:bg-current/5 transition border-b border-current/5">
              <font-awesome-icon icon="code" class="text-emerald-400 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="block font-semibold truncate">{{ f.title }}</span>
                <span class="block opacity-40 truncate">{{ f.bucket_slug || "vault" }}</span>
              </span>
              <font-awesome-icon v-if="!f.is_editable" icon="lock" class="opacity-30 shrink-0" title="read-only" />
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
