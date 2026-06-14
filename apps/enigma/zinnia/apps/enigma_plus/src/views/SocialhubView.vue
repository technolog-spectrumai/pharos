<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useSocialhubStore } from "../stores/socialhub";
import { api } from "../services/api";
import type { Profile, Community, OrgNode } from "../services/api";
import cytoscape from "cytoscape";

const props = defineProps<{ darkMode: boolean }>();

// ── Local list state (bypasses store to avoid HMR reactivity issues) ─────────
const profiles = ref<Profile[]>([]);
const communities = ref<Community[]>([]);
const profilesLoading = ref(false);
const communitiesLoading = ref(false);
const profilesError = ref<string | null>(null);
const communitiesError = ref<string | null>(null);

async function fetchProfiles() {
  profilesLoading.value = true;
  profilesError.value = null;
  try {
    const res = await api.getProfiles();
    profiles.value = res.profiles ?? [];
  } catch (e: any) {
    profilesError.value = e.message ?? "Failed to load profiles";
  } finally {
    profilesLoading.value = false;
  }
}

async function fetchCommunities() {
  communitiesLoading.value = true;
  communitiesError.value = null;
  try {
    const res = await api.getCommunities();
    communities.value = res.communities ?? [];
  } catch (e: any) {
    communitiesError.value = e.message ?? "Failed to load communities";
  } finally {
    communitiesLoading.value = false;
  }
}

onMounted(() => { fetchProfiles(); fetchCommunities(); });

// ── Detail panel (still uses store for selected state + org chart) ────────────
useSocialhubStore();
const selectedProfile = ref<Profile | null>(null);
const selectedCommunity = ref<Community | null>(null);
const orgChart = ref<OrgNode[] | null>(null);
const orgChartLoading = ref(false);

async function openProfile(slug: string) {
  try { selectedProfile.value = await api.getProfile(slug); selectedCommunity.value = null; } catch {}
}
async function openCommunity(slug: string) {
  try { selectedCommunity.value = await api.getCommunity(slug); selectedProfile.value = null; orgChart.value = null; } catch {}
}
function clearSelection() { selectedProfile.value = null; selectedCommunity.value = null; orgChart.value = null; }

const tab = ref<"people" | "communities">("people");

// ── Org chart modal ───────────────────────────────────────────────────────────
const chartOpen = ref(false);
const chartContainer = ref<HTMLElement | null>(null);
let cy: cytoscape.Core | null = null;

async function openChart(slug: string) {
  chartOpen.value = true;
  if (!orgChart.value) {
    orgChartLoading.value = true;
    try {
      const res = await api.getOrgChart(slug);
      orgChart.value = res.nodes;
    } finally {
      orgChartLoading.value = false;
    }
  }
  await nextTick();
  renderChart();
}

function closeChart() {
  chartOpen.value = false;
  cy?.destroy();
  cy = null;
}

function renderChart() {
  if (!chartContainer.value || !orgChart.value) return;
  cy?.destroy();
  if (!chartContainer.value || !orgChart.value) return;

  const dm = props.darkMode;
  const bgColor    = dm ? "#0a0c11" : "#f2f3f5";
  const bubbleColor = dm ? "#191f2d" : "#e8e9ec";
  const accentColor = dm ? "#4f5fa1" : "#2f3d63";
  const textColor  = dm ? "#d3d7e0" : "#0f1114";

  const elements: cytoscape.ElementDefinition[] = [];
  for (const n of orgChart.value) {
    elements.push({
      data: { id: n.id, label: n.name, sub: n.email || "" }
    });
    if (n.pid) {
      elements.push({
        data: { id: `${n.pid}-${n.id}`, source: n.pid, target: n.id }
      });
    }
  }

  cy = cytoscape({
    container: chartContainer.value,
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": bubbleColor,
          "border-color": accentColor,
          "border-width": 2,
          "label": "data(label)",
          "color": textColor,
          "font-size": 13,
          "text-wrap": "wrap",
          "text-valign": "center",
          "text-halign": "center",
          "width": 180,
          "height": 80,
          "shape": "round-rectangle",
          "font-family": "Orbitron, sans-serif",
        }
      },
      {
        selector: "edge",
        style: {
          "width": 2,
          "line-color": accentColor,
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "target-arrow-color": accentColor,
        }
      },
      {
        selector: "node:selected",
        style: {
          "border-color": dm ? "#7b9cff" : "#1a3a99",
          "border-width": 3,
        }
      }
    ],
    layout: {
      name: "breadthfirst",
      directed: true,
      roots: orgChart.value.filter(n => !n.pid).map(n => n.id),
      spacingFactor: 1.3,
      padding: 40,
      fit: true,
    } as any,
  });

  chartContainer.value.style.backgroundColor = bgColor;

  cy.on("tap", "node", (evt) => {
    const slug = orgChart.value?.find(n => n.id === evt.target.id())?.slug;
    if (slug) openProfile(slug);
  });
}

