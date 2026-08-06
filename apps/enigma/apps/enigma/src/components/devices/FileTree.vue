<script setup lang="ts">
// Flat-list file tree (the toto vault pattern): the parent hands us a DFS-ordered
// array of {id, pid, depth, kind} rows and we never recurse in the template —
// indentation is a computed padding-left and visibility is a parent-chain walk.
// One component renders both "this device" (selectable, action slots) and the
// per-sibling buckets (names only, marker badges).
import { computed, reactive } from "vue";

export interface TreeItem {
  id: string;
  /** Parent dir row id; null = root of this bucket. */
  pid: string | null;
  depth: number;
  kind: "dir" | "file";
  name: string;
  size?: number;
  /** Sync state relative to the comparison device; absent = in sync / n.a. */
  marker?: "missing" | "excess" | "changed" | "notShared";
  /** Key-ring locked (shows the key icon). */
  locked?: boolean;
  /** File rows only: whether the checkbox is offered. */
  selectable?: boolean;
  /** Dir rows only: direct child counts for the chip. */
  nDirs?: number;
  nFiles?: number;
}

const props = defineProps<{
  items: TreeItem[];
  /** Ids of selected file rows (parent owns the set). */
  selection?: Set<string>;
  /** Grey the checkboxes without hiding them (e.g. while a batch runs). */
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: "toggle-select", id: string): void }>();

// Expand state — dirs start open (the trees here are small; surprise-free).
// Collapsing recursively closes descendants so re-open is always shallow.
const closedDirs = reactive(new Set<string>());
const isOpen = (id: string) => !closedDirs.has(id);

const byId = computed(() => {
  const map = new Map<string, TreeItem>();
  for (const item of props.items) map.set(item.id, item);
  return map;
});

function toggleDir(item: TreeItem) {
  if (item.kind !== "dir") return;
  if (closedDirs.has(item.id)) {
    closedDirs.delete(item.id);
  } else {
    closedDirs.add(item.id);
    for (const child of props.items) {
      if (child.kind === "dir" && isDescendantOf(child, item.id)) closedDirs.add(child.id);
    }
  }
}

function isDescendantOf(item: TreeItem, ancestorId: string): boolean {
  let pid = item.pid;
  while (pid !== null) {
    if (pid === ancestorId) return true;
    pid = byId.value.get(pid)?.pid ?? null;
  }
  return false;
}

/** Visible ⇔ every ancestor dir is open. Root rows are always visible. */
function isVisible(item: TreeItem): boolean {
  let pid = item.pid;
  while (pid !== null) {
    if (closedDirs.has(pid)) return false;
    pid = byId.value.get(pid)?.pid ?? null;
  }
  return true;
}

const visibleItems = computed(() => props.items.filter(isVisible));

function fmtSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

// Marker → badge styling. Colors deliberately echo the app's existing accents:
// amber = needs attention here, violet = only exists here, orange = diverged.
const MARKER_CLASS: Record<NonNullable<TreeItem["marker"]>, string> = {
  missing: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  excess: "border-violet-500/40 bg-violet-500/10 text-violet-400",
  changed: "border-orange-500/40 bg-orange-500/10 text-orange-500",
  notShared: "border-current/20 bg-current/5 opacity-60",
};
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-accent-2 dark:border-accent-1">
    <div
      v-for="item in visibleItems"
      :key="item.id"
      class="group flex items-center gap-2 border-b border-accent-2/40 py-1.5 pr-3 last:border-b-0 dark:border-accent-1/40"
      :class="item.kind === 'dir' ? 'cursor-pointer select-none' : ''"
      :style="`padding-left: calc(${item.depth} * 1.25rem + 0.75rem)`"
      :data-testid="`tree-row-${item.id}`"
      @click="item.kind === 'dir' && toggleDir(item)"
    >
      <!-- Dir row: chevron + folder + counts -->
      <template v-if="item.kind === 'dir'">
        <font-awesome-icon
          icon="chevron-right"
          class="w-3 text-xs opacity-50 transition-transform"
          :class="isOpen(item.id) ? 'rotate-90' : ''"
        />
        <font-awesome-icon
          :icon="isOpen(item.id) ? 'folder-open' : 'folder'"
          class="text-accent-light dark:text-accent-dark"
        />
        <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ item.name }}</span>
        <span v-if="item.nDirs || item.nFiles" class="text-xs opacity-40">
          {{ item.nDirs || 0 }} · {{ item.nFiles || 0 }}
        </span>
      </template>

      <!-- File row: checkbox + icon + name + badges + slot actions -->
      <template v-else>
        <input
          v-if="item.selectable"
          type="checkbox"
          class="ml-4 accent-current"
          :checked="selection?.has(item.id)"
          :disabled="disabled"
          :data-testid="`tree-check-${item.id}`"
          @click.stop
          @change="emit('toggle-select', item.id)"
        />
        <span v-else class="ml-4 w-3" />
        <font-awesome-icon
          :icon="item.locked ? 'key' : 'file'"
          class="text-sm"
          :class="item.locked ? 'text-accent-light dark:text-accent-dark' : 'opacity-30'"
        />
        <span
          class="min-w-0 flex-1 truncate text-sm"
          :class="item.marker === 'missing' ? 'opacity-45 italic' : ''"
        >{{ item.name }}</span>
        <span
          v-if="item.marker"
          class="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          :class="MARKER_CLASS[item.marker]"
          :data-testid="`tree-marker-${item.id}`"
        >
          <slot name="marker-label" :marker="item.marker">{{ item.marker }}</slot>
        </span>
        <span v-if="item.size !== undefined" class="shrink-0 text-xs opacity-40">
          {{ fmtSize(item.size) }}
        </span>
        <!-- Hover-revealed per-row actions (the toto convention). -->
        <span class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
          <slot name="actions" :item="item" />
        </span>
      </template>
    </div>
    <p v-if="!items.length" class="px-3 py-4 text-center text-xs opacity-40">
      <slot name="empty" />
    </p>
  </div>
</template>
