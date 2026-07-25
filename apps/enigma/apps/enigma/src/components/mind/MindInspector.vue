<script setup lang="ts">
// Selection-bound side panel. Node TEXT editing lives in the edit modal
// (MindNodeEditModal — one commit model, Save/Discard); this panel keeps the
// selection summary and the quick actions. Edge editing stays here: a label
// is one small field, and the reattach buttons need the canvas anyway.
import { computed, ref, watch } from "vue";
import { OyaButton, OyaEmptyState, OyaTextField } from "rakotis";
import { computeHiddenNodes, hiddenCounts } from "./mindGraphModel";
import type { Mind } from "./useMind";

const props = defineProps<{
  mind: Mind;
  darkMode?: boolean;
}>();

const node = computed(() => props.mind.selectedNode.value);
const edge = computed(() => props.mind.selectedEdge.value);

const hasOutgoing = computed(() => !!node.value && props.mind.edges.value.some((e) => e.source === node.value!.id));

const hiddenBelow = computed(() => {
  const n = node.value;
  if (!n || !n.collapsed) return 0;
  const nodes = props.mind.doc.value.nodes;
  const edges = props.mind.doc.value.edges;
  return hiddenCounts(nodes, edges, computeHiddenNodes(nodes, edges)).get(n.id) ?? 0;
});

// ── edge fields ─────────────────────────────────────────────────────────────

const labelDraft = ref("");
watch(
  edge,
  (e) => {
    labelDraft.value = e?.label ?? "";
  },
  { immediate: true },
);

function onLabelInput(v: string) {
  labelDraft.value = v;
  if (edge.value) props.mind.updateEdgeLabel(edge.value.id, v);
}

const edgeEnds = computed(() => {
  const e = edge.value;
  if (!e) return null;
  const from = props.mind.doc.value.nodes.find((n) => n.id === e.source);
  const to = props.mind.doc.value.nodes.find((n) => n.id === e.target);
  return { from: from?.title ?? "?", to: to?.title ?? "?" };
});
</script>

<template>
  <div
    :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
    class="flex w-full flex-col gap-3 overflow-y-auto rounded-xl border p-3 lg:w-80"
  >
    <!-- node -->
    <template v-if="node">
      <p class="break-words text-sm font-semibold">{{ node.title }}</p>
      <p class="text-xs opacity-60">{{ node.kind === 'topic' ? $t('mind.kindTopic') : $t('mind.kindNote') }}</p>

      <OyaButton data-testid="mind-open-edit" @click="mind.editNodeId.value = node.id">
        <font-awesome-icon icon="pen" />
        {{ $t('mind.editNode') }}
      </OyaButton>

      <OyaButton
        v-if="node.collapsed || hasOutgoing"
        variant="secondary"
        @click="mind.toggleCollapsed(node.id)"
      >
        <font-awesome-icon :icon="node.collapsed ? 'square-plus' : 'square-minus'" />
        {{ node.collapsed ? $t('mind.expand', { n: hiddenBelow }) : $t('mind.collapse') }}
      </OyaButton>

      <OyaButton variant="secondary" data-testid="mind-delete-node" @click="mind.deleteNode(node.id)">
        <font-awesome-icon icon="trash" />
        {{ $t('mind.deleteNode') }}
      </OyaButton>
    </template>

    <!-- edge -->
    <template v-else-if="edge && edgeEnds">
      <p class="break-words text-sm font-semibold">{{ edgeEnds.from }} → {{ edgeEnds.to }}</p>

      <label class="text-xs font-semibold opacity-60">{{ $t('mind.edgeLabel') }}</label>
      <OyaTextField
        :model-value="labelDraft"
        :maxlength="mind.caps.maxTitleLen"
        data-testid="mind-label-input"
        @update:model-value="onLabelInput"
      />

      <OyaButton variant="secondary" data-testid="mind-swap-edge" @click="mind.swapEdgeDirection(edge.id)">
        <font-awesome-icon icon="rotate" />
        {{ $t('mind.swapDirection') }}
      </OyaButton>
      <div class="flex gap-2">
        <OyaButton
          variant="secondary"
          class="flex-1"
          @click="mind.reconnectRequest.value = { edgeId: edge.id, end: 'source' }"
        >
          {{ $t('mind.changeSource') }}
        </OyaButton>
        <OyaButton
          variant="secondary"
          class="flex-1"
          @click="mind.reconnectRequest.value = { edgeId: edge.id, end: 'target' }"
        >
          {{ $t('mind.changeTarget') }}
        </OyaButton>
      </div>

      <OyaButton variant="secondary" data-testid="mind-delete-edge" @click="mind.deleteEdge(edge.id)">
        <font-awesome-icon icon="trash" />
        {{ $t('mind.deleteEdge') }}
      </OyaButton>
    </template>

    <OyaEmptyState v-else icon="diagram-project" class="py-8">{{ $t('mind.inspectorEmpty') }}</OyaEmptyState>
  </div>
</template>