// Re-render when darkMode toggles while modal is open
watch(() => props.darkMode, () => {
  if (chartOpen.value) renderChart();
});

// Re-render when org chart data arrives
watch(orgChart, () => {
  if (chartOpen.value) nextTick(renderChart);
});

// Close on Escape
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && chartOpen.value) closeChart();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => { window.removeEventListener("keydown", onKeydown); cy?.destroy(); });

const ORG_TYPE_COLORS: Record<string, string> = {
  guild: "bg-purple-500/20 text-purple-400",
  company: "bg-blue-500/20 text-blue-400",
  non_profit: "bg-green-500/20 text-green-400",
  family: "bg-orange-500/20 text-orange-400",
  other: "bg-gray-500/20 text-gray-400",
};
</script>

<template>
  <div class="flex w-full h-[calc(100vh-9rem)] gap-4 overflow-hidden">

    <!-- Left panel -->
    <div class="flex flex-1 flex-col gap-4 overflow-hidden">

      <!-- Tabs + refresh -->
      <div class="flex items-center gap-1 shrink-0">
        <button @click="tab = 'people'; clearSelection()"
          :class="[
            'rounded-lg px-4 py-2 text-sm font-semibold border transition',
            tab === 'people'
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
              : 'border-current/20 opacity-60 hover:opacity-100'
          ]">
          <font-awesome-icon icon="users" class="mr-1.5" />People
        </button>
        <button @click="tab = 'communities'; clearSelection()"
          :class="[
            'rounded-lg px-4 py-2 text-sm font-semibold border transition',
            tab === 'communities'
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
              : 'border-current/20 opacity-60 hover:opacity-100'
          ]">
          <font-awesome-icon icon="building" class="mr-1.5" />Communities
        </button>
        <button
          @click="tab === 'people' ? fetchProfiles() : fetchCommunities()"
          :disabled="profilesLoading || communitiesLoading"
          class="ml-auto rounded-lg border border-current/20 px-3 py-2 text-xs opacity-60 hover:opacity-100 transition disabled:opacity-30"
          title="Refresh">
          <font-awesome-icon
            icon="rotate-right"
            :class="(profilesLoading || communitiesLoading) ? 'animate-spin' : ''" />
        </button>
      </div>

      <!-- People grid -->
      <div v-if="tab === 'people'" class="overflow-y-auto flex-1">
        <div v-if="profilesLoading" class="flex items-center justify-center py-16 opacity-50">
          <font-awesome-icon icon="spinner" spin class="text-2xl" />
        </div>
        <div v-else-if="profilesError" class="flex flex-col items-center justify-center py-16 gap-3">
          <p class="text-sm text-red-400">{{ profilesError }}</p>
          <button @click="fetchProfiles()"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="rounded-lg px-4 py-2 text-xs font-bold transition hover:opacity-90">
            <font-awesome-icon icon="rotate-right" class="mr-1" />Retry
          </button>
        </div>
        <div v-else-if="profiles.length === 0" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
          <font-awesome-icon icon="users" class="text-4xl" />
          <p class="text-sm">No people found</p>
        </div>
        <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <button v-for="p in profiles" :key="p.id"
            @click="openProfile(p.slug)"
            :class="[
              'flex flex-col items-center gap-2 rounded-xl border p-3 text-left transition hover:opacity-80',
              selectedProfile?.id === p.id
                ? (darkMode ? 'border-accent-dark bg-accent-dark/20' : 'border-accent-light bg-accent-light/20')
                : (darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2')
            ]">
            <img v-if="p.avatar_url" :src="p.avatar_url" :alt="p.display_name" class="h-14 w-14 rounded-full object-cover" />
            <div v-else class="flex h-14 w-14 items-center justify-center rounded-full bg-current/10">
              <font-awesome-icon icon="user" class="text-2xl opacity-40" />
            </div>
            <p class="text-xs font-semibold text-center truncate w-full">{{ p.display_name }}</p>
            <p class="text-xs opacity-40">{{ p.community_count }} comm.</p>
          </button>
        </div>
      </div>

      <!-- Communities grid -->
      <div v-else class="overflow-y-auto flex-1">
        <div v-if="communitiesLoading" class="flex items-center justify-center py-16 opacity-50">
          <font-awesome-icon icon="spinner" spin class="text-2xl" />
        </div>
        <div v-else-if="communitiesError" class="flex flex-col items-center justify-center py-16 gap-3">
          <p class="text-sm text-red-400">{{ communitiesError }}</p>
          <button @click="fetchCommunities()"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="rounded-lg px-4 py-2 text-xs font-bold transition hover:opacity-90">
            <font-awesome-icon icon="rotate-right" class="mr-1" />Retry
          </button>
        </div>
        <div v-else-if="communities.length === 0" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
          <font-awesome-icon icon="building" class="text-4xl" />
          <p class="text-sm">No communities found</p>
        </div>
        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="c in communities" :key="c.id"
            @click="openCommunity(c.slug)"
            :class="[
              'flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition hover:opacity-80',
              selectedCommunity?.id === c.id
                ? (darkMode ? 'border-accent-dark bg-accent-dark/20' : 'border-accent-light bg-accent-light/20')
                : (darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2')
            ]">
            <font-awesome-icon icon="building" class="mt-0.5 opacity-50 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold text-sm truncate">{{ c.name }}</p>
              <span :class="ORG_TYPE_COLORS[c.org_type] ?? 'bg-gray-500/20 text-gray-400'"
                class="mt-1 inline-block rounded px-2 py-0.5 text-xs">{{ c.org_type_label }}</span>
              <p class="mt-1 text-xs opacity-40">{{ c.member_count }} members</p>
            </div>
            <!-- Org chart button -->
            <button @click.stop="openChart(c.slug)"
              :class="darkMode ? 'border-accent-1 hover:bg-accent-dark/20 text-accent-dark' : 'border-accent-2 hover:bg-accent-light/20 text-accent-light'"
              class="shrink-0 self-center rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition"
              title="Org chart">
              <font-awesome-icon icon="diagram-project" class="mr-1" />Chart
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Mobile backdrop -->
    <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0" enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <div v-if="selectedProfile || selectedCommunity"
        class="fixed inset-0 z-30 bg-black/50 sm:hidden"
        @click="clearSelection()" />
    </Transition>

    <!-- Detail slide-in -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      enter-from-class="translate-x-8 opacity-0"
      enter-to-class="translate-x-0 opacity-100"
      leave-active-class="transition-all duration-150 ease-in"
      leave-from-class="translate-x-0 opacity-100"
      leave-to-class="translate-x-8 opacity-0"
    >
      <aside v-if="selectedProfile || selectedCommunity"
        :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="sm:w-72 sm:shrink-0 sm:rounded-xl sm:relative sm:inset-auto sm:z-auto
               fixed inset-x-0 bottom-0 z-40 max-h-[85vh] rounded-t-2xl
               border p-4 shadow-xl overflow-y-auto">

        <!-- Close button — prominent on mobile, subtle on desktop -->
        <div class="flex items-center justify-between mb-3">
          <button @click="clearSelection()"
            :class="darkMode ? 'border-accent-1 hover:bg-bubble-bg-dark' : 'border-accent-2 hover:bg-bubble-bg-light'"
            class="sm:hidden flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold transition">
            <font-awesome-icon icon="xmark" /> Close
          </button>
          <button @click="clearSelection()" class="hidden sm:block text-xs opacity-50 transition hover:opacity-100">
            <font-awesome-icon icon="xmark" /> Close
          </button>
          <!-- Drag handle hint on mobile -->
          <div class="sm:hidden w-10 h-1 rounded-full bg-current opacity-20 mx-auto absolute top-2 left-1/2 -translate-x-1/2" />
        </div>

        <!-- Profile detail -->
        <template v-if="selectedProfile">
          <div class="flex flex-col items-center gap-3 text-center">
            <img v-if="selectedProfile.avatar_url" :src="selectedProfile.avatar_url" class="h-20 w-20 rounded-full object-cover" />
            <div v-else class="flex h-20 w-20 items-center justify-center rounded-full bg-current/10">
              <font-awesome-icon icon="user" class="text-3xl opacity-40" />
            </div>
            <p class="font-bold text-lg">{{ selectedProfile.display_name }}</p>
            <p v-if="selectedProfile.full_name !== selectedProfile.display_name" class="text-sm opacity-60">{{ selectedProfile.full_name }}</p>
          </div>
          <div v-if="selectedProfile.communities?.length" class="mt-4">
            <p class="text-xs font-semibold opacity-60 mb-2">Communities</p>
            <ul class="space-y-1">
              <li v-for="c in selectedProfile.communities" :key="c.id" class="text-sm opacity-70 flex items-center gap-1.5">
                <font-awesome-icon icon="building" class="opacity-40 text-xs" />{{ c.name }}
              </li>
            </ul>
          </div>
        </template>

        <!-- Community detail -->
        <template v-if="selectedCommunity">
          <div class="flex flex-col items-center gap-2 text-center mb-4">
            <div class="flex h-16 w-16 items-center justify-center rounded-full bg-current/10">
              <font-awesome-icon icon="building" class="text-3xl opacity-40" />
            </div>
            <p class="font-bold text-lg">{{ selectedCommunity.name }}</p>
            <span :class="ORG_TYPE_COLORS[selectedCommunity.org_type] ?? ''"
              class="rounded px-2 py-0.5 text-xs">{{ selectedCommunity.org_type_label }}</span>
          </div>
          <div class="space-y-2 text-sm">
            <div v-if="selectedCommunity.head_name">
              <span class="opacity-50 text-xs">Head:</span>
              <span class="ml-1">{{ selectedCommunity.head_name }}</span>
            </div>
            <div><span class="opacity-50 text-xs">Members:</span> <span class="ml-1">{{ selectedCommunity.member_count }}</span></div>
            <div v-if="selectedCommunity.latest_news_title">
              <p class="text-xs opacity-50 mb-0.5">Latest news</p>
              <p class="text-xs">{{ selectedCommunity.latest_news_title }}</p>
            </div>
          </div>
          <div v-if="selectedCommunity.members?.length" class="mt-4">
            <p class="text-xs font-semibold opacity-60 mb-2">Senior Members</p>
            <ul class="space-y-1">
              <li v-for="m in selectedCommunity.members" :key="m.id" class="text-sm opacity-70 flex items-center gap-1.5">
                <font-awesome-icon icon="user" class="opacity-40 text-xs" />{{ m.name }}
              </li>
            </ul>
          </div>
          <!-- Org chart button -->
          <button @click="openChart(selectedCommunity.slug)"
            :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
            class="mt-4 w-full rounded-xl py-2 text-xs font-bold transition hover:opacity-90 flex items-center justify-center gap-2">
            <font-awesome-icon icon="diagram-project" />View Org Chart
          </button>
        </template>
      </aside>
    </Transition>

    <!-- ══════════════════════ ORG CHART FULLSCREEN MODAL ══════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-150 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="chartOpen"
        class="fixed inset-0 z-50 flex flex-col"
        :class="darkMode ? 'bg-primary-bg-dark text-text-main-dark' : 'bg-primary-bg-light text-text-main-light'">

        <!-- Modal toolbar -->
        <div :class="darkMode ? 'border-accent-1 bg-bubble-bg-dark' : 'border-accent-2 bg-bubble-bg-light'"
          class="flex items-center gap-3 border-b px-5 py-3 shrink-0">
          <font-awesome-icon icon="diagram-project" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
          <span class="font-bold text-sm">Org Chart</span>
          <span v-if="selectedCommunity" class="text-xs opacity-50">— {{ selectedCommunity.name }}</span>

          <div class="ml-auto flex items-center gap-2">
            <!-- Fit button -->
            <button @click="cy?.fit()" title="Fit to screen"
              :class="darkMode ? 'border-accent-1 hover:bg-bubble-bg-dark' : 'border-accent-2 hover:bg-bubble-bg-light'"
              class="rounded-lg border px-3 py-1.5 text-xs font-semibold transition">
              <font-awesome-icon icon="magnifying-glass" class="mr-1" />Fit
            </button>
            <!-- Close -->
            <button @click="closeChart()"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90">
              <font-awesome-icon icon="xmark" class="mr-1" />Close
            </button>
          </div>
        </div>

        <!-- Cytoscape container -->
        <div class="relative flex-1 overflow-hidden">
          <div v-if="orgChartLoading" class="absolute inset-0 flex items-center justify-center opacity-50 z-10">
            <font-awesome-icon icon="spinner" spin class="text-3xl" />
          </div>
          <div ref="chartContainer" class="w-full h-full" />
        </div>

        <!-- Hint -->
        <div :class="darkMode ? 'border-accent-1 bg-bubble-bg-dark' : 'border-accent-2 bg-bubble-bg-light'"
          class="border-t px-5 py-2 text-xs opacity-40 shrink-0">
          Scroll to zoom · Drag to pan · Click a node to view profile
        </div>
      </div>
    </Transition>

  </div>
</template>
