<script setup lang="ts">
// Mind toolbar: tool modes + history + view actions. Mutations go through the
// orchestrator prop; canvas-owned actions (layout, fit) are emitted upward so
// MindMapPanel can call into the graph component that owns the cy instance.
import { useI18n } from "vue-i18n";
import { OyaIconButton } from "rakotis";
import type { Mind } from "./useMind";
import type { MindTool } from "./MindGraph.vue";

defineProps<{
  mind: Mind;
  tool: MindTool;
  darkMode?: boolean;
}>();

const emit = defineEmits<{
  "update:tool": [MindTool];
  "auto-layout": [];
  "zoom-fit": [];
}>();

const { t } = useI18n();

const tools: { id: MindTool; icon: string; key: string }[] = [
  { id: "select", icon: "arrow-pointer", key: "mind.toolSelect" },
  { id: "add-note", icon: "square-plus", key: "mind.toolAddNote" },
  { id: "add-topic", icon: "circle-plus", key: "mind.toolAddTopic" },
  { id: "connect", icon: "link", key: "mind.toolConnect" },
];
</script>

<template>
  <div
    :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
    class="flex flex-wrap items-center gap-2 rounded-xl border p-2"
  >
    <OyaIconButton
      v-for="tb in tools"
      :key="tb.id"
      :icon="tb.icon"
      :label="t(tb.key)"
      :active="tool === tb.id"
      @click="emit('update:tool', tool === tb.id ? 'select' : tb.id)"
    />

    <span class="mx-1 h-6 w-px shrink-0 bg-current opacity-20" />

    <OyaIconButton icon="rotate-left" :label="t('mind.undo')" :disabled="!mind.canUndo.value" @click="mind.undo()" />
    <OyaIconButton icon="rotate-right" :label="t('mind.redo')" :disabled="!mind.canRedo.value" @click="mind.redo()" />

    <span class="mx-1 h-6 w-px shrink-0 bg-current opacity-20" />

    <OyaIconButton icon="sitemap" :label="t('mind.autoLayout')" @click="emit('auto-layout')" />
    <OyaIconButton icon="expand" :label="t('mind.zoomFit')" @click="emit('zoom-fit')" />

    <slot />
  </div>
</template>
