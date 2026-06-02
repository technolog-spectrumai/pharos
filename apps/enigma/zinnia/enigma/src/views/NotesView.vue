<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { storeToRefs } from "pinia";
import { useNotesStore } from "../stores/notes";

defineProps<{ darkMode: boolean }>();

const store = useNotesStore();
const { boxes, categories, selectedBox, loading, error } = storeToRefs(store);

const search = ref("");
const editTitle = ref("");
const editBody = ref("");
const editConcept = ref(false);
const saving = ref(false);
const confirmDelete = ref(false);

onMounted(() => {
  store.fetchBoxes();
  store.fetchCategories();
});

watch(selectedBox, (box) => {
  if (box) {
    editTitle.value = box.title;
    editBody.value = box.body;
    editConcept.value = box.is_concept;
    confirmDelete.value = false;
  }
});

const filteredBoxes = computed(() =>
  boxes.value.filter(
    (b) =>
      b.title.toLowerCase().includes(search.value.toLowerCase()) ||
      b.body.toLowerCase().includes(search.value.toLowerCase())
  )
);

async function doSearch() {
  await store.fetchBoxes(search.value || undefined);
}

async function newNote() {
  await store.createBox("New Note", "", false);
}

async function save() {
  if (!selectedBox.value) return;
  saving.value = true;
  try {
    await store.saveBox(selectedBox.value.id, {
      title: editTitle.value,
      body: editBody.value,
      is_concept: editConcept.value,
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

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
</script>

<template>
  <div class="flex h-[calc(100vh-9rem)] w-full gap-4 overflow-hidden">

    <!-- Sidebar -->
    <aside
      :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
      class="flex w-72 shrink-0 flex-col rounded-xl border shadow-md overflow-hidden"
    >
      <!-- Search + New -->
      <div class="flex gap-2 border-b border-current/10 p-3">
        <input
          v-model="search"
          @keydown.enter="doSearch"
          type="text"
          placeholder="Search notes…"
          :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
          class="flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none"
        />
        <button
          @click="newNote"
          :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
          class="rounded-lg px-3 py-1.5 text-sm font-bold transition hover:opacity-90"
          title="New note"
        >
          <font-awesome-icon icon="plus" />
        </button>
      </div>

      <!-- Box list -->
      <div v-if="loading" class="flex flex-1 items-center justify-center opacity-50 text-sm">Loading…</div>
      <div v-else-if="filteredBoxes.length === 0" class="flex flex-1 items-center justify-center opacity-40 text-sm">No notes</div>
      <ul v-else class="flex-1 overflow-y-auto divide-y divide-current/5">
        <li
          v-for="box in filteredBoxes"
          :key="box.id"
          @click="store.selectBox(box)"
          :class="[
            'cursor-pointer px-3 py-2.5 transition hover:opacity-80',
            selectedBox?.id === box.id
              ? (darkMode ? 'bg-accent-dark/20' : 'bg-accent-light/20')
              : ''
          ]"
        >
          <div class="flex items-center gap-1.5">
            <font-awesome-icon
              :icon="box.is_concept ? 'tag' : 'sticky-note'"
              class="text-xs opacity-50 shrink-0"
            />
            <span class="truncate text-sm font-medium">{{ box.title || "Untitled" }}</span>
          </div>
          <p class="mt-0.5 truncate text-xs opacity-40">{{ box.body.slice(0, 60) || "—" }}</p>
          <p class="mt-0.5 text-xs opacity-30">{{ formatDate(box.updated_at) }}</p>
        </li>
      </ul>
    </aside>

    <!-- Main panel -->
    <main
      :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
      class="flex flex-1 flex-col rounded-xl border shadow-md overflow-hidden"
    >
      <div v-if="!selectedBox" class="flex flex-1 flex-col items-center justify-center opacity-40 gap-3">
        <font-awesome-icon icon="sticky-note" class="text-4xl" />
        <p class="text-sm">Select or create a note</p>
      </div>

      <template v-else>
        <!-- Title bar -->
        <div class="flex items-center gap-3 border-b border-current/10 px-4 py-3">
          <input
            v-model="editTitle"
            type="text"
            placeholder="Title…"
            :class="darkMode ? 'bg-transparent text-text-main-dark' : 'bg-transparent text-text-main-light'"
            class="flex-1 text-lg font-bold outline-none"
          />
          <label class="flex items-center gap-1.5 text-xs opacity-60 cursor-pointer">
            <input v-model="editConcept" type="checkbox" class="rounded" />
            Concept
          </label>
          <span v-if="selectedBox.category_name"
            :class="darkMode ? 'bg-accent-dark/20 text-text-main-dark' : 'bg-accent-light/20 text-text-main-light'"
            class="rounded-full px-2 py-0.5 text-xs">
            {{ selectedBox.category_name }}
          </span>
        </div>

        <!-- Body -->
        <textarea
          v-model="editBody"
          :class="darkMode ? 'bg-transparent text-text-main-dark placeholder-white/30' : 'bg-transparent text-text-main-light placeholder-black/30'"
          class="flex-1 resize-none p-4 text-sm leading-relaxed outline-none"
          placeholder="Write your note here…"
        />

        <!-- Actions -->
        <div class="flex items-center justify-between border-t border-current/10 px-4 py-2.5">
          <div class="text-xs opacity-40">
            Updated {{ formatDate(selectedBox.updated_at) }}
          </div>
          <div class="flex gap-2">
            <template v-if="!confirmDelete">
              <button
                @click="confirmDelete = true"
                class="rounded-lg border border-current/20 px-3 py-1.5 text-xs opacity-60 transition hover:opacity-100"
              >
                <font-awesome-icon icon="trash" /> Delete
              </button>
              <button
                @click="save"
                :disabled="saving"
                :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                class="rounded-lg px-4 py-1.5 text-xs font-bold transition hover:opacity-90 disabled:opacity-50"
              >
                {{ saving ? "Saving…" : "Save" }}
              </button>
            </template>
            <template v-else>
              <span class="text-xs opacity-60 self-center">Delete this note?</span>
              <button @click="confirmDelete = false" class="rounded-lg border border-current/20 px-3 py-1.5 text-xs transition hover:opacity-80">Cancel</button>
              <button @click="del" class="rounded-lg bg-red-500 px-3 py-1.5 text-xs text-white font-bold transition hover:opacity-90">Yes, delete</button>
            </template>
          </div>
        </div>
      </template>

      <div v-if="error" class="px-4 py-2 text-xs text-red-400">{{ error }}</div>
    </main>
  </div>
</template>
