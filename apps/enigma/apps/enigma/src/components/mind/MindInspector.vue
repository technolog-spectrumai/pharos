<script setup lang="ts">
// Selection-bound side panel. Editing happens here rather than on the canvas
// because cytoscape labels are canvas-painted — there is no DOM element to
// attach an inline editor to. Every field writes straight through to the
// orchestrator, which takes ONE undo snapshot per editing session.
//
// The title field keeps a local draft: the orchestrator ignores empty-title
// updates (the validator would drop the node on the next load), so while the
// user has the field cleared the doc keeps the last real title and the field
// re-syncs on the next selection change.
import { computed, nextTick, ref, watch } from "vue";
import { OyaButton, OyaEmptyState, OyaTextField } from "rakotis";
import { computeHiddenNodes, hiddenCounts } from "./mindGraphModel";
import MindRichText from "./MindRichText.vue";
import type { Mind } from "./useMind";

const props = defineProps<{
  mind: Mind;
  darkMode?: boolean;
}>();

const node = computed(() => props.mind.selectedNode.value);
const edge = computed(() => props.mind.selectedEdge.value);

// ── node fields ─────────────────────────────────────────────────────────────

const titleDraft = ref("");
watch(
  node,
  (n) => {
    titleDraft.value = n?.title ?? "";
  },
  { immediate: true },
);

function onTitleInput(v: string) {
  titleDraft.value = v;
  if (node.value) props.mind.updateNodeFields(node.value.id, { title: v });
}

function onContentInput(v: string) {
  if (node.value) props.mind.updateNodeFields(node.value.id, { content: v });
}

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

// ── F2 / post-create focus ──────────────────────────────────────────────────
// OyaTextField's root element IS the <input>, so the component ref exposes it.

const titleField = ref<{ $el: HTMLInputElement } | null>(null);
watch(
  () => props.mind.focusTitleRequest.value,
  async () => {
    await nextTick();
    titleField.value?.$el?.focus();
    titleField.value?.$el?.select();
  },
);
</script>

<template>
  <div
    :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
    class="flex w-full flex-col gap-3 overflow-y-auto rounded-xl border p-3 lg:w-80"
  >
    <!-- node -->
    <template v-if="node">
      <label class="text-xs font-semibold opacity-60">{{ $t('mind.nodeTitle') }}</label>
      <OyaTextField
        ref="titleField"
        :model-value="titleDraft"
        :maxlength="mind.caps.maxTitleLen"
        data-testid="mind-title-input"
        @update:model-value="onTitleInput"
      />

      <div class="flex gap-1 rounded-lg border p-1 text-xs font-semibold" :class="darkMode ? 'border-accent-1' : 'border-accent-2'">
        <button
          type="button"
          data-testid="mind-kind-note"
          :class="node.kind === 'note'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
            : 'opacity-60 hover:opacity-100'"
          class="flex-1 rounded-md px-2 py-1.5 transition"
          @click="mind.setNodeKind(node.id, 'note')"
        >
          {{ $t('mind.kindNote') }}
        </button>
        <button
          type="button"
          data-testid="mind-kind-topic"
          :class="node.kind === 'topic'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
            : 'opacity-60 hover:opacity-100'"
          class="flex-1 rounded-md px-2 py-1.5 transition"
          @click="mind.setNodeKind(node.id, 'topic')"
        >
          {{ $t('mind.kindTopic') }}
        </button>
      </div>

      <label class="text-xs font-semibold opacity-60">{{ $t('mind.nodeContent') }}</label>
      <MindRichText :model-value="node.content" @update:model-value="onContentInput" />

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
