<script setup lang="ts">
// A search box over the notes folder, in the files sidepanel.
//
// It holds no file: a hit is handed up as a path and the panel opens it the
// way it opens a clicked row, so there is one way into an editor, not two.
//
// The debounce is the whole of the cleverness. Every keystroke would
// otherwise walk the folder synchronously with the keystroke before it still
// in flight; 200 ms of quiet and a sequence number — so an answer that arrives
// after a newer question was asked is dropped rather than shown — are the
// minimum that keeps the list truthful.
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { searchNotes, type NoteHit } from "./notesSearch";

const props = defineProps<{
  /** The notes root: the same folder the tree shows. */
  root: string;
}>();

const emit = defineEmits<{
  open: [{ path: string; name: string }];
}>();

const { t } = useI18n({ useScope: "global" });

const DEBOUNCE_MS = 200;

const query = ref("");
const hits = ref<NoteHit[]>([]);
const busy = ref(false);
const error = ref("");
/** Whether the list reflects a finished search — what tells "no matches"
 *  from "nothing typed yet". */
const searched = ref(false);
const input = ref<HTMLInputElement | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function clear() {
  hits.value = [];
  error.value = "";
  searched.value = false;
  busy.value = false;
}

async function run() {
  const q = query.value.trim();
  const id = ++seq;
  if (!q) {
    clear();
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const found = await searchNotes(props.root, q);
    if (id !== seq) return; // a newer search has since been asked
    hits.value = found;
    searched.value = true;
  } catch (err) {
    if (id !== seq) return;
    hits.value = [];
    searched.value = true;
    error.value = `${t("files.searchFailed")} ${(err as Error)?.message ?? err}`;
  } finally {
    if (id === seq) busy.value = false;
  }
}

watch(query, (q) => {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!q.trim()) {
    seq++; // an in-flight answer to the old text is stale now
    clear();
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, DEBOUNCE_MS);
});

// A different folder means a different set of notes; results for the old
// one would be answers to a question nobody is asking any more.
watch(() => props.root, () => {
  query.value = "";
  clear();
});

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  seq++;
});

defineExpose({
  focus() {
    input.value?.focus();
  },
});
</script>

<template>
  <div class="border-b border-current/10 px-2 py-1.5" data-testid="notes-search-panel">
    <input ref="input" v-model="query" type="search" :placeholder="t('files.searchNotes')"
           data-testid="notes-search" :aria-label="t('files.searchNotes')"
           class="w-full rounded-lg border border-accent-2 bg-transparent px-2 py-1 text-xs dark:border-accent-1" />

    <p v-if="error" class="pt-1.5 text-xs text-warn-dark" data-testid="notes-search-error">{{ error }}</p>

    <ul v-if="hits.length" class="mt-1.5 max-h-64 overflow-y-auto" data-testid="notes-results">
      <li v-for="(hit, i) in hits" :key="hit.path">
        <button type="button" :data-testid="`notes-result-${i}`" :title="hit.rel_path"
                class="flex w-full flex-col items-start rounded px-1.5 py-1 text-left transition hover:bg-accent-light/10"
                @click="emit('open', { path: hit.path, name: hit.name })">
          <span class="w-full truncate text-xs font-semibold">{{ hit.name }}</span>
          <span v-if="hit.rel_path !== hit.name" class="w-full truncate text-[10px] opacity-50">{{ hit.rel_path }}</span>
          <span v-if="hit.snippet" class="w-full truncate text-[11px] opacity-70">{{ hit.snippet }}</span>
        </button>
      </li>
    </ul>

    <p v-else-if="searched && !busy && !error" class="pt-1.5 text-center text-xs opacity-40"
       data-testid="notes-search-empty">
      {{ t("files.searchNoHits") }}
    </p>
  </div>
</template>
