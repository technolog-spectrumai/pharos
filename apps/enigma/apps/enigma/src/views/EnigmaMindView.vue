<script setup lang="ts">
// Mind tab: a local-only mind map (cytoscape canvas) plus a "dump" capture
// inbox whose entries convert into nodes under a topic. Nothing here is shared:
// the kv namespace `mind` is absent from every sync allow-list by design.
//
// The map lives in the module singleton from useMind, not in this view: the
// router unmounts views on navigation, so view-local state would drop the graph
// and its undo history every time the user looks at another tab.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import MindDumpPanel from "../components/mind/MindDumpPanel.vue";
import MindMapPanel from "../components/mind/MindMapPanel.vue";
import { getMind } from "../components/mind/useMind";

defineProps<{ darkMode?: boolean }>();

const mind = getMind();

type MindTab = "map" | "dump";
const activeTab = ref<MindTab>("map");

const nodeCount = computed(() => mind.nodes.value.length);
const edgeCount = computed(() => mind.edges.value.length);

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
      <p class="text-xs opacity-50">{{ $t('mind.nodeCount', { n: nodeCount, e: edgeCount }) }}</p>
    </div>

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

    <div class="flex min-h-0 flex-1 flex-col">
      <MindMapPanel v-if="activeTab === 'map'" :mind="mind" :dark-mode="darkMode" />
      <MindDumpPanel v-else :mind="mind" :dark-mode="darkMode" />
    </div>
  </div>
</template>
