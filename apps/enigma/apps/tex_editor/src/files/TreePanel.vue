<script setup lang="ts">
// The workspace's file tree.
//
// Petalite's `FileTree` draws it; everything interesting — building the paths,
// deciding what is visible under a collapsed folder — is in `rows.ts`, pure and
// tested. This component holds the expansion set and turns a click into an id.
import { computed, ref, watch } from "vue";
import FileTree from "petalite/FileTree.vue";
import type { TreeItem } from "totoapi";
import { toRows, visible, isOpenable, type Row } from "./rows";

const props = defineProps<{
  // `readonly` because the store hands out a `readonly` reactive object and a
  // mutable prop would need a cast at every call site. A component has no
  // business mutating the tree it was given, so the type says so.
  items: readonly TreeItem[];
  /** The open buffer, by server id — not by path. */
  activeId: number | null;
}>();

const emit = defineEmits<{ open: [Row] }>();

const expanded = ref(new Set<string>());
const rows = computed(() => toRows([...props.items]));
const shown = computed(() => visible(rows.value, expanded.value));

const activePath = computed(
  () => rows.value.find((r) => r.id === props.activeId)?.path ?? "",
);

// A workspace change resets the expansion, or folders from the last one stay
// "open" and the first render of the new tree is arbitrary.
watch(() => props.items, () => { expanded.value = new Set(); });

function activate(row: { path: string }) {
  const full = rows.value.find((r) => r.path === row.path);
  if (!full) return;
  if (full.isDirectory) {
    // A new Set, not a mutation: Vue's reactivity does not track Set membership.
    const next = new Set(expanded.value);
    if (next.has(full.path)) next.delete(full.path); else next.add(full.path);
    expanded.value = next;
    return;
  }
  if (isOpenable(full)) emit("open", full);
}

/** Hover text. The padlock is never the only way to learn why a row will not
 *  open — the same rule the sidepanel follows. */
function rowTitle(row: { path: string }) {
  const full = rows.value.find((r) => r.path === row.path);
  if (!full) return row.path;
  if (full.encrypted) return `${full.name} — encrypted`;
  if (full.readonly) return `${full.name} — produced by a run`;
  return full.name;
}

function isExpanded(path: string) {
  return expanded.value.has(path);
}

function isSealed(path: string) {
  return rows.value.find((r) => r.path === path)?.encrypted ?? false;
}
</script>

<template>
  <FileTree
    :rows="shown"
    :is-expanded="isExpanded"
    :is-sealed="isSealed"
    :row-title="rowTitle"
    :active-path="activePath"
    testid-prefix="tree"
    density="compact"
    @activate="activate"
  />
</template>
