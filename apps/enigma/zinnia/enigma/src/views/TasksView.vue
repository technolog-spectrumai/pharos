<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useTasksStore } from "../stores/tasks";
import type { KanbanProject, KanbanColumn } from "../services/api";

defineProps<{ darkMode: boolean }>();

const store = useTasksStore();
const { projects, selectedProject, loading, error } = storeToRefs(store);

const newTaskTitle = ref<Record<number, string>>({});
const addingToColumn = ref<number | null>(null);
const editingTaskId = ref<number | null>(null);
const editingTitle = ref("");

onMounted(() => store.fetchProjects());

function pickProject(p: KanbanProject) {
  store.selectProject(p);
}

async function addTask(col: KanbanColumn) {
  const title = newTaskTitle.value[col.id]?.trim();
  if (!title) return;
  await store.addTask(col.id, title);
  newTaskTitle.value[col.id] = "";
  addingToColumn.value = null;
}

function startEdit(id: number, currentTitle: string) {
  editingTaskId.value = id;
  editingTitle.value = currentTitle;
}

async function saveEdit(id: number) {
  if (!editingTitle.value.trim()) return;
  await store.editTask(id, { title: editingTitle.value.trim() });
  editingTaskId.value = null;
}

const columns = computed(() => selectedProject.value?.columns ?? []);

const WEIGHT_COLORS: Record<number, string> = {
  1: "bg-green-500/20 text-green-400",
  2: "bg-blue-500/20 text-blue-400",
  3: "bg-yellow-500/20 text-yellow-400",
  5: "bg-orange-500/20 text-orange-400",
  8: "bg-red-500/20 text-red-400",
};
</script>

<template>
  <div class="flex w-full flex-col gap-4 overflow-hidden">

    <!-- Project selector -->
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm opacity-60">Project:</span>
      <button
        v-for="p in projects"
        :key="p.id"
        @click="pickProject(p)"
        :class="[
          'rounded-lg px-3 py-1 text-sm font-semibold border transition',
          selectedProject?.id === p.id
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'
        ]"
      >{{ p.name }}</button>
      <span v-if="!projects.length && !loading" class="text-sm opacity-40">No projects found</span>
    </div>

    <div v-if="error" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ error }}</div>

    <!-- Board -->
    <div v-if="loading" class="flex items-center justify-center py-16 opacity-50">
      <font-awesome-icon icon="spinner" spin class="text-2xl" />
    </div>

    <div v-else-if="!selectedProject" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
      <font-awesome-icon icon="columns" class="text-4xl" />
      <p class="text-sm">Select a project to view the board</p>
    </div>

    <div v-else class="flex gap-4 overflow-x-auto pb-4">
      <div
        v-for="col in columns"
        :key="col.id"
        :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="flex w-64 shrink-0 flex-col rounded-xl border shadow-md overflow-hidden"
      >
        <!-- Column header -->
        <div class="flex items-center justify-between border-b border-current/10 px-3 py-2.5">
          <span class="text-sm font-bold">{{ col.name }}</span>
          <span class="rounded-full px-2 py-0.5 text-xs opacity-50 border border-current/20">
            {{ store.tasksForColumn(col.id).length }}
          </span>
        </div>

        <!-- Tasks -->
        <div class="flex-1 overflow-y-auto space-y-2 p-2">
          <div
            v-for="task in store.tasksForColumn(col.id)"
            :key="task.id"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
            class="rounded-lg border p-2.5 shadow-sm"
          >
            <!-- Title / edit -->
            <template v-if="editingTaskId === task.id">
              <input
                v-model="editingTitle"
                @keydown.enter="saveEdit(task.id)"
                @blur="saveEdit(task.id)"
                class="w-full text-xs bg-transparent outline-none border-b border-current/30 pb-0.5 mb-1"
                autofocus
              />
            </template>
            <p
              v-else
              @dblclick="startEdit(task.id, task.title)"
              class="text-xs font-semibold leading-snug cursor-text"
              title="Double-click to edit"
            >{{ task.title }}</p>

            <!-- Meta row -->
            <div class="mt-2 flex items-center justify-between gap-1">
              <span
                :class="WEIGHT_COLORS[task.weight] ?? 'bg-gray-500/20 text-gray-400'"
                class="rounded px-1.5 py-0.5 text-xs font-mono"
              >{{ task.weight }}</span>
              <div class="flex gap-1">
                <button
                  @click="store.demote(task.id)"
                  class="rounded border border-current/15 px-1.5 py-0.5 text-xs opacity-60 transition hover:opacity-100"
                  title="Demote"
                >←</button>
                <button
                  @click="store.promote(task.id)"
                  class="rounded border border-current/15 px-1.5 py-0.5 text-xs opacity-60 transition hover:opacity-100"
                  title="Promote"
                >→</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Add task -->
        <div class="border-t border-current/10 p-2">
          <template v-if="addingToColumn === col.id">
            <input
              v-model="newTaskTitle[col.id]"
              @keydown.enter="addTask(col)"
              @keydown.escape="addingToColumn = null"
              type="text"
              placeholder="Task title…"
              :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
              class="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
              autofocus
            />
          </template>
          <button
            v-else
            @click="addingToColumn = col.id"
            class="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-xs opacity-50 transition hover:opacity-100"
          >
            <font-awesome-icon icon="plus" />
            Add task
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
