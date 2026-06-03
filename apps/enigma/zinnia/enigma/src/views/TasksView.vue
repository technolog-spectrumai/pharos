<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useTasksStore } from "../stores/tasks";
import type { KanbanTask, KanbanColumn, MissionDetail } from "../services/api";

const props = defineProps<{ darkMode: boolean }>();

const store = useTasksStore();
const {
  projects, selectedProject, tasks, missions, selectedMission,
  backlog, matrix,
  loading, missionsLoading, backlogLoading, matrixLoading, error,
} = storeToRefs(store);

// ── Tab ───────────────────────────────────────────────────────────────────────
type Tab = "board" | "backlog" | "missions" | "matrix";
const tab = ref<Tab>("board");

watch(tab, async (t) => {
  if (!selectedProject.value) return;
  if (t === "backlog" && !backlog.value)       await store.fetchBacklog();
  if (t === "missions" && !missions.value.length) await store.fetchMissions();
  if (t === "matrix" && !matrix.value)         await store.fetchMatrix();
});

onMounted(() => store.fetchProjects());

async function pickProject(p: any) {
  await store.selectProject(p);
  // reset lazy tabs
  store.backlog = null as any;
  store.matrix = null as any;
  store.missions = [] as any;
}

// ── Board ─────────────────────────────────────────────────────────────────────
const columns = computed(() => selectedProject.value?.columns ?? []);

// Task modal
const taskModal = ref<KanbanTask | null>(null);
const editTitle = ref("");
const editDesc = ref("");
const editWeight = ref(1);
const editDueDate = ref("");
const editColumnId = ref(0);
const confirmDeleteTask = ref(false);
const savingTask = ref(false);

function openTask(t: KanbanTask) {
  taskModal.value = t;
  editTitle.value = t.title;
  editDesc.value = t.description;
  editWeight.value = t.weight;
  editDueDate.value = t.due_date ?? "";
  editColumnId.value = t.column_id;
  confirmDeleteTask.value = false;
}
function closeTask() { taskModal.value = null; }

async function saveTask() {
  if (!taskModal.value) return;
  savingTask.value = true;
  try {
    await store.editTask(taskModal.value.id, {
      title: editTitle.value,
      description: editDesc.value,
      weight: editWeight.value,
      due_date: editDueDate.value || null,
      column_id: editColumnId.value,
    });
    closeTask();
  } finally { savingTask.value = false; }
}

async function deleteTaskConfirmed() {
  if (!taskModal.value) return;
  await store.removeTask(taskModal.value.id);
  closeTask();
}

// Add task inline per column
const addingToCol = ref<number | null>(null);
const newTaskTitle = ref<Record<number, string>>({});

async function submitAddTask(col: KanbanColumn) {
  const title = newTaskTitle.value[col.id]?.trim();
  if (!title) return;
  await store.addTask(col.id, title);
  newTaskTitle.value[col.id] = "";
  addingToCol.value = null;
}

