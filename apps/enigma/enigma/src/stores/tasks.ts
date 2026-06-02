import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type KanbanProject, type KanbanTask } from "../services/api";

export const useTasksStore = defineStore("tasks", () => {
  const projects = ref<KanbanProject[]>([]);
  const selectedProject = ref<KanbanProject | null>(null);
  const tasks = ref<KanbanTask[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchProjects() {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getProjects();
      projects.value = res.projects;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load projects";
    } finally {
      loading.value = false;
    }
  }

  async function selectProject(project: KanbanProject) {
    loading.value = true;
    error.value = null;
    try {
      const full = await api.getProject(project.id);
      selectedProject.value = full;
      const res = await api.getProjectTasks(project.id);
      tasks.value = res.tasks;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load project";
    } finally {
      loading.value = false;
    }
  }

  async function addTask(columnId: number, title: string, description = "") {
    if (!selectedProject.value) return;
    const task = await api.createTask(selectedProject.value.id, { title, description, column_id: columnId });
    tasks.value.push(task);
    return task;
  }

  async function editTask(id: number, changes: Partial<{ title: string; description: string }>) {
    const updated = await api.updateTask(id, changes);
    _replace(updated);
    return updated;
  }

  async function promote(id: number) {
    const updated = await api.promoteTask(id);
    _replace(updated);
  }

  async function demote(id: number) {
    const updated = await api.demoteTask(id);
    _replace(updated);
  }

  function _replace(updated: KanbanTask) {
    const idx = tasks.value.findIndex((t) => t.id === updated.id);
    if (idx !== -1) tasks.value[idx] = updated;
  }

  function tasksForColumn(columnId: number) {
    return tasks.value.filter((t) => t.column_id === columnId);
  }

  return { projects, selectedProject, tasks, loading, error, fetchProjects, selectProject, addTask, editTask, promote, demote, tasksForColumn };
});
