<script setup lang="ts">
// Mind tab: a local-only mind map (cytoscape canvas) plus a "dump" capture
// inbox whose entries convert into nodes under a topic. Nothing here is shared:
// the kv namespace `mind` is absent from every sync allow-list by design.
//
// The map lives in the module singleton from useMind, not in this view: the
// router unmounts views on navigation, so view-local state would drop the graph
// and its undo history every time the user looks at another tab.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaIconButton, OyaModal } from "rakotis";
import MindDumpPanel from "../components/mind/MindDumpPanel.vue";
import MindMapPanel from "../components/mind/MindMapPanel.vue";
import { exportMindJson, readMindImportFile } from "../components/mind/mindExport";
import { parseImportFile, type MindDoc } from "../components/mind/mindModel";
import { getMind } from "../components/mind/useMind";

defineProps<{ darkMode?: boolean }>();

const { t } = useI18n();
const mind = getMind();

type MindTab = "map" | "dump";
const activeTab = ref<MindTab>("map");

const nodeCount = computed(() => mind.nodes.value.length);
const edgeCount = computed(() => mind.edges.value.length);

// ── export / import ─────────────────────────────────────────────────────────
const busy = ref(false);
const notice = ref("");
/** Errors are held separately from `notice` so a transient state can never
 *  hide one (the sketch view learned this the hard way). */
const error = ref("");

async function runExport() {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    // Persist first: what lands on disk should match what's saved.
    await mind.flushPersist();
    const name = `mind-${new Date().toISOString().slice(0, 10)}.json`;
    if (await exportMindJson(mind.doc.value, name)) notice.value = "exported";
  } catch (e) {
    error.value = (e as Error)?.message ?? String(e);
  } finally {
    busy.value = false;
  }
}

// A hidden <input type="file"> rather than the Tauri dialog plugin: reading
// needs the bytes, not a path, so this works identically in the desktop
// webview and the browser dev build (sketch background-image pattern).
const importInput = ref<HTMLInputElement | null>(null);
/** Validated but not yet confirmed — the modal shows ITS counts, not the
 *  file's self-declared metadata (a mismatch means entries were dropped). */
const pendingImport = ref<MindDoc | null>(null);

const IMPORT_ERROR_KEYS: Record<string, string> = {
  unreadable: "mind.importUnreadable",
  "not-json": "mind.importInvalid",
};

async function onImportPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // Clear immediately so re-picking the SAME file still fires a change event.
  input.value = "";
  if (!file) return;
  error.value = "";
  notice.value = "";
  try {
    const parsed = await readMindImportFile(file);
    const doc = parseImportFile(parsed, mind.caps);
    if (!doc) {
      error.value = t("mind.importInvalid");
      return;
    }
    pendingImport.value = doc;
  } catch (err) {
    const code = (err as Error)?.message ?? "";
    error.value = t(IMPORT_ERROR_KEYS[code] ?? "mind.importUnreadable");
  }
}

async function confirmImport() {
  const doc = pendingImport.value;
  pendingImport.value = null;
  if (doc) await mind.replaceDoc(doc);
}

// ── keyboard shortcuts ──────────────────────────────────────────────────────
// Canvas-mode keys (Escape/F) live in MindGraph, which owns the gesture state.
// The guard also skips Trix's contenteditable surface — `isContentEditable`
// covers <trix-editor>, which is neither INPUT nor TEXTAREA.
function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) mind.redo();
    else mind.undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    mind.redo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && mind.selected.value) {
    e.preventDefault();
    const sel = mind.selected.value;
    if (sel.kind === "node") mind.deleteNode(sel.id);
    else mind.deleteEdge(sel.id);
  } else if (e.key === " " && mind.selectedNode.value) {
    e.preventDefault();
    mind.toggleCollapsed(mind.selectedNode.value.id);
  } else if (e.key === "F2" && mind.selectedNode.value) {
    e.preventDefault();
    mind.focusTitleRequest.value++;
  }
}

onMounted(() => {
  void mind.load();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  // Don't leave the map unsaved behind a debounce when navigating away.
  void mind.flushPersist();
});
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-xl font-bold">{{ $t('mind.title') }}</h1>
        <p class="text-sm opacity-60">{{ $t('mind.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <p class="text-xs opacity-50">{{ $t('mind.nodeCount', { n: nodeCount, e: edgeCount }) }}</p>
        <OyaIconButton
          icon="download"
          size="sm"
          :label="$t('mind.export')"
          :disabled="busy"
          data-testid="mind-export"
          @click="runExport"
        />
        <OyaIconButton
          icon="upload"
          size="sm"
          :label="$t('mind.import')"
          :disabled="busy"
          data-testid="mind-import"
          @click="importInput?.click()"
        />
      </div>
    </div>
    <input ref="importInput" type="file" accept="application/json,.json" class="hidden" @change="onImportPicked" />

    <!-- Map / Dump sub-tabs (EnigmaFilesView pill pattern) -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex gap-1 rounded-xl border p-1 text-sm font-semibold"
    >
      <button
        type="button"
        :class="activeTab === 'map'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'map'"
      >
        <font-awesome-icon icon="diagram-project" />{{ $t('mind.mapTab') }}
      </button>
      <button
        type="button"
        :class="activeTab === 'dump'
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = 'dump'"
      >
        <font-awesome-icon icon="lightbulb" />{{ $t('mind.dumpTab') }}
      </button>
    </div>

    <p v-if="mind.loadFailed.value" class="text-xs text-warn-dark">
      {{ $t('mind.loadFailed') }}
    </p>
    <p v-if="mind.dumpLoadFailed.value" class="text-xs text-warn-dark">
      {{ $t('mind.dumpLoadFailed') }}
    </p>
    <p v-if="error" class="text-xs text-warn-dark">{{ error }}</p>
    <p v-else-if="notice === 'exported'" class="text-xs opacity-60">{{ $t('mind.exportDone') }}</p>

    <div class="flex min-h-0 flex-1 flex-col">
      <MindMapPanel v-if="activeTab === 'map'" :mind="mind" :dark-mode="darkMode" />
      <MindDumpPanel v-else :mind="mind" :dark-mode="darkMode" />
    </div>

    <!-- Import confirm: REPLACE semantics, undoable, validated counts shown -->
    <OyaModal :open="pendingImport !== null" @close="pendingImport = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('mind.importConfirmTitle') }}
        </p>
        <p class="text-sm opacity-80">
          {{ $t('mind.importConfirmBody', { nodes: pendingImport?.nodes.length ?? 0, edges: pendingImport?.edges.length ?? 0 }) }}
        </p>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="pendingImport = null">{{ $t('mind.cancel') }}</OyaButton>
          <OyaButton data-testid="mind-import-confirm" @click="confirmImport">
            <font-awesome-icon icon="upload" />
            {{ $t('mind.importReplace') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>
  </div>
</template>
