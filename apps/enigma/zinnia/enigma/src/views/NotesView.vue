<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useNotesStore } from "../stores/notes";
import type { NoteBox } from "../services/api";

const props = defineProps<{ darkMode: boolean }>();

const store = useNotesStore();
const {
  boxes, selectedBox, links, references, graphNodes, graphEdges,
  loading, graphLoading, error,
  online, syncing, pendingCount, lastSyncedAt,
} = storeToRefs(store);

// ── UI state ──────────────────────────────────────────────────────────────────
const search = ref("");
type Panel = "detail" | "graph" | "links" | "references";
const activePanel = ref<Panel>("detail");
const isReadOnly = ref(false);
const editLabel = ref("");
const editBody = ref("");
const saving = ref(false);
const confirmDelete = ref(false);
const showAddLink = ref(false);
const linkSearch = ref("");
const linkLabel = ref("");
const linkTarget = ref<NoteBox | null>(null);
const linkSearchResults = computed(() =>
  linkSearch.value.trim().length < 2
    ? []
    : boxes.value
        .filter(b => b.id !== selectedBox.value?.id &&
          (b.label.toLowerCase().includes(linkSearch.value.toLowerCase()) ||
           (b.properties?.body ?? "").toLowerCase().includes(linkSearch.value.toLowerCase())))
        .slice(0, 8)
);

// Client-side search — works offline over the cached set.
const filteredBoxes = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return boxes.value;
  return boxes.value.filter(
    (b) =>
      b.label.toLowerCase().includes(q) ||
      (b.properties?.body ?? "").toString().toLowerCase().includes(q),
  );
});

// Properties shown verbatim in the editor (body/source/quote) — everything else
// in the bag is surfaced as raw custom properties.
const WELL_KNOWN_PROPS = ["body", "source_title", "source_url", "source_type", "quote"];
const extraProperties = computed<Record<string, unknown>>(() => {
  const props = selectedBox.value?.properties ?? {};
  return Object.fromEntries(
    Object.entries(props).filter(([k]) => !WELL_KNOWN_PROPS.includes(k)),
  );
});

// ── Cytoscape ─────────────────────────────────────────────────────────────────
const graphContainer = ref<HTMLElement | null>(null);
let cy: any = null;

// ── Watch box selection ───────────────────────────────────────────────────────
watch(selectedBox, (box) => {
  if (box) {
    editLabel.value = box.label;
    editBody.value = box.properties?.body ?? "";
    isReadOnly.value = false;
    confirmDelete.value = false;
    showAddLink.value = false;
  }
});

// ── Watch graph panel ─────────────────────────────────────────────────────────
watch(activePanel, async (panel) => {
  if (panel === "graph") {
    await store.fetchGraph();
    await nextTick();
    renderGraph();
  }
});

watch([graphNodes, graphEdges], () => {
  if (activePanel.value === "graph") nextTick(renderGraph);
});

watch(() => props.darkMode, () => {
  if (activePanel.value === "graph") nextTick(renderGraph);
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  store.init();
  // Reflect browser connectivity changes in the sync indicator.
  window.addEventListener("online", onBrowserOnline);
  window.addEventListener("offline", onBrowserOffline);
});
onUnmounted(() => {
  window.removeEventListener("online", onBrowserOnline);
  window.removeEventListener("offline", onBrowserOffline);
});
function onBrowserOnline() { online.value = true; }
function onBrowserOffline() { online.value = false; }

