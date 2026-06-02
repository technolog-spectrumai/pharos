import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type NoteBox, type NoteCategory } from "../services/api";

export const useNotesStore = defineStore("notes", () => {
  const boxes = ref<NoteBox[]>([]);
  const categories = ref<NoteCategory[]>([]);
  const selectedBox = ref<NoteBox | null>(null);
  const loading = ref(false);
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
    } catch {
      // non-critical
    }
  }

  async function createBox(title: string, body: string, is_concept = false, category_id?: number | null) {
    const box = await api.createBox({ title, body, is_concept, category_id });
    boxes.value.unshift(box);
    selectedBox.value = box;
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
    if (selectedBox.value?.id === id) selectedBox.value = null;
  }

  function selectBox(box: NoteBox | null) {
    selectedBox.value = box;
  }

  return { boxes, categories, selectedBox, loading, error, fetchBoxes, fetchCategories, createBox, saveBox, removeBox, selectBox };
});
