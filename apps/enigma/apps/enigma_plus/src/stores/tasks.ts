import { defineStore } from "pinia";
import { ref } from "vue";
import {
  api,
  type KanbanProject, type KanbanTask, type KanbanMission,
  type MissionDetail, type SprintMetrics, type BacklogData, type EisenhowerMatrix,
} from "../services/api";
import * as yStore from "../services/yStore";

export const useTasksStore = defineStore("tasks", () => {
  const projects = ref<KanbanProject[]>([]);
  const selectedProject = ref<KanbanProject | null>(null);
  const tasks = ref<KanbanTask[]>([]);
  const missions = ref<KanbanMission[]>([]);
  const selectedMission = ref<MissionDetail | null>(null);
  const sprintMetrics = ref<SprintMetrics | null>(null);
  const backlog = ref<BacklogData | null>(null);
  const matrix = ref<EisenhowerMatrix | null>(null);

  const loading = ref(false);
  const missionsLoading = ref(false);
  const sprintLoading = ref(false);
  const backlogLoading = ref(false);
  const matrixLoading = ref(false);
  const error = ref<string | null>(null);

  // ── Projects ────────────────────────────────────────────────────────────────
  // Tasks are a synced domain (y_store): projects in the "tasks" doc, board tasks per
  // project in "tasks:{projectId}". Persist on fetch (non-destructive upsert); serve the
  // cache offline.
  async function fetchProjects() {
    loading.value = true; error.value = null;
    try {
      const res = await api.getProjects();
      projects.value = await yStore.persist<KanbanProject>("tasks", "projects", res.projects);
    } catch (e: any) {
      const cached = await yStore.cached<KanbanProject>("tasks", "projects");
      if (cached) projects.value = cached; else error.value = e.message;
    } finally { loading.value = false; }
  }

  async function selectProject(project: KanbanProject) {
    loading.value = true; error.value = null;
    try {
      const full = await api.getProject(project.id);
      selectedProject.value = full;
      const res = await api.getProjectTasks(project.id);
      tasks.value = await yStore.persist<KanbanTask>(`tasks:${project.id}`, "tasks", res.tasks);
    } catch (e: any) {
      const cached = await yStore.cached<KanbanTask>(`tasks:${project.id}`, "tasks");
      if (cached) tasks.value = cached; else error.value = e.message;
    } finally { loading.value = false; }
  }

  // ── Tasks ────────────────────────────────────────────────────────────────────
  async function addTask(columnId: number, title: string, description = "") {
    if (!selectedProject.value) return;
    const task = await api.createTask(selectedProject.value.id, { title, description, column_id: columnId });
    tasks.value.push(task);
    return task;
  }

  async function editTask(id: number, changes: Partial<{ title: string; description: string; column_id: number; weight: number; due_date: string | null }>) {
    const updated = await api.updateTask(id, changes);
    _replaceTask(updated);
    return updated;
  }

  async function removeTask(id: number) {
    await api.deleteTask(id);
    tasks.value = tasks.value.filter(t => t.id !== id);
  }

  async function promote(id: number) { _replaceTask(await api.promoteTask(id)); }
  async function demote(id: number)  { _replaceTask(await api.demoteTask(id)); }

  function _replaceTask(updated: KanbanTask) {
    const idx = tasks.value.findIndex(t => t.id === updated.id);
    if (idx !== -1) tasks.value[idx] = updated;
  }

  function tasksForColumn(columnId: number) {
    return tasks.value.filter(t => t.column_id === columnId);
  }

  // ── Missions ─────────────────────────────────────────────────────────────────
  // Missions flow through the Rust CRDT data layer (y_store, fjall-persisted): on a
  // successful fetch we ingest + read back the canonical projection; offline we serve
  // the cache. Missions are server-only (not p2p-synced) — the doc is scoped per project.
  const missionsDoc = (projectId: number) => `missions:${projectId}`;

  async function fetchMissions() {
    if (!selectedProject.value) return;
    const projectId = selectedProject.value.id;
    missionsLoading.value = true;
    try {
      const res = await api.getProjectMissions(projectId);
      missions.value = await yStore.persist<KanbanMission>(missionsDoc(projectId), "missions", res.missions);
    } catch {
      missions.value = (await yStore.cached<KanbanMission>(missionsDoc(projectId), "missions")) ?? [];
    } finally { missionsLoading.value = false; }
  }

  async function fetchMissionDetail(id: number) {
    const projectId = selectedProject.value?.id ?? 0;
    missionsLoading.value = true;
    try {
      const detail = await api.getMission(id);
      const [stored] = await yStore.persist<MissionDetail>(missionsDoc(projectId), "details", [detail]);
      selectedMission.value = stored ?? detail;
    } catch {
      const all = await yStore.cached<MissionDetail>(missionsDoc(projectId), "details");
      selectedMission.value = all?.find((m) => m.id === id) ?? null;
    } finally { missionsLoading.value = false; }
  }

  // ── Sprint Metrics ────────────────────────────────────────────────────────────
  async function fetchSprintMetrics(sprintId?: number) {
    if (!selectedProject.value) return;
    sprintLoading.value = true;
    try {
      sprintMetrics.value = await api.getSprintMetrics(selectedProject.value.id, sprintId);
    } catch { sprintMetrics.value = null; }
    finally { sprintLoading.value = false; }
  }

  // ── Backlog ───────────────────────────────────────────────────────────────────
  async function fetchBacklog() {
    if (!selectedProject.value) return;
    backlogLoading.value = true;
    try {
      backlog.value = await api.getBacklog(selectedProject.value.id);
    } catch { backlog.value = null; }
    finally { backlogLoading.value = false; }
  }

  // ── Matrix ────────────────────────────────────────────────────────────────────
  async function fetchMatrix() {
    if (!selectedProject.value) return;
    matrixLoading.value = true;
    try {
      const res = await api.getEisenhowerMatrix(selectedProject.value.id);
      matrix.value = res.matrix;
    } catch { matrix.value = null; }
    finally { matrixLoading.value = false; }
  }

  return {
    projects, selectedProject, tasks, missions, selectedMission,
    sprintMetrics, backlog, matrix,
    loading, missionsLoading, sprintLoading, backlogLoading, matrixLoading, error,
    fetchProjects, selectProject,
    addTask, editTask, removeTask, promote, demote, tasksForColumn,
    fetchMissions, fetchMissionDetail,
    fetchSprintMetrics, fetchBacklog, fetchMatrix,
  };
});
