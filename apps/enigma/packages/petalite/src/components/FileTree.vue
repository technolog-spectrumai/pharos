<script setup lang="ts">
// The file tree, drawn once.
//
// Two places list the same folder for different reasons: the sidepanel, to open
// a file, and the Security tab, to seal one. They had grown two copies of the
// same rendering — chevron, folder-or-file-or-padlock, depth indent, truncated
// name — and the copies had already drifted in the details that matter least
// (spacing, borders) while agreeing on the ones that matter most.
//
// What is SHARED is what a row IS: how deep it sits, whether it is open, and
// which of three icons it carries. What is per-caller is what a row is FOR —
// its size, its testid prefix, whether it is disabled, what sits at its right
// edge. Those are props and a slot, not two components.
//
// This holds no store. Rows, and the two questions asked about each of them,
// arrive as props: Petalite must not depend on one app's workspace, and a tree
// that fetched its own rows could disagree with the one beside it.
//
// `font-awesome-icon` is used unqualified, as SelectMenu already does: every
// app registers it globally in its own main.ts, and the test setup stubs it.

/** The shape this needs from a row. Structural on purpose — the workspace
 *  store's `Row` satisfies it without Petalite importing that type. */
export interface TreeRow {
  name: string;
  path: string;
  isDirectory: boolean;
  depth: number;
}

const props = withDefaults(
  defineProps<{
    rows: TreeRow[];
    /** Whether a folder is open — drives the chevron's rotation. */
    isExpanded: (path: string) => boolean;
    /** Whether a file is sealed — a padlock instead of a page. */
    isSealed: (path: string) => boolean;
    /** Prefixes each row's `data-testid`: `${testidPrefix}-${row.name}`. */
    testidPrefix: string;
    /** Hover text. Defaults to the bare name; the sidepanel appends "encrypted"
     *  so the padlock is never the only way to learn why a row will not open. */
    rowTitle?: (row: TreeRow) => string;
    /** Which row reads as current, by path. */
    activePath?: string;
    disabled?: boolean;
    /** `compact` is the sidepanel: small text, tight rows, no separators.
     *  `roomy` is the Security tab: full-size text in a bordered card. */
    density?: "compact" | "roomy";
  }>(),
  {
    rowTitle: undefined,
    activePath: "",
    disabled: false,
    density: "compact",
  },
);

const emit = defineEmits<{ activate: [TreeRow] }>();

/** The indent. A calculation rather than nesting: rows are flat and
 *  depth-tagged, so a folder twelve deep costs no more than one at the top. */
function indent(row: TreeRow): string {
  const base = props.density === "compact" ? "0.5rem" : "0.75rem";
  return `padding-left: calc(${row.depth} * 0.75rem + ${base})`;
}

function titleFor(row: TreeRow): string {
  return props.rowTitle ? props.rowTitle(row) : row.name;
}
</script>

<template>
  <button v-for="row in rows" :key="row.path" type="button"
          class="flex w-full items-center text-left transition hover:bg-accent-light/10"
          :class="[
            density === 'compact'
              ? 'gap-1.5 py-1 pr-2 text-sm'
              : 'gap-2 border-b border-current/10 py-2 pr-3 last:border-0',
            activePath === row.path ? 'font-bold text-accent-light dark:text-accent-dark' : '',
          ]"
          :style="indent(row)"
          :data-testid="`${testidPrefix}-${row.name}`"
          :disabled="disabled"
          @click="emit('activate', row)">
    <font-awesome-icon v-if="row.isDirectory" icon="chevron-right"
                       class="w-2 shrink-0 text-[9px] opacity-50 transition-transform"
                       :class="isExpanded(row.path) ? 'rotate-90' : ''" />
    <span v-else class="w-2 shrink-0" />

    <!-- Sealed rows keep normal opacity and gain a padlock. Grey means "this
         app cannot read that kind of file"; a padlock means "yours, and locked"
         — two different facts that must not share a signal. -->
    <font-awesome-icon
      :icon="row.isDirectory ? 'folder' : isSealed(row.path) ? 'lock' : 'file'"
      class="shrink-0 text-xs"
      :class="row.isDirectory
        ? 'text-accent-light dark:text-accent-dark'
        : isSealed(row.path) ? 'opacity-70' : 'opacity-40'" />

    <span class="min-w-0 flex-1 truncate" :class="density === 'roomy' ? 'text-sm' : ''"
          :title="titleFor(row)">{{ row.name }}</span>

    <!-- The right edge is the caller's: a size in the panel, a SEALED badge in
         the Security tab. -->
    <slot name="trailing" :row="row" />
  </button>
</template>