// ── Sync ──────────────────────────────────────────────────────────────────────
async function doSync() {
  await store.sync().catch(() => {});
}
function syncLabel(): string {
  if (syncing.value) return "Syncing…";
  if (pendingCount.value > 0) return `Sync (${pendingCount.value})`;
  return "Sync";
}
function lastSyncedText(): string {
  if (!lastSyncedAt.value) return "never synced";
  const d = new Date(lastSyncedAt.value);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "synced just now";
  if (mins < 60) return `synced ${mins}m ago`;
  return `synced ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function newNote() {
  await store.createBox("New Note", "");
}

async function save() {
  if (!selectedBox.value || isReadOnly.value) return;
  saving.value = true;
  try {
    // Merge into the existing properties bag so source/quote/custom keys survive.
    await store.saveBox(selectedBox.value.id, {
      label: editLabel.value,
      properties: { ...(selectedBox.value.properties ?? {}), body: editBody.value },
    });
  } finally {
    saving.value = false;
  }
}

async function del() {
  if (!selectedBox.value) return;
  await store.removeBox(selectedBox.value.id);
  confirmDelete.value = false;
}

async function addLink() {
  if (!selectedBox.value || !linkTarget.value) return;
  await store.addLink(selectedBox.value.id, linkTarget.value.id, linkLabel.value.trim());
  linkTarget.value = null;
  linkSearch.value = "";
  linkLabel.value = "";
  showAddLink.value = false;
}

async function removeLink(id: number) {
  await store.removeLink(id);
}

async function removeReference(id: number) {
  await store.removeReference(id);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── Cytoscape graph ───────────────────────────────────────────────────────────
function renderGraph() {
  const container = graphContainer.value;
  if (!container) return;
  if (typeof (window as any).cytoscape === "undefined") {
    loadCytoscape().then(renderGraph);
    return;
  }
  if (cy) { cy.destroy(); cy = null; }

  const dark = props.darkMode;
  const bg     = dark ? "#0a0c11" : "#f2f3f5";
  const node   = dark ? "#131929" : "#ffffff";
  const border = dark ? "#4f5fa1" : "#2f3d63";
  const text   = dark ? "#d3d7e0" : "#0f1114";
  const accent = dark ? "#7b9cff" : "#2f5bf7";

  container.style.backgroundColor = bg;

  const elements = [
    ...graphNodes.value.map((n: any) => ({
      data: {
        id: n.id,
        label: (n.label ?? "Untitled").slice(0, 28),
        real_id: n.real_id ?? null,
        node_type: n.node_type ?? "box",
        selected_box: n.real_id != null && selectedBox.value?.id === n.real_id,
      }
    })),
    ...graphEdges.value.map((e: any) => ({
      data: {
        id: e.id,
        source: e.source ?? String(e.from_box),
        target: e.target ?? String(e.to_box),
        label: e.label ?? "",
        edge_type: e.edge_type ?? "link",
      }
    })),
  ];

  cy = (window as any).cytoscape({
    container,
    elements,
    wheelSensitivity: 0.2,
    style: [
      {
        // Default: note box — rounded rectangle
        selector: "node",
        style: {
          "shape": "round-rectangle",
          "background-color": node,
          "border-color": border,
          "border-width": 1.5,
          "label": "data(label)",
          "color": text,
          "font-size": 10,
          "text-wrap": "ellipsis",
          "text-max-width": 130,
          "text-valign": "center",
          "text-halign": "center",
          "width": 150,
          "height": 44,
          "cursor": "pointer",
        }
      },
      {
        // Category node — plain ellipse
        selector: "node[node_type = 'category']",
        style: {
          "shape": "ellipse",
          "width": 120,
          "height": 40,
          "font-size": 9,
          "font-style": "italic",
          "cursor": "default",
        }
      },
      {
        // Reference node — external object (hexagon)
        selector: "node[node_type = 'reference']",
        style: {
          "shape": "hexagon",
          "border-color": accent,
          "border-width": 2,
          "border-style": "dashed",
          "font-style": "italic",
          "width": 150,
          "height": 48,
        }
      },
      {
        selector: "node[?selected_box]",
        style: { "background-color": accent, "color": dark ? "#0a0c11" : "#fff", "border-width": 0 }
      },
      {
        selector: "node:selected",
        style: { "background-color": accent, "color": dark ? "#0a0c11" : "#fff", "border-width": 0 }
      },
      {
        // IdeaLink edge — solid with arrow
        selector: "edge[edge_type = 'link']",
        style: {
          "width": 1.5,
          "line-color": border,
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "target-arrow-color": border,
          "label": "data(label)",
          "font-size": 8,
          "color": text,
          "text-opacity": 0.6,
          "text-background-color": bg,
          "text-background-opacity": 0.85,
          "text-background-padding": "2px",
        }
      },
      {
        // Category membership edge — subtle dashed, no arrow
        selector: "edge[edge_type = 'category']",
        style: {
          "width": 1,
          "line-color": border,
          "line-style": "dashed",
          "curve-style": "bezier",
          "target-arrow-shape": "none",
          "opacity": 0.4,
        }
      },
      {
        // Reference edge — box → external object, dashed accent with arrow
        selector: "edge[edge_type = 'reference']",
        style: {
          "width": 1.5,
          "line-color": accent,
          "line-style": "dashed",
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "target-arrow-color": accent,
          "label": "data(label)",
          "font-size": 8,
          "color": text,
          "text-opacity": 0.6,
          "text-background-color": bg,
          "text-background-opacity": 0.85,
          "text-background-padding": "2px",
        }
      },
    ],
    layout: {
      name: "cose",
      animate: false,
      randomize: true,
      nodeRepulsion: 6000,
      idealEdgeLength: 120,
      padding: 20,
      fit: true,
    },
  });

  cy.on("tap", "node", (evt: any) => {
    const d = evt.target.data();
    if (d.node_type === "category") return;
    const realId = d.real_id;
    const box = (graphNodes.value as any[]).find((n: any) => n.real_id === realId);
    if (box) {
      const fullBox = store.boxes.find(b => b.id === realId);
      if (fullBox) store.selectBox(fullBox);
    }
  });
}

async function loadCytoscape() {
  if ((window as any).cytoscape) return;
  return new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js";
    script.onload = () => resolve();
    document.head.appendChild(script);
  });
}
</script>

<template>
  <div class="flex h-[calc(100vh-9rem)] w-full gap-3 overflow-hidden">

    <!-- ── Sidebar ──────────────────────────────────────────────────────────── -->
    <aside
      :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
      class="flex w-64 shrink-0 flex-col rounded-xl border shadow-md overflow-hidden"
    >
      <!-- Search + New -->
      <div class="shrink-0 border-b border-current/10 p-3 space-y-2">
        <div class="flex gap-1.5">
          <div class="relative flex-1">
            <font-awesome-icon icon="magnifying-glass" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs opacity-50" />
            <input
              v-model="search"
              type="text"
              placeholder="Search…"
              :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
              class="w-full rounded-lg border py-1.5 pl-7 pr-2 text-xs outline-none"
            />
          </div>
          <button
            @click="newNote"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="rounded-lg px-2.5 text-xs font-bold transition hover:opacity-90"
            title="New note"
          >
            <font-awesome-icon icon="plus" />
          </button>
        </div>
        <!-- Panel toggle -->
        <div class="grid grid-cols-2 gap-1">
          <button
            v-for="p in ([
              ['detail', 'sticky-note', 'Note'],
              ['graph', 'diagram-project', 'Graph'],
              ['links', 'link', 'Links'],
              ['references', 'arrow-up-right-from-square', 'Refs'],
            ] as [Panel, string, string][])"
            :key="p[0]"
            @click="activePanel = p[0]"
            :class="activePanel === p[0]
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
              : 'border border-current/20 opacity-60 hover:opacity-100'"
            class="rounded-lg py-1 text-xs font-semibold transition"
          >
            <font-awesome-icon :icon="p[1]" class="mr-1" />{{ p[2] }}
          </button>
        </div>
      </div>

      <!-- Note list -->
      <div v-if="loading && boxes.length === 0" class="flex flex-1 items-center justify-center opacity-40 text-xs">Loading…</div>
      <div v-else-if="filteredBoxes.length === 0" class="flex flex-1 items-center justify-center opacity-40 text-xs">{{ search ? 'No matches' : 'No notes' }}</div>
      <ul v-else class="flex-1 overflow-y-auto divide-y divide-current/5">
        <li
          v-for="box in filteredBoxes"
          :key="box.id"
          @click="store.selectBox(box); activePanel = 'detail'"
          :class="[
            'cursor-pointer px-3 py-2.5 transition hover:opacity-80',
            selectedBox?.id === box.id
              ? (darkMode ? 'bg-accent-dark/20' : 'bg-accent-light/20')
              : ''
          ]"
        >
          <div class="flex items-center gap-1.5 min-w-0">
            <font-awesome-icon icon="sticky-note" class="text-xs opacity-40 shrink-0" />
            <span class="truncate text-xs font-semibold">{{ box.label || "Untitled" }}</span>
            <font-awesome-icon v-if="box.is_locked" icon="lock" class="text-xs opacity-40 ml-auto shrink-0" />
          </div>
          <p class="mt-0.5 truncate text-xs opacity-35">{{ box.properties?.body?.slice(0, 48) || "—" }}</p>
        </li>
      </ul>

      <!-- Sync status + button -->
      <div class="shrink-0 border-t border-current/10 p-2 space-y-1.5">
        <div class="flex items-center gap-2 px-1">
          <span
            :class="online ? 'bg-green-400' : 'bg-amber-400'"
            class="h-2 w-2 rounded-full shrink-0"
            :title="online ? 'Online' : 'Offline'"
          />
          <span class="text-[10px] opacity-50 truncate flex-1">
            {{ online ? 'Online' : 'Offline' }} · {{ lastSyncedText() }}
          </span>
        </div>
        <button
          @click="doSync"
          :disabled="syncing"
          :class="pendingCount > 0
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
            : 'border border-current/20 opacity-70 hover:opacity-100'"
          class="w-full rounded-lg py-1.5 text-xs font-semibold transition disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <font-awesome-icon :icon="syncing ? 'spinner' : 'rotate-right'" :spin="syncing" />
          {{ syncLabel() }}
        </button>
      </div>

      <!-- Stats footer -->
      <div class="shrink-0 border-t border-current/10 px-3 py-2 text-xs opacity-50 grid grid-cols-3 gap-1">
        <span>{{ boxes.length }} notes</span>
        <span>{{ links.length }} links</span>
        <span>{{ references.length }} refs</span>
      </div>
    </aside>

    <!-- ── Main content (detail or graph) ───────────────────────────────────── -->
    <div class="flex flex-1 gap-3 min-w-0 overflow-hidden">

      <!-- GRAPH PANEL -->
      <template v-if="activePanel === 'graph'">
        <div
          :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
          class="flex-1 rounded-xl border shadow-md overflow-hidden relative"
        >
          <div v-if="graphLoading" class="absolute inset-0 flex items-center justify-center opacity-40">
            <font-awesome-icon icon="spinner" spin class="text-2xl" />
          </div>
          <div ref="graphContainer" class="w-full h-full" />
          <div class="absolute bottom-3 right-3 text-xs opacity-40 pointer-events-none">
            {{ graphNodes.length }} nodes · {{ graphEdges.length }} edges · click node to open
          </div>
        </div>
      </template>

      <!-- LINKS PANEL (all idea-links) -->
      <template v-else-if="activePanel === 'links'">
        <div
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="flex flex-1 flex-col rounded-xl border shadow-md overflow-hidden"
        >
          <div class="shrink-0 border-b border-current/10 px-4 py-3 flex items-center gap-2">
            <font-awesome-icon icon="link" class="opacity-60" />
            <h3 class="text-sm font-bold">All links</h3>
            <span class="text-xs opacity-40">{{ links.length }}</span>
          </div>
          <div v-if="links.length === 0" class="flex flex-1 items-center justify-center opacity-40 text-sm">No links yet.</div>
          <ul v-else class="flex-1 overflow-y-auto divide-y divide-current/5">
            <li
              v-for="link in links"
              :key="link.id"
              class="flex items-center gap-2 px-4 py-2.5 text-xs hover:bg-current/3 transition"
            >
              <button
                @click="store.selectBox(store.boxes.find(b => b.id === link.from_box) ?? ({ id: link.from_box, label: link.from_box_label } as any)); activePanel = 'detail'"
                :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                class="font-semibold truncate max-w-[32%] text-left hover:underline"
              >{{ link.from_box_label }}</button>
              <span class="opacity-40 shrink-0">
                <font-awesome-icon icon="arrow-right" class="text-[9px]" />
                <span class="italic mx-1">{{ link.label }}</span>
                <font-awesome-icon icon="arrow-right" class="text-[9px]" />
              </span>
              <button
                @click="store.selectBox(store.boxes.find(b => b.id === link.to_box) ?? ({ id: link.to_box, label: link.to_box_label } as any)); activePanel = 'detail'"
                :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                class="font-semibold truncate max-w-[32%] text-left hover:underline"
              >{{ link.to_box_label }}</button>
              <button
                @click="removeLink(link.id)"
                class="ml-auto shrink-0 opacity-40 hover:opacity-100 hover:text-red-400 transition"
                title="Delete link"
              >
                <font-awesome-icon icon="trash" />
              </button>
            </li>
          </ul>
        </div>
      </template>

      <!-- REFERENCES PANEL (bento node → external toto object) -->
      <template v-else-if="activePanel === 'references'">
        <div
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="flex flex-1 flex-col rounded-xl border shadow-md overflow-hidden"
        >
          <div class="shrink-0 border-b border-current/10 px-4 py-3 flex items-center gap-2">
            <font-awesome-icon icon="arrow-up-right-from-square" class="opacity-60" />
            <h3 class="text-sm font-bold">References</h3>
            <span class="text-xs opacity-40">{{ references.length }}</span>
          </div>
          <div v-if="references.length === 0" class="flex flex-1 flex-col items-center justify-center opacity-40 text-sm gap-1 px-6 text-center">
            <font-awesome-icon icon="arrow-up-right-from-square" class="text-2xl" />
            <p>No references.</p>
            <p class="text-xs">Notes can reference toto objects (missions, events, people, places). Create them in toto.</p>
          </div>
          <ul v-else class="flex-1 overflow-y-auto divide-y divide-current/5">
            <li
              v-for="ref in references"
              :key="ref.id"
              class="flex items-center gap-2 px-4 py-2.5 text-xs hover:bg-current/3 transition"
            >
              <button
                @click="store.selectBox(store.boxes.find(b => b.id === ref.box) ?? ({ id: ref.box, label: ref.box_label } as any)); activePanel = 'detail'"
                :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                class="font-semibold truncate max-w-[28%] text-left hover:underline"
              >{{ ref.box_label }}</button>
              <span class="opacity-40 shrink-0 italic">{{ ref.label }}</span>
              <font-awesome-icon icon="arrow-right" class="text-[9px] opacity-40 shrink-0" />
              <span class="font-semibold truncate flex-1 min-w-0">{{ ref.subject_label }}</span>
              <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                class="shrink-0 rounded border px-1.5 py-0.5 uppercase tracking-wide text-[10px] opacity-60">
                {{ ref.model }}
              </span>
              <button
                @click="removeReference(ref.id)"
                class="shrink-0 opacity-40 hover:opacity-100 hover:text-red-400 transition"
                title="Delete reference"
              >
                <font-awesome-icon icon="trash" />
              </button>
            </li>
          </ul>
        </div>
      </template>

      <!-- DETAIL PANEL -->
      <template v-else>
        <!-- No selection -->
        <div
          v-if="!selectedBox"
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="flex flex-1 flex-col items-center justify-center rounded-xl border shadow-md opacity-40 gap-3"
        >
          <font-awesome-icon icon="sticky-note" class="text-4xl" />
          <p class="text-sm">Select or create a note</p>
        </div>

        <!-- Note editor -->
        <template v-else>
          <div
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="flex flex-1 flex-col rounded-xl border shadow-md overflow-hidden min-w-0"
          >
            <!-- Title bar -->
            <div class="shrink-0 border-b border-current/10 px-4 py-3 space-y-2">
              <!-- Breadcrumb -->
              <div class="flex items-center gap-2 text-xs opacity-50">
                <font-awesome-icon icon="sticky-note" />
                <span>Note</span>
                <span v-if="selectedBox.category_name" class="ml-1 rounded border border-current/20 px-1.5 py-0.5">{{ selectedBox.category_name }}</span>
              </div>

              <!-- Label input -->
              <input
                v-model="editLabel"
                :disabled="isReadOnly"
                type="text"
                placeholder="Title…"
                :class="darkMode ? 'bg-transparent text-text-main-dark' : 'bg-transparent text-text-main-light'"
                class="w-full text-xl font-bold outline-none disabled:opacity-60"
              />

              <!-- Meta row -->
              <div class="flex flex-wrap items-center gap-3 text-xs opacity-50">
                <span>Created {{ formatDate(selectedBox.created_at) }}</span>
                <span>Updated {{ formatDate(selectedBox.updated_at) }}</span>
                <!-- Read-only toggle -->
                <button
                  @click="isReadOnly = !isReadOnly"
                  :class="isReadOnly
                    ? (darkMode ? 'bg-accent-dark/20 text-accent-dark' : 'bg-accent-light/20 text-accent-light')
                    : 'opacity-50 hover:opacity-80'"
                  class="ml-auto flex items-center gap-1 rounded px-2 py-0.5 transition"
                  :title="isReadOnly ? 'Click to enable editing' : 'Click to lock (read-only)'"
                >
                  <font-awesome-icon :icon="isReadOnly ? 'lock' : 'lock-open'" />
                  {{ isReadOnly ? "Read-only" : "Editable" }}
                </button>
              </div>
            </div>

            <!-- Body -->
            <textarea
              v-model="editBody"
              :disabled="isReadOnly"
              :class="darkMode ? 'bg-transparent text-text-main-dark placeholder-white/30' : 'bg-transparent text-text-main-light placeholder-black/30'"
              class="flex-1 resize-none p-4 text-sm leading-relaxed outline-none disabled:opacity-60 min-h-0"
              placeholder="Write your note…"
            />

            <!-- Source + Quote row -->
            <div class="shrink-0 grid grid-cols-2 gap-3 border-t border-current/10 px-4 py-3">
              <div
                :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
                class="rounded-lg border p-3"
              >
                <p class="text-xs font-bold opacity-60 mb-1.5 flex items-center gap-1">
                  <font-awesome-icon icon="book-open" />
                  Source
                </p>
                <p v-if="selectedBox.properties?.source_title" class="text-xs font-semibold">{{ selectedBox.properties.source_title }}</p>
                <p v-else class="text-xs opacity-40">No source.</p>
                <p v-if="selectedBox.properties?.source_type" class="text-xs opacity-50 mt-0.5">{{ selectedBox.properties.source_type }}</p>
              </div>
              <div
                :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
                class="rounded-lg border p-3"
              >
                <p class="text-xs font-bold opacity-60 mb-1.5 flex items-center gap-1">
                  <font-awesome-icon icon="quote-left" />
                  Quote
                </p>
                <p v-if="selectedBox.properties?.quote" class="text-xs italic">{{ selectedBox.properties.quote }}</p>
                <p v-else class="text-xs opacity-40">No quote.</p>
              </div>
            </div>

            <!-- Custom properties (everything beyond the well-known keys) -->
            <div
              v-if="Object.keys(extraProperties).length"
              :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
              class="shrink-0 border-t px-4 py-3"
            >
              <p class="text-xs font-bold opacity-60 mb-2 flex items-center gap-1">
                <font-awesome-icon icon="code" />
                Properties
              </p>
              <pre
                :class="darkMode ? 'bg-primary-bg-dark text-text-main-dark' : 'bg-primary-bg-light text-text-main-light'"
                class="rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap"
              >{{ JSON.stringify(extraProperties, null, 2) }}</pre>
            </div>

            <!-- Action bar -->
            <div class="shrink-0 flex items-center justify-between border-t border-current/10 px-4 py-2.5">
              <template v-if="!confirmDelete">
                <button
                  @click="confirmDelete = true"
                  class="rounded-lg border border-current/20 px-3 py-1.5 text-xs opacity-60 transition hover:opacity-100"
                >
                  <font-awesome-icon icon="trash" /> Delete
                </button>
              </template>
              <template v-else>
                <div class="flex items-center gap-2">
                  <span class="text-xs opacity-60">Delete this note?</span>
                  <button @click="confirmDelete = false" class="rounded-lg border border-current/20 px-2 py-1 text-xs transition">Cancel</button>
                  <button @click="del" class="rounded-lg bg-red-500 px-2 py-1 text-xs text-white font-bold">Yes</button>
                </div>
              </template>
              <button
                v-if="!isReadOnly"
                @click="save"
                :disabled="saving"
                :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                class="rounded-lg px-4 py-1.5 text-xs font-bold transition hover:opacity-90 disabled:opacity-50"
              >
                {{ saving ? "Saving…" : "Save" }}
              </button>
              <span v-else class="text-xs opacity-40 flex items-center gap-1">
                <font-awesome-icon icon="lock" /> Read-only
              </span>
            </div>
          </div>

          <!-- ── Links panel ───────────────────────────────────────────────── -->
          <div
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="flex w-64 shrink-0 flex-col rounded-xl border shadow-md overflow-hidden"
          >
            <!-- Links header -->
            <div class="shrink-0 border-b border-current/10 px-4 py-3">
              <h3 class="flex items-center gap-2 text-sm font-bold">
                <font-awesome-icon icon="link" class="opacity-60" />
                Links
              </h3>
              <div class="mt-2 flex gap-1.5">
                <button
                  @click="showAddLink = !showAddLink; linkSearch = ''; linkTarget = null; linkLabel = ''"
                  :class="darkMode ? 'border-accent-1 hover:bg-primary-bg-dark' : 'border-accent-2 hover:bg-primary-bg-light'"
                  class="flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold transition text-center"
                >
                  <font-awesome-icon icon="arrow-up-right-from-square" class="mr-1" />Link from this
                </button>
              </div>
            </div>

            <!-- Add link form -->
            <div v-if="showAddLink" class="shrink-0 border-b border-current/10 p-3 space-y-2">
              <input
                v-model="linkSearch"
                type="text"
                placeholder="Search target note…"
                :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
                autofocus
              />
              <!-- Search results -->
              <ul v-if="linkSearchResults.length" class="rounded-lg border border-current/10 divide-y divide-current/5 max-h-32 overflow-y-auto text-xs">
                <li
                  v-for="b in linkSearchResults"
                  :key="b.id"
                  @click="linkTarget = b; linkSearch = b.label"
                  :class="[
                    'cursor-pointer px-2 py-1.5 transition',
                    linkTarget?.id === b.id
                      ? (darkMode ? 'bg-accent-dark/20' : 'bg-accent-light/20')
                      : 'hover:opacity-80'
                  ]"
                >
                  <font-awesome-icon icon="sticky-note" class="opacity-40 mr-1" />
                  {{ b.label || "Untitled" }}
                </li>
              </ul>
              <input
                v-model="linkLabel"
                type="text"
                placeholder="Relation label (e.g. answered by)"
                :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
              />
              <div class="flex gap-1.5">
                <button
                  @click="addLink"
                  :disabled="!linkTarget"
                  :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                  class="flex-1 rounded-lg py-1.5 text-xs font-bold transition disabled:opacity-40"
                >
                  Create link
                </button>
                <button @click="showAddLink = false" class="rounded-lg border border-current/20 px-2 py-1.5 text-xs transition hover:opacity-80">✕</button>
              </div>
            </div>

            <!-- Links list -->
            <div class="flex-1 overflow-y-auto">
              <!-- Outgoing -->
              <div class="px-3 pt-3 pb-1">
                <p class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Outgoing</p>
                <div v-if="store.outgoingLinks(selectedBox.id).length === 0" class="text-xs opacity-35">No outgoing links.</div>
                <div
                  v-for="link in store.outgoingLinks(selectedBox.id)"
                  :key="link.id"
                  :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
                  class="rounded-lg border p-2.5 mb-2 space-y-1"
                >
                  <p class="text-xs opacity-50 italic">{{ link.label }}</p>
                  <button
                    @click="store.selectBox(store.boxes.find(b => b.id === link.to_box) ?? ({ id: link.to_box, label: link.to_box_label } as any))"
                    :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                    class="text-xs font-semibold text-left underline-offset-2 hover:underline"
                  >
                    {{ link.to_box_label }}
                  </button>
                  <button
                    @click="removeLink(link.id)"
                    class="flex items-center gap-1 text-xs opacity-40 transition hover:opacity-80 hover:text-red-400"
                  >
                    <font-awesome-icon icon="trash" class="text-xs" />
                    Delete link
                  </button>
                </div>
              </div>

              <!-- Incoming -->
              <div class="px-3 pt-1 pb-3">
                <p class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Incoming</p>
                <div v-if="store.incomingLinks(selectedBox.id).length === 0" class="text-xs opacity-35">No incoming links.</div>
                <div
                  v-for="link in store.incomingLinks(selectedBox.id)"
                  :key="link.id"
                  :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
                  class="rounded-lg border p-2.5 mb-2 space-y-1"
                >
                  <p class="text-xs opacity-50 italic">{{ link.label }}</p>
                  <button
                    @click="store.selectBox(store.boxes.find(b => b.id === link.from_box) ?? ({ id: link.from_box, label: link.from_box_label } as any))"
                    :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                    class="text-xs font-semibold text-left underline-offset-2 hover:underline"
                  >
                    {{ link.from_box_label }}
                  </button>
                  <button
                    @click="removeLink(link.id)"
                    class="flex items-center gap-1 text-xs opacity-40 transition hover:opacity-80 hover:text-red-400"
                  >
                    <font-awesome-icon icon="trash" class="text-xs" />
                    Delete link
                  </button>
                </div>
              </div>

              <!-- References (this box → external toto objects) -->
              <div v-if="store.boxReferences(selectedBox.id).length" class="px-3 pt-1 pb-3 border-t border-current/10">
                <p class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2 mt-2">References</p>
                <div
                  v-for="ref in store.boxReferences(selectedBox.id)"
                  :key="ref.id"
                  :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
                  class="rounded-lg border p-2.5 mb-2 space-y-1"
                >
                  <p class="text-xs opacity-50 italic">{{ ref.label }} · {{ ref.model }}</p>
                  <p class="text-xs font-semibold break-words">{{ ref.subject_label }}</p>
                  <button
                    @click="removeReference(ref.id)"
                    class="flex items-center gap-1 text-xs opacity-40 transition hover:opacity-80 hover:text-red-400"
                  >
                    <font-awesome-icon icon="trash" class="text-xs" />
                    Delete reference
                  </button>
                </div>
              </div>
            </div>

            <!-- Graph mini-stats footer -->
            <div
              :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
              class="shrink-0 border-t p-3"
            >
              <p class="text-xs font-bold opacity-60 mb-1 flex items-center gap-1">
                <font-awesome-icon icon="share-nodes" />
                Graph
              </p>
              <p class="text-xs opacity-50">{{ store.outgoingLinks(selectedBox.id).length + store.incomingLinks(selectedBox.id).length }} links total</p>
              <button
                @click="activePanel = 'graph'; store.fetchGraph()"
                :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                class="mt-1 text-xs underline-offset-2 hover:underline"
              >
                Open graph view →
              </button>
            </div>
          </div>
        </template>
      </template>
    </div>

    <div v-if="error" class="fixed bottom-4 right-4 rounded-lg bg-red-500/90 px-4 py-2 text-xs text-white shadow-lg">
      {{ error }}
    </div>
  </div>
</template>
