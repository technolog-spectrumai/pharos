<script setup lang="ts">
// Aurora knowledge-graph view — three things only: display the graph, run a saved
// query (the admin-defined "Knowledge Graph Queries" visible in ravioli), and
// search (client-side filter of the displayed graph). Nothing runs automatically:
// pick a query / type a search term, then press Run. Reads are data_mesh-gated and
// fail gracefully when Neo4j is absent/down (503).
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import cytoscape from "cytoscape";
import { api, type KgQuery, type KgGraph, type KgNode } from "../services/api";

const props = defineProps<{ darkMode: boolean }>();

type GraphState = "loading" | "idle" | "ready" | "empty" | "unavailable" | "gated" | "auth" | "error";

const queries = ref<KgQuery[]>([]);
const selectedId = ref<number | null>(null);
const displayedId = ref<number | null>(null); // the query currently drawn on the canvas
const graph = ref<KgGraph | null>(null);
const state = ref<GraphState>("loading");
const errorMsg = ref("");
const search = ref("");

const container = ref<HTMLElement | null>(null);
let cy: cytoscape.Core | null = null;

// ── helpers ─────────────────────────────────────────────────────────────────
function nodeLabel(n: KgNode): string {
  const p = n.props || {};
  for (const k of ["name", "display_name", "title", "label", "uid"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return n.labels?.[0] || n.id;
}
function nodeSearchText(n: KgNode): string {
  return [nodeLabel(n), ...(n.labels || []), ...Object.values(n.props || {}).map(String)]
    .join(" ")
    .toLowerCase();
}

function classify(e: unknown): GraphState {
  const msg = e instanceof Error ? e.message : String(e);
  if (/graph_unavailable|\b503\b/.test(msg)) return "unavailable";
  if (/\bgated\b|access gated|\b403\b/.test(msg)) return "gated";
  if (/Not authenticated|\b401\b/.test(msg)) return "auth";
  errorMsg.value = msg;
  return "error";
}

// ── data ──────────────────────────────────────────────────────────────────────
async function loadQueries() {
  state.value = "loading";
  try {
    const res = await api.getKgQueries();
    queries.value = res.queries ?? [];
    if (!queries.value.length) {
      state.value = "empty";
      return;
    }
    selectedId.value = queries.value[0].id;
    state.value = "idle"; // nothing runs until the user presses Run
  } catch (e) {
    state.value = classify(e);
  }
}

async function runSelected() {
  if (selectedId.value == null) return;
  state.value = "loading";
  try {
    graph.value = await api.runKgQuery(selectedId.value);
    displayedId.value = selectedId.value;
    state.value = "ready";
    await nextTick();
    render();
    applySearch();
  } catch (e) {
    graph.value = null;
    state.value = classify(e);
  }
}

// Run button: fetch the selected query if it isn't the one already drawn,
// otherwise just (re)apply the current search filter — no needless re-query.
async function onRun() {
  if (selectedId.value == null) return;
  if (state.value === "ready" && selectedId.value === displayedId.value) {
    applySearch();
  } else {
    await runSelected();
  }
}

// ── render ──────────────────────────────────────────────────────────────────
function render() {
  if (!container.value || !graph.value) return;
  cy?.destroy();

  const dm = props.darkMode;
  const bg = dm ? "#0a0c11" : "#f2f3f5";
  const bubble = dm ? "#191f2d" : "#e8e9ec";
  const accent = dm ? "#4f5fa1" : "#2f3d63";
  const text = dm ? "#d3d7e0" : "#0f1114";

  const elements: cytoscape.ElementDefinition[] = [];
  for (const n of graph.value.nodes) {
    elements.push({ data: { id: n.id, label: nodeLabel(n), search: nodeSearchText(n) } });
  }
  const present = new Set(graph.value.nodes.map((n) => n.id));
  for (const e of graph.value.edges) {
    if (!present.has(e.start) || !present.has(e.end)) continue; // skip dangling
    elements.push({ data: { id: e.id, source: e.start, target: e.end, label: e.type } });
  }

  cy = cytoscape({
    container: container.value,
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": bubble,
          "border-color": accent,
          "border-width": 2,
          label: "data(label)",
          color: text,
          "font-size": 11,
          "text-wrap": "wrap",
          "text-max-width": "120px",
          "text-valign": "center",
          "text-halign": "center",
          width: 46,
          height: 46,
          "font-family": "Orbitron, sans-serif",
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.5,
          "line-color": accent,
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "target-arrow-color": accent,
          label: "data(label)",
          "font-size": 8,
          color: text,
          "text-rotation": "autorotate",
          "text-background-color": bg,
          "text-background-opacity": 0.7,
          "text-background-padding": "2px",
        },
      },
      { selector: ".dim", style: { opacity: 0.12 } },
      { selector: "node:selected", style: { "border-color": dm ? "#7b9cff" : "#1a3a99", "border-width": 3 } },
    ],
    layout: { name: "cose", animate: false, padding: 40, fit: true, nodeRepulsion: 6000 } as cytoscape.LayoutOptions,
  });
  container.value.style.backgroundColor = bg;
}