// ── Missions detail ───────────────────────────────────────────────────────────
watch(tab, async (t) => {
  if (t === "missions") store.selectedMission = null as any;
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const WEIGHT_LABELS: Record<number, string> = { 1: "Tiny", 2: "Small", 3: "Medium", 5: "Big", 8: "Large" };
const WEIGHT_COLORS: Record<number, string> = {
  1: "bg-emerald-500/20 text-emerald-400",
  2: "bg-sky-500/20 text-sky-400",
  3: "bg-yellow-500/20 text-yellow-400",
  5: "bg-orange-500/20 text-orange-400",
  8: "bg-red-500/20 text-red-400",
};
const URGENCY_COLORS: Record<number, string> = { 1: "text-sky-400", 2: "text-yellow-400", 3: "text-red-400" };
const IMPACT_COLORS: Record<number, string>  = { 1: "text-sky-400", 2: "text-yellow-400", 3: "text-green-400" };
const URGENCY_LABELS = ["", "Low", "Medium", "High"];
const IMPACT_LABELS  = ["", "Low", "Medium", "High"];

function fmt(iso: string | null) { return iso ? new Date(iso).toLocaleDateString(undefined, { month:"short", day:"numeric" }) : "—"; }
</script>

<template>
  <div class="flex w-full flex-col gap-3 overflow-hidden" style="min-height:calc(100vh - 9rem)">

    <!-- ── Project selector ───────────────────────────────────────────────── -->
    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <span class="text-xs opacity-50">Project:</span>
      <button
        v-for="p in projects" :key="p.id"
        @click="pickProject(p)"
        :class="[
          'rounded-lg px-3 py-1 text-xs font-semibold border transition',
          selectedProject?.id === p.id
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'
        ]"
      >{{ p.name }}</button>
      <span v-if="!projects.length && !loading" class="text-xs opacity-40">No projects</span>
    </div>

    <!-- ── Tab bar ─────────────────────────────────────────────────────────── -->
    <div v-if="selectedProject" class="flex gap-1 shrink-0 flex-wrap">
      <button v-for="[key,icon,label] in [['board','columns','Board'],['backlog','list','Backlog'],['missions','bullseye','Missions'],['matrix','table-cells','Matrix']] as any"
        :key="key"
        @click="tab = key"
        :class="[
          'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border transition',
          tab === key
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'
        ]"
      >
        <font-awesome-icon :icon="icon" />{{ label }}
      </button>
    </div>

    <div v-if="error" class="shrink-0 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-400">{{ error }}</div>

    <!-- ── No project selected ────────────────────────────────────────────── -->
    <div v-if="!selectedProject && !loading"
      :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
      class="flex flex-1 flex-col items-center justify-center rounded-xl border shadow-md opacity-40 gap-3">
      <font-awesome-icon icon="table-columns" class="text-4xl" />
      <p class="text-sm">Select a project to view the board</p>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center opacity-40">
      <font-awesome-icon icon="spinner" spin class="text-2xl" />
    </div>

    <!-- ═══════════════════════════ BOARD ═══════════════════════════════════ -->
    <div v-else-if="selectedProject && tab === 'board'" class="flex gap-3 overflow-x-auto pb-2 flex-1" style="min-height:0">
      <div
        v-for="col in columns" :key="col.id"
        :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="flex w-64 shrink-0 flex-col rounded-xl border shadow-md overflow-hidden"
      >
        <!-- Column header -->
        <div class="flex items-center justify-between border-b border-current/10 px-3 py-2.5 shrink-0">
          <div class="flex items-center gap-2">
            <font-awesome-icon icon="layer-group" class="text-xs opacity-40" />
            <span class="text-xs font-bold uppercase tracking-wide">{{ col.name }}</span>
          </div>
          <span class="rounded-full px-2 py-0.5 text-xs opacity-50 border border-current/20">
            {{ store.tasksForColumn(col.id).length }}
          </span>
        </div>

        <!-- Task list -->
        <div class="flex-1 overflow-y-auto space-y-2 p-2">
          <div
            v-for="t in store.tasksForColumn(col.id)" :key="t.id"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
            class="rounded-lg border p-2.5 shadow-sm transition"
          >
            <p class="text-xs font-semibold leading-snug">{{ t.title }}</p>
            <div class="mt-2 flex flex-wrap items-center gap-1">
              <span :class="WEIGHT_COLORS[t.weight] ?? 'bg-gray-500/20 text-gray-400'"
                class="rounded px-1.5 py-0.5 text-xs font-mono">
                {{ t.weight_label || WEIGHT_LABELS[t.weight] }}
              </span>
              <span v-if="t.mission_title" class="rounded px-1.5 py-0.5 text-xs opacity-50 border border-current/15 truncate max-w-[100px]">
                {{ t.mission_title }}
              </span>
              <span v-if="t.assignee" class="text-xs opacity-40 truncate">
                <font-awesome-icon icon="user" class="text-xs" /> {{ t.assignee }}
              </span>
              <span v-if="t.due_date" class="text-xs opacity-40 ml-auto">{{ fmt(t.due_date) }}</span>
            </div>
            <!-- Progress / promote / edit buttons -->
            <div class="mt-2 flex items-center justify-between gap-1">
              <div class="flex gap-1">
                <button @click="store.demote(t.id)"
                  class="rounded border border-current/15 px-1.5 py-0.5 text-xs opacity-50 hover:opacity-100 transition" title="Demote">←</button>
                <button @click="store.promote(t.id)"
                  class="rounded border border-current/15 px-1.5 py-0.5 text-xs opacity-50 hover:opacity-100 transition" title="Promote">→</button>
              </div>
              <button @click="openTask(t)"
                :class="darkMode ? 'border-accent-1 text-accent-dark hover:bg-accent-dark hover:text-primary-bg-dark' : 'border-accent-2 text-accent-light hover:bg-accent-light hover:text-primary-bg-light'"
                class="flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-semibold transition">
                <font-awesome-icon icon="pencil" class="text-[10px]" /> Edit
              </button>
            </div>
          </div>
        </div>

        <!-- Add task -->
        <div class="shrink-0 border-t border-current/10 p-2">
          <template v-if="addingToCol === col.id">
            <input
              v-model="newTaskTitle[col.id]"
              @keydown.enter="submitAddTask(col)"
              @keydown.escape="addingToCol = null"
              type="text" placeholder="Task title…"
              :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
              class="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
              autofocus
            />
            <div class="mt-1.5 flex gap-1">
              <button @click="submitAddTask(col)"
                :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                class="flex-1 rounded-lg py-1 text-xs font-bold transition">Add</button>
              <button @click="addingToCol = null"
                class="rounded-lg border border-current/20 px-2 py-1 text-xs transition hover:opacity-80">✕</button>
            </div>
          </template>
          <button v-else @click="addingToCol = col.id"
            class="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-xs opacity-50 hover:opacity-100 transition">
            <font-awesome-icon icon="plus" />Add task
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════ BACKLOG ══════════════════════════════════ -->
    <template v-else-if="selectedProject && tab === 'backlog'">
      <div v-if="backlogLoading" class="flex flex-1 items-center justify-center opacity-40">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>
      <div v-else-if="backlog"
        :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="flex-1 rounded-xl border shadow-md overflow-hidden flex flex-col"
      >
        <!-- Header -->
        <div class="shrink-0 flex items-center justify-between border-b border-current/10 px-4 py-3">
          <div>
            <h3 class="text-sm font-bold flex items-center gap-2"><font-awesome-icon icon="list" class="opacity-60" /> Project backlog</h3>
            <p class="text-xs opacity-50 mt-0.5">Review missions, campaign context, priority signals, and linked tasks.</p>
          </div>
          <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="rounded-lg border px-3 py-1 text-xs opacity-70">
            <font-awesome-icon icon="bullseye" class="mr-1" />{{ backlog.total_missions }} missions
          </span>
        </div>
        <!-- Table -->
        <div class="flex-1 overflow-auto">
          <table class="w-full text-xs">
            <thead>
              <tr :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                class="border-b text-xs uppercase tracking-wide opacity-50">
                <th class="px-4 py-2.5 text-left">Mission</th>
                <th class="px-4 py-2.5 text-left">Campaign</th>
                <th class="px-4 py-2.5 text-left">Urgency</th>
                <th class="px-4 py-2.5 text-left">Impact</th>
                <th class="px-4 py-2.5 text-left">Tasks</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="m in backlog.missions" :key="m.id">
                <tr :class="darkMode ? 'border-accent-1 hover:bg-white/5' : 'border-accent-2 hover:bg-black/5'"
                  class="border-b transition cursor-pointer"
                  @click="tab = 'missions'; store.fetchMissionDetail(m.id)"
                >
                  <td class="px-4 py-3 font-semibold">
                    <span :class="darkMode ? 'text-accent-dark' : 'text-accent-light'">{{ m.title }}</span>
                  </td>
                  <td class="px-4 py-3">
                    <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                      class="rounded-full border px-2 py-0.5 text-xs">{{ m.campaign }}</span>
                  </td>
                  <td class="px-4 py-3 font-semibold" :class="URGENCY_COLORS[m.urgency]">{{ m.urgency_label }}</td>
                  <td class="px-4 py-3 font-semibold" :class="IMPACT_COLORS[m.impact]">{{ m.impact_label }}</td>
                  <td class="px-4 py-3">
                    <div class="space-y-1">
                      <div v-for="t in m.tasks?.slice(0,3)" :key="t.id"
                        :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                        class="flex items-center justify-between rounded border px-2 py-1">
                        <span class="truncate max-w-[140px]">{{ t.title }}</span>
                        <span class="opacity-50 ml-2 shrink-0">Weight {{ t.weight }}</span>
                      </div>
                      <div v-if="(m.tasks?.length ?? 0) > 3" class="text-xs opacity-40">
                        +{{ (m.tasks?.length ?? 0) - 3 }} more
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
      <div v-else class="flex-1 flex items-center justify-center opacity-40 text-xs">No backlog data</div>
    </template>

    <!-- ═══════════════════════════ MISSIONS ═════════════════════════════════ -->
    <template v-else-if="selectedProject && tab === 'missions'">
      <div v-if="missionsLoading" class="flex flex-1 items-center justify-center opacity-40">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>

      <!-- Mission detail panel -->
      <template v-else-if="selectedMission">
        <div class="flex items-center gap-2 shrink-0">
          <button @click="store.selectedMission = null as any"
            class="text-xs opacity-50 hover:opacity-100 transition flex items-center gap-1">
            <font-awesome-icon icon="arrow-left" /> All missions
          </button>
        </div>
        <div class="flex-1 overflow-y-auto space-y-4">
          <!-- Overview card -->
          <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border p-4 shadow-md">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-wide opacity-50 mb-1">Mission overview</p>
                <h2 class="text-lg font-bold">{{ selectedMission.title }}</h2>
                <p v-if="selectedMission.description" class="text-sm opacity-60 mt-1">{{ selectedMission.description }}</p>
              </div>
              <div class="flex gap-2 shrink-0">
                <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                  class="rounded-lg border px-2.5 py-1 text-xs font-semibold" :style="`color:${selectedMission.urgency === 3 ? '#f87171' : selectedMission.urgency === 2 ? '#fbbf24' : '#60a5fa'}`">
                  Urgency: {{ selectedMission.urgency_label }}
                </span>
                <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                  class="rounded-lg border px-2.5 py-1 text-xs font-semibold" :style="`color:${selectedMission.impact === 3 ? '#34d399' : selectedMission.impact === 2 ? '#fbbf24' : '#60a5fa'}`">
                  Impact: {{ selectedMission.impact_label }}
                </span>
              </div>
            </div>
          </div>

          <!-- Info cards row -->
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
              class="rounded-xl border p-3 shadow-sm">
              <p class="text-xs font-bold opacity-50 mb-2 flex items-center gap-1"><font-awesome-icon icon="users" />Campaign</p>
              <p class="text-xs font-semibold">{{ selectedMission.campaign.name }}</p>
              <p v-if="selectedMission.campaign.description" class="text-xs opacity-50 mt-1">{{ selectedMission.campaign.description }}</p>
              <div v-if="selectedMission.campaign.start_date" class="mt-2 flex gap-3 text-xs opacity-50">
                <span>Start {{ fmt(selectedMission.campaign.start_date) }}</span>
                <span v-if="selectedMission.campaign.end_date">End {{ fmt(selectedMission.campaign.end_date) }}</span>
              </div>
            </div>
            <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
              class="rounded-xl border p-3 shadow-sm">
              <p class="text-xs font-bold opacity-50 mb-2 flex items-center gap-1"><font-awesome-icon icon="location-dot" />Location</p>
              <p v-if="selectedMission.location" class="text-xs font-semibold">{{ selectedMission.location }}</p>
              <p v-else class="text-xs opacity-30">No location.</p>
              <p v-if="selectedMission.route" class="text-xs opacity-50 mt-1"><font-awesome-icon icon="route" class="text-xs" /> {{ selectedMission.route }}</p>
              <p v-if="selectedMission.zone" class="text-xs opacity-50 mt-0.5"><font-awesome-icon icon="map" class="text-xs" /> {{ selectedMission.zone }}</p>
            </div>
            <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
              class="rounded-xl border p-3 shadow-sm">
              <p class="text-xs font-bold opacity-50 mb-2 flex items-center gap-1"><font-awesome-icon icon="user" />Ownership</p>
              <div class="space-y-1.5 text-xs">
                <div><span class="opacity-40 uppercase tracking-wide">Mission owner</span><br><span class="font-semibold">{{ selectedMission.owner || '—' }}</span></div>
                <div><span class="opacity-40 uppercase tracking-wide">Campaign owner</span><br><span class="font-semibold">{{ selectedMission.campaign.owner || '—' }}</span></div>
                <div><span class="opacity-40 uppercase tracking-wide">Project lead</span><br><span class="font-semibold">{{ selectedMission.project.lead || '—' }}</span></div>
              </div>
            </div>
            <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
              class="rounded-xl border p-3 shadow-sm">
              <p class="text-xs font-bold opacity-50 mb-2 flex items-center gap-1"><font-awesome-icon icon="code" />Metadata</p>
              <pre v-if="Object.keys(selectedMission.metadata || {}).length"
                :class="darkMode ? 'text-text-main-dark' : 'text-text-main-light'"
                class="text-xs font-mono whitespace-pre-wrap overflow-x-auto">{{ Object.entries(selectedMission.metadata).map(([k,v]) => `${k}: ${v}`).join('\n') }}</pre>
              <p v-else class="text-xs opacity-30">No metadata.</p>
            </div>
          </div>

          <!-- Stats row -->
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div v-for="[label, val] in [['Tasks', selectedMission.stats.total], ['Completed', selectedMission.stats.completed], ['Open', selectedMission.stats.open]]" :key="label"
              :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
              class="rounded-xl border p-4 shadow-sm">
              <p class="text-xs uppercase tracking-wide opacity-50">{{ label }}</p>
              <p class="text-3xl font-bold mt-1">{{ val }}</p>
            </div>
            <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
              class="rounded-xl border p-4 shadow-sm">
              <p class="text-xs uppercase tracking-wide opacity-50">Progress</p>
              <p class="text-3xl font-bold mt-1">{{ selectedMission.stats.progress_pct }}%</p>
            </div>
          </div>

          <!-- Progress bars -->
          <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border p-4 shadow-md space-y-4">
            <h3 class="text-sm font-bold flex items-center gap-2"><font-awesome-icon icon="chart-bar" class="opacity-60" /> Mission progress</h3>
            <div>
              <div class="flex justify-between text-xs opacity-60 mb-1">
                <span>Task completion</span>
                <span>{{ selectedMission.stats.completed }}/{{ selectedMission.stats.total }} · {{ selectedMission.stats.progress_pct }}%</span>
              </div>
              <div :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'" class="h-2 rounded-full overflow-hidden">
                <div :class="darkMode ? 'bg-accent-dark' : 'bg-accent-light'" class="h-full rounded-full transition-all"
                  :style="`width:${selectedMission.stats.progress_pct}%`"></div>
              </div>
            </div>
            <div>
              <div class="flex justify-between text-xs opacity-60 mb-1">
                <span>Weighted completion</span>
                <span>{{ selectedMission.stats.completed_weight }}/{{ selectedMission.stats.total_weight }} · {{ selectedMission.stats.weighted_pct }}%</span>
              </div>
              <div :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'" class="h-2 rounded-full overflow-hidden">
                <div :class="darkMode ? 'bg-accent-dark' : 'bg-accent-light'" class="h-full rounded-full transition-all"
                  :style="`width:${selectedMission.stats.weighted_pct}%`"></div>
              </div>
            </div>
          </div>

          <!-- Tasks list -->
          <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border shadow-md overflow-hidden">
            <div class="border-b border-current/10 px-4 py-3 text-sm font-bold">Tasks</div>
            <div v-for="t in selectedMission.tasks" :key="t.id"
              :class="darkMode ? 'border-accent-1 hover:bg-white/5' : 'border-accent-2 hover:bg-black/5'"
              class="flex items-center gap-3 border-b px-4 py-2.5 text-xs transition last:border-0">
              <font-awesome-icon :icon="t.completed_at ? 'check' : 'circle'" class="shrink-0 opacity-50" />
              <span class="flex-1 font-semibold" :class="t.completed_at ? 'line-through opacity-40' : ''">{{ t.title }}</span>
              <span :class="WEIGHT_COLORS[t.weight]" class="rounded px-1.5 py-0.5 font-mono">{{ t.weight_label }}</span>
              <span class="opacity-40">{{ t.column_name }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- Mission list -->
      <template v-else>
        <div class="flex-1 overflow-y-auto space-y-3">
          <div v-if="!missions.length" class="flex items-center justify-center py-12 opacity-40 text-xs">No missions</div>
          <div v-for="m in missions" :key="m.id"
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 hover:bg-primary-bg-dark' : 'bg-bubble-bg-light border-accent-2 hover:bg-primary-bg-light'"
            class="rounded-xl border p-4 shadow-sm cursor-pointer transition"
            @click="store.fetchMissionDetail(m.id)"
          >
            <div class="flex items-center justify-between gap-3">
              <h3 :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="font-semibold text-sm">{{ m.title }}</h3>
              <div class="flex gap-2 shrink-0 text-xs">
                <span :class="URGENCY_COLORS[m.urgency]" class="font-semibold">{{ m.urgency_label }}</span>
                <span class="opacity-30">·</span>
                <span :class="IMPACT_COLORS[m.impact]" class="font-semibold">{{ m.impact_label }}</span>
              </div>
            </div>
            <p class="text-xs opacity-50 mt-1">{{ m.campaign }}</p>
          </div>
        </div>
      </template>
    </template>

    <!-- ═══════════════════════════ EISENHOWER MATRIX ════════════════════════ -->
    <template v-else-if="selectedProject && tab === 'matrix'">
      <div v-if="matrixLoading" class="flex flex-1 items-center justify-center opacity-40">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>
      <div v-else-if="matrix" class="flex-1 overflow-auto">
        <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border shadow-md overflow-hidden">
          <!-- Header -->
          <div class="border-b border-current/10 px-4 py-3 flex items-center justify-between">
            <div>
              <h3 class="text-sm font-bold flex items-center gap-2"><font-awesome-icon icon="table-cells" class="opacity-60" /> 3×3 priority matrix</h3>
              <p class="text-xs opacity-50 mt-0.5">Compare missions by urgency and impact to decide what needs attention first.</p>
            </div>
            <span :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
              class="rounded-lg border px-3 py-1 text-xs opacity-60">9 cells</span>
          </div>
          <!-- Grid -->
          <table class="w-full">
            <thead>
              <tr :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="border-b">
                <th class="px-4 py-2.5 text-xs font-semibold opacity-50 text-left w-24">Urgency \ Impact</th>
                <th v-for="il in [1,2,3]" :key="il" class="px-4 py-2.5 text-xs font-semibold opacity-60 text-center"
                  :class="IMPACT_COLORS[il]">{{ IMPACT_LABELS[il] }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ul in [1,2,3]" :key="ul"
                :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="border-b last:border-0">
                <td class="px-4 py-3 text-xs font-semibold" :class="URGENCY_COLORS[ul]">{{ URGENCY_LABELS[ul] }}</td>
                <td v-for="il in [1,2,3]" :key="il"
                  :class="darkMode ? 'border-accent-1 bg-primary-bg-dark/30' : 'border-accent-2 bg-primary-bg-light/50'"
                  class="border-l px-3 py-3 align-top min-h-[80px]" style="min-width:180px"
                >
                  <div v-if="matrix[`${ul}_${il}`]?.length" class="space-y-1.5">
                    <div v-for="m in matrix[`${ul}_${il}`]" :key="m.id"
                      :class="darkMode ? 'border-accent-1 hover:bg-white/5' : 'border-accent-2 hover:bg-black/5'"
                      class="flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition"
                      @click="tab = 'missions'; store.fetchMissionDetail(m.id)"
                    >
                      <font-awesome-icon icon="bullseye" class="text-xs opacity-50 shrink-0" />
                      <span :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                        class="text-xs font-semibold">{{ m.title }}</span>
                    </div>
                  </div>
                  <p v-else class="text-xs opacity-25 italic text-center py-3">None</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-else class="flex-1 flex items-center justify-center opacity-40 text-xs">No matrix data</div>
    </template>

    <!-- ══════════════════════ TASK MODAL ═════════════════════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="taskModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        :class="darkMode ? 'bg-black/60' : 'bg-black/30'"
        @click.self="closeTask"
      >
        <div
          :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark [color-scheme:dark]' : 'bg-primary-bg-light border-accent-2 text-text-main-light [color-scheme:light]'"
          class="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden"
        >
          <!-- Modal header -->
          <div class="flex items-center justify-between border-b border-current/10 px-5 py-3">
            <h3 class="text-sm font-bold flex items-center gap-2">
              <font-awesome-icon icon="list-check" class="opacity-60" /> Edit Task
            </h3>
            <button @click="closeTask" class="opacity-50 hover:opacity-100 transition"><font-awesome-icon icon="xmark" /></button>
          </div>

          <!-- Modal body -->
          <div class="p-5 space-y-4">
            <div>
              <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Title</label>
              <input v-model="editTitle" type="text"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none" />
            </div>
            <div>
              <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Description</label>
              <textarea v-model="editDesc" rows="3"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Column</label>
                <select v-model="editColumnId"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none appearance-none">
                  <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </div>
              <div>
                <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Weight</label>
                <select v-model="editWeight"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none appearance-none">
                  <option v-for="[w,l] in [[1,'Tiny'],[2,'Small'],[3,'Medium'],[5,'Big'],[8,'Large']]" :key="w" :value="w">{{ l }} ({{ w }})</option>
                </select>
              </div>
            </div>
            <div>
              <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Due date</label>
              <input v-model="editDueDate" type="date"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none" />
            </div>
            <div v-if="taskModal.mission_title" class="text-xs opacity-40 flex items-center gap-1.5">
              <font-awesome-icon icon="bullseye" /> Mission: {{ taskModal.mission_title }}
            </div>
          </div>

          <!-- Modal footer -->
          <div class="flex items-center justify-between border-t border-current/10 px-5 py-3">
            <template v-if="!confirmDeleteTask">
              <button @click="confirmDeleteTask = true"
                class="rounded-lg border border-current/20 px-3 py-1.5 text-xs text-red-400 transition hover:opacity-80">
                <font-awesome-icon icon="trash" /> Delete
              </button>
            </template>
            <template v-else>
              <div class="flex items-center gap-2">
                <span class="text-xs opacity-50">Delete this task?</span>
                <button @click="confirmDeleteTask = false" class="rounded-lg border border-current/20 px-2 py-1 text-xs">Cancel</button>
                <button @click="deleteTaskConfirmed" class="rounded-lg bg-red-500 px-2 py-1 text-xs text-white font-bold">Yes</button>
              </div>
            </template>
            <div class="flex gap-2">
              <button @click="closeTask"
                class="rounded-lg border border-current/20 px-3 py-1.5 text-xs transition hover:opacity-80">Cancel</button>
              <button @click="saveTask" :disabled="savingTask"
                :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                class="rounded-lg px-4 py-1.5 text-xs font-bold transition disabled:opacity-50">
                {{ savingTask ? 'Saving…' : 'Save changes' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>
