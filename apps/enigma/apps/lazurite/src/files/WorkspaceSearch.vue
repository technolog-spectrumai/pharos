<script setup lang="ts">
// The one search box, over the whole workspace, in the files sidepanel.
//
// It holds no file: a hit is handed up as a path and the panel opens it the
// way it opens a clicked row, so there is one way into an editor, not two.
//
// The debounce is the whole of the cleverness. Every keystroke would
// otherwise walk the folder synchronously with the keystroke before it still
// in flight; 200 ms of quiet and a sequence number — so an answer that arrives
// after a newer question was asked is dropped rather than shown — are the
// minimum that keeps the list truthful.
//
// PRIVACY. Results are never kept beyond the list on screen, and the list is
// asked again whenever a file's encryption changes: a line that came from a
// body now encrypted must not outlive the encryption, and Rust would not hand
// it back a second time anyway.
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspace } from "petalite/files";
import { searchWorkspace, type SearchHit } from "./search";
import { errorText, fsErrorKey } from "./fs";
import { useSearchMode } from "./searchSettings";

const props = defineProps<{
  /** The workspace root: the same folder the tree shows. */
  root: string;
}>();

const emit = defineEmits<{
  open: [{ path: string; name: string }];
  /** Whether a query is on screen — the panel hides the tree meanwhile. */
  "update:active": [boolean];
}>();

const { t } = useI18n({ useScope: "global" });
const { mode } = useSearchMode();
const workspace = useWorkspace();

const DEBOUNCE_MS = 200;

const query = ref("");
const hits = ref<SearchHit[]>([]);
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
    const found = await searchWorkspace(q, mode.value);
    if (id !== seq) return; // a newer search has since been asked
    hits.value = found;
    searched.value = true;
  } catch (err) {
    if (id !== seq) return;
    hits.value = [];
    searched.value = true;
    const message = errorText(err);
    const key = fsErrorKey(message);
    error.value = `${t("files.searchFailed")} ${key ? t(key) : message}`;
  } finally {
    if (id === seq) busy.value = false;
  }
}

watch(query, (q) => {
  emit("update:active", q.trim().length > 0);
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

// A different folder means a different set of files; results for the old
// one would be answers to a question nobody is asking any more.
watch(() => props.root, () => {
  query.value = "";
  clear();
});

// A different algorithm is a different question about the same text.
watch(mode, () => { if (query.value.trim()) void run(); });

// Encryption changed somewhere: ask again, so nothing read from a body that
// is now ciphertext stays on screen.
watch(() => workspace.sealed.value, () => { if (query.value.trim()) void run(); });

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  seq++;
});

defineExpose({
  focus() {
    input.value?.focus();
  },
  /** Ask again with the same text — after files changed on disk. */
  refresh() {
    if (query.value.trim()) void run();
  },
});
</script>

<template>
  <div class="border-b border-current/10 px-2 py-1.5" data-testid="workspace-search-panel">
    <input ref="input" v-model="query" type="search" :placeholder="t('search.placeholder')"
           data-testid="workspace-search" :aria-label="t('search.placeholder')"
           class="w-full rounded-lg border border-accent-2 bg-transparent px-2 py-1 text-xs dark:border-accent-1" />

    <p v-if="error" class="pt-1.5 text-xs text-warn-dark" data-testid="workspace-search-error">{{ error }}</p>

    <ul v-if="hits.length" class="mt-1.5 max-h-[60vh] overflow-y-auto" data-testid="workspace-search-results">
      <li v-for="(hit, i) in hits" :key="hit.path">
        <button type="button" :data-testid="`search-result-${i}`" :title="hit.relPath"
                class="flex w-full flex-col items-start rounded px-1.5 py-1 text-left transition hover:bg-accent-light/10"
                @click="emit('open', { path: hit.path, name: hit.name })">
          <span class="flex w-full items-center gap-1.5">
            <font-awesome-icon :icon="hit.sealed ? 'lock' : 'file'" class="shrink-0 text-[10px] opacity-50" />
            <span class="min-w-0 flex-1 truncate text-xs font-semibold">{{ hit.name }}</span>
            <span class="shrink-0 rounded bg-current/10 px-1 text-[9px] uppercase tracking-wide opacity-60"
                  :data-testid="`search-matched-${i}`">{{ hit.matched.map((m) => t(`search.by.${m}`)).join(" · ") }}</span>
          </span>
          <span v-if="hit.relPath !== hit.name" class="w-full truncate text-[10px] opacity-50">{{ hit.relPath }}</span>
          <span v-if="hit.tags.length" class="flex flex-wrap gap-1 pt-0.5">
            <span v-for="tag in hit.tags" :key="tag" class="rounded bg-accent-light/15 px-1 text-[10px]">{{ tag }}</span>
          </span>
          <span v-if="hit.snippet" class="w-full truncate text-[11px] opacity-70" :data-testid="`search-snippet-${i}`">{{ hit.snippet }}</span>
        </button>
      </li>
    </ul>

    <p v-else-if="searched && !busy && !error" class="pt-1.5 text-center text-xs opacity-40"
       data-testid="workspace-search-empty">
      {{ t("files.searchNoHits") }}
    </p>
  </div>
</template>