// ── search (client-side filter of the displayed graph; applied on Run) ────────
function applySearch() {
  if (!cy) return;
  const term = search.value.trim().toLowerCase();
  cy.batch(() => {
    cy!.elements().removeClass("dim");
    if (!term) return;
    const matches = cy!.nodes().filter((n) => String(n.data("search") || "").includes(term));
    cy!.elements().addClass("dim");
    matches.removeClass("dim");
    const edges = matches.connectedEdges();
    edges.removeClass("dim");
    edges.connectedNodes().removeClass("dim");
  });
}

// Re-render on theme toggle (the already-fetched graph), keeping the filter.
watch(() => props.darkMode, () => { if (state.value === "ready") { render(); applySearch(); } });

const selectedDescription = computed(
  () => queries.value.find((q) => q.id === selectedId.value)?.description || "",
);
const canRun = computed(() => selectedId.value != null && state.value !== "loading");

onMounted(loadQueries);
onBeforeUnmount(() => cy?.destroy());
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3 overflow-hidden">
    <!-- Toolbar: pick a query, type a search term, then press Run -->
    <div
      :class="darkMode ? 'border-accent-1 bg-bubble-bg-dark' : 'border-accent-2 bg-bubble-bg-light'"
      class="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
    >
      <div class="flex min-w-0 items-center gap-2">
        <font-awesome-icon icon="diagram-project" class="opacity-60" />
        <label class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ $t('graph.query') }}</label>
        <div class="relative">
          <select
            v-model.number="selectedId"
            :disabled="!queries.length"
            :class="darkMode
              ? 'border-accent-1 bg-primary-bg-dark text-text-main-dark'
              : 'border-accent-2 bg-primary-bg-light text-text-main-light'"
            class="min-w-0 max-w-[260px] cursor-pointer appearance-none rounded-lg border px-2.5 py-1.5 pr-8 text-sm outline-none transition disabled:opacity-40"
            @keydown.enter="onRun"
          >
            <option
              v-for="q in queries"
              :key="q.id"
              :value="q.id"
              :class="darkMode ? 'bg-primary-bg-dark text-text-main-dark' : 'bg-primary-bg-light text-text-main-light'"
            >{{ q.name }}</option>
          </select>
          <font-awesome-icon
            icon="chevron-down"
            class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] opacity-60"
          />
        </div>
      </div>

      <div class="flex min-w-0 flex-1 items-center gap-2">
        <font-awesome-icon icon="magnifying-glass" class="opacity-60" />
        <input
          v-model="search"
          type="text"
          :placeholder="$t('graph.searchPlaceholder')"
          class="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm outline-none"
          @keydown.enter="onRun"
        />
      </div>

      <button
        type="button"
        :disabled="!canRun"
        :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
        class="inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-semibold transition hover:opacity-90 disabled:opacity-40"
        @click="onRun"
      >
        <font-awesome-icon :icon="state === 'loading' ? 'spinner' : 'bolt'" :spin="state === 'loading'" />
        {{ $t('graph.run') }}
      </button>

      <p v-if="selectedDescription" class="hidden truncate text-xs opacity-50 xl:block">{{ selectedDescription }}</p>
    </div>

    <!-- Canvas + state overlays -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="relative min-h-0 flex-1 overflow-hidden rounded-lg border"
    >
      <div ref="container" class="h-full w-full"></div>

      <div
        v-if="state !== 'ready'"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
        :class="darkMode ? 'bg-primary-bg-dark/80' : 'bg-primary-bg-light/80'"
      >
        <template v-if="state === 'loading'">
          <font-awesome-icon icon="spinner" spin class="text-2xl opacity-60" />
          <p class="text-sm opacity-60">{{ $t('graph.loading') }}</p>
        </template>
        <template v-else-if="state === 'idle'">
          <font-awesome-icon icon="diagram-project" class="text-2xl opacity-40" />
          <p class="text-sm font-semibold">{{ $t('graph.idleTitle') }}</p>
          <p class="max-w-md text-xs opacity-60">{{ $t('graph.idleHint') }}</p>
        </template>
        <template v-else-if="state === 'empty'">
          <font-awesome-icon icon="diagram-project" class="text-2xl opacity-40" />
          <p class="text-sm font-semibold">{{ $t('graph.emptyTitle') }}</p>
          <p class="max-w-md text-xs opacity-60">{{ $t('graph.emptyHint') }}</p>
        </template>
        <template v-else-if="state === 'unavailable'">
          <font-awesome-icon icon="triangle-exclamation" class="text-2xl text-warn-dark" />
          <p class="text-sm font-semibold">{{ $t('graph.unavailableTitle') }}</p>
          <p class="max-w-md text-xs opacity-60">{{ $t('graph.unavailableHint') }}</p>
        </template>
        <template v-else-if="state === 'gated'">
          <font-awesome-icon icon="lock" class="text-2xl opacity-50" />
          <p class="text-sm font-semibold">{{ $t('graph.gatedTitle') }}</p>
          <p class="max-w-md text-xs opacity-60">{{ $t('graph.gatedHint') }}</p>
        </template>
        <template v-else-if="state === 'auth'">
          <font-awesome-icon icon="right-to-bracket" class="text-2xl opacity-50" />
          <p class="text-sm">{{ $t('graph.authHint') }}</p>
        </template>
        <template v-else>
          <font-awesome-icon icon="triangle-exclamation" class="text-2xl text-warn-dark" />
          <p class="max-w-md text-xs opacity-70">{{ errorMsg || $t('graph.errorHint') }}</p>
        </template>
      </div>
    </div>
  </div>
</template>
