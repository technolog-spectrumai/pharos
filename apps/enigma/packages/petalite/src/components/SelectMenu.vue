<script setup lang="ts">
// A dropdown the app actually controls.
//
// This exists because a native `<select>` cannot be themed on this platform.
// WebKitGTK renders the closed control from CSS but draws the OPEN list as a
// GTK popup menu, which ignores `option { background }` entirely and takes its
// colours from the desktop theme — so on a dark GTK desktop the layout chooser
// stayed dark no matter what the app's theme was, and `.oya-select` could never
// have fixed it.
//
// Same construction as the app menu: a full-screen backdrop for outside-click
// rather than a document listener, so there is nothing to leak.
import { computed, ref } from "vue";

const props = defineProps<{
  modelValue: string;
  options: readonly string[];
  /** Shown for an option whose own text would be blank. */
  emptyLabel?: string;
  label?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [string] }>();

const open = ref(false);

const display = computed(() => props.modelValue || props.emptyLabel || "—");

function choose(value: string) {
  open.value = false;
  if (value !== props.modelValue) emit("update:modelValue", value);
}
</script>

<template>
  <div class="relative inline-block" @keydown.esc.stop="open = false">
    <button
      type="button"
      class="relative z-30 flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition
             border-accent-2 hover:opacity-80 dark:border-accent-1"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      data-testid="select-trigger"
      @click="open = !open"
    >
      <span>{{ display }}</span>
      <font-awesome-icon icon="chevron-down" class="text-[9px] opacity-60" />
    </button>

    <div v-if="open" class="fixed inset-0 z-20" @click="open = false" />
    <div
      v-if="open"
      role="listbox"
      data-testid="select-panel"
      class="absolute left-0 top-full z-30 mt-1 max-h-60 min-w-full overflow-y-auto rounded-lg border py-1 shadow-xl
             border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark"
    >
      <button
        v-for="option in options"
        :key="option"
        type="button"
        role="option"
        :aria-selected="option === modelValue"
        class="block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs transition hover:bg-accent-light/10"
        :class="option === modelValue && 'font-bold text-accent-light dark:text-accent-dark'"
        :data-testid="`select-option-${option || 'empty'}`"
        @click="choose(option)"
      >
        {{ option || emptyLabel || "—" }}
      </button>
    </div>
  </div>
</template>
