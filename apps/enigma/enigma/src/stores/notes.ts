import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type NoteBox, type NoteCategory, type NoteLink, type NoteEdge } from "../services/api";

export const useNotesStore = defineStore("notes", () => {
  const boxes = ref<NoteBox[]>([]);
  const categories = ref<NoteCategory[]>([]);
  const selectedBox = ref<NoteBox | null>(null);
  const links = ref<NoteLink[]>([]);
  const graphNodes = ref<NoteBox[]>([]);
  const graphEdges = ref<NoteEdge[]>([]);
  const loading = ref(false);
  const linksLoading = ref(false);
  const graphLoading = ref(false);
  const error = ref<string | null>(null);

  async function fetchBoxes(query?: string) {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.getBoxes(query);
      boxes.value = res.boxes;
    } catch (e: any) {
      error.value = e.message ?? "Failed to load notes";
    } finally {
      loading.value = false;
    }
  }

  async function fetchCategories() {
    try {
      const res = await api.getCategories();
      categories.value = res.categories;
    } catch { /* non-critical */ }
  }

  async function fetchLinks(boxId: number) {
    linksLoading.value = true;
    try {
      const res = await api.getBoxLinks(boxId);
      links.value = res.links;
    } catch {
      links.value = [];
    } finally {
      linksLoading.value = false;
    }
  }

  async function fetchGraph() {
    graphLoading.value = true;
    try {
      const res = await api.getFullGraph();
      graphNodes.value = res.nodes;
      graphEdges.value = res.edges;
    } catch {
      graphNodes.value = [];
      graphEdges.value = [];
    } finally {
      graphLoading.value = false;
    }
  }

  async function createBox(title: string, body: string, is_concept = false, category_id?: number | null) {
    const box = await api.createBox({ title, body, is_concept, category_id });
    boxes.value.unshift(box);
    await selectBox(box);
    return box;
  }

  async function saveBox(id: number, changes: Partial<{ title: string; body: string; is_concept: boolean; category_id: number | null }>) {
    const updated = await api.updateBox(id, changes);
    const idx = boxes.value.findIndex((b) => b.id === id);
    if (idx !== -1) boxes.value[idx] = updated;
    if (selectedBox.value?.id === id) selectedBox.value = updated;
    return updated;
  }

  async function removeBox(id: number) {
    await api.deleteBox(id);
    boxes.value = boxes.value.filter((b) => b.id !== id);
    if (selectedBox.value?.id === id) {
      selectedBox.value = null;
      links.value = [];
    }
  }

  async function selectBox(box: NoteBox | null) {
    selectedBox.value = box;
    links.value = [];
    if (box) await fetchLinks(box.id);
  }

  async function addLink(fromBox: number, toBox: number, label: string) {
    const link = await api.createLink(fromBox, toBox, label);
    links.value.unshift(link);
    return link;
  }

  async function removeLink(id: number) {
    await api.deleteLink(id);
    links.value = links.value.filter((l) => l.id !== id);
  }

  const outgoingLinks = (boxId: number) => links.value.filter((l) => l.from_box === boxId);
  const incomingLinks = (boxId: number) => links.value.filter((l) => l.to_box === boxId);

  return {
    boxes, categories, selectedBox, links, graphNodes, graphEdges,
    loading, linksLoading, graphLoading, error,
    fetchBoxes, fetchCategories, fetchLinks, fetchGraph,
    createBox, saveBox, removeBox, selectBox, addLink, removeLink,
    outgoingLinks, incomingLinks,
  };
});
