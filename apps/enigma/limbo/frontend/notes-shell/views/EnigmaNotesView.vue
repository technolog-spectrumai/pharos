<script setup lang="ts">
// Notes tab: a single home for the three note-like workspaces — the group Board
// (kanban), the freeform Sketch board, and the Mind map. Each was its own
// top-level tab; they're gathered here under a sub-tab pill bar (the same pattern
// EnigmaConfigView uses), so the nav stays lean. The three child views are mounted
// as-is — this view only owns the tab bar and the full-height frame; each child
// keeps its own controls, modals, and (for Mind) its own inner sub-tabs.
//
// Build flags gate each sub-tab independently: a disabled feature's button is
// hidden and its child never mounts. The router's `/notes` guard hides the whole
// tab when all three are off, so at least one is always enabled when we get here.
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import { getBuildConfig } from "rakotis";
import EnigmaKanbanView from "./EnigmaKanbanView.vue";
import EnigmaSketchView from "./EnigmaSketchView.vue";
import EnigmaMindView from "./EnigmaMindView.vue";

defineProps<{ darkMode?: boolean }>();

const route = useRoute();
const buildCfg = getBuildConfig();

// Fixed display order; `enabled` mirrors the per-feature build flags.
const ORDER = ["board", "sketch", "mind"] as const;
type NotesTab = (typeof ORDER)[number];
const enabled: Record<NotesTab, boolean> = {
  board: buildCfg.kanban_enabled,
  sketch: buildCfg.sketch_enabled,
  mind: buildCfg.mind_enabled,
};
const TAB_META: Record<NotesTab, { icon: string; label: string }> = {
  board: { icon: "table-columns", label: "nav.board" },
  sketch: { icon: "pencil", label: "nav.sketch" },
  mind: { icon: "diagram-project", label: "nav.mind" },
};

const firstEnabled = (): NotesTab => ORDER.find((t) => enabled[t]) ?? "board";

// `?tab=` selects a sub-tab (nav redirects from /board /sketch /mind use it). An
// unknown or disabled value falls back to the first enabled sub-tab.
function tabFromQuery(q: unknown): NotesTab {
  return typeof q === "string" && (ORDER as readonly string[]).includes(q) && enabled[q as NotesTab]
    ? (q as NotesTab)
    : firstEnabled();
}

const activeTab = ref<NotesTab>(tabFromQuery(route.query.tab));
// Re-sync when a nav link changes ?tab while this view is already mounted.
watch(() => route.query.tab, (tab) => { activeTab.value = tabFromQuery(tab); });
</script>

<template>
  <div class="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col gap-3">
    <!-- Sub-tab bar (EnigmaConfigView pill pattern) -->
    <div
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex gap-1 rounded-xl border p-1 text-sm font-semibold"
    >
      <button
        v-for="tab in ORDER"
        v-show="enabled[tab]"
        :key="tab"
        type="button"
        :class="activeTab === tab
          ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
          : 'opacity-60 hover:opacity-100'"
        class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 transition"
        @click="activeTab = tab"
      >
        <font-awesome-icon :icon="TAB_META[tab].icon" />{{ $t(TAB_META[tab].label) }}
      </button>
    </div>

    <!-- Active workspace fills the remaining height -->
    <div class="flex min-h-0 flex-1 flex-col">
      <EnigmaKanbanView v-if="activeTab === 'board' && enabled.board" :dark-mode="darkMode" />
      <EnigmaSketchView v-else-if="activeTab === 'sketch' && enabled.sketch" :dark-mode="darkMode" />
      <EnigmaMindView v-else-if="activeTab === 'mind' && enabled.mind" :dark-mode="darkMode" />
    </div>
  </div>
</template>
