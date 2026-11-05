<script setup lang="ts">
// Topics sub-tab: the map's topic hubs as a browsable list. Clicking one opens
// a read-only details modal — description (rendered through a read-only Trix,
// never v-html) and every node linked to the topic in either direction —
// plus "add note", which creates a fresh note wired note → topic and hands it
// straight to the shared edit modal (mind.editNodeId).
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaEmptyState, OyaModal } from "rakotis";
import MindRichText from "./MindRichText.vue";
import type { Mind } from "./useMind";

const props = defineProps<{
  mind: Mind;
  darkMode?: boolean;
}>();

const { t } = useI18n();

/** Linked = an edge in either direction; a note attaches note → topic, but
 *  hand-drawn topic → note edges count just the same. */
const linkCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const e of props.mind.edges.value) {
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
    counts.set(e.target, (counts.get(e.target) ?? 0) + 1);
  }
  return counts;
});

// ── details modal ───────────────────────────────────────────────────────────

const detailTopicId = ref<string | null>(null);

const detailTopic = computed(() => {
  const id = detailTopicId.value;
  const topic = id ? (props.mind.doc.value.nodes.find((n) => n.id === id) ?? null) : null;
  // The topic can vanish (undo/import) or stop being a topic under the modal.
  return topic?.kind === "topic" ? topic : null;
});

const linkedNodes = computed(() => {
  const id = detailTopicId.value;
  if (!id) return [];
  const ids = new Set<string>();
  for (const e of props.mind.edges.value) {
    if (e.source === id) ids.add(e.target);
    if (e.target === id) ids.add(e.source);
  }
  return props.mind.doc.value.nodes.filter((n) => ids.has(n.id));
});

function addNote() {
  const topic = detailTopic.value;
  if (!topic) return;
  const node = props.mind.addNoteToTopic(topic.id, t("mind.untitled"));
  if (!node) return;
  // Hand off to the shared edit modal. One modal at a time: OyaModal backdrops
  // are appended to <body> in MOUNT order, so a details modal mounted after
  // the editor would sit on top of it and swallow its clicks.
  detailTopicId.value = null;
  props.mind.editNodeId.value = node.id;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
    <OyaEmptyState v-if="!mind.topicNodes.value.length" icon="circle-nodes" size="lg" class="py-10">
      {{ $t('mind.topicsEmpty') }}
    </OyaEmptyState>

    <button
      v-for="topic in mind.topicNodes.value"
      :key="topic.id"
      type="button"
      :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
      class="flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition hover:opacity-70"
      @click="detailTopicId = topic.id"
    >
      <span class="flex min-w-0 items-center gap-2">
        <font-awesome-icon icon="circle-nodes" class="shrink-0 opacity-60" />
        <span class="truncate text-sm font-semibold">{{ topic.title }}</span>
      </span>
      <span class="shrink-0 text-xs opacity-50">
        {{ $t('mind.topicLinkCount', { n: linkCounts.get(topic.id) ?? 0 }) }}
      </span>
    </button>

    <!-- Details (read-only) -->
    <OyaModal :open="detailTopic !== null" @close="detailTopicId = null">
      <div
        v-if="detailTopic"
        class="flex max-h-[80vh] w-full max-w-lg flex-col gap-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      >
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="circle-nodes" />
          <span class="break-words">{{ detailTopic.title }}</span>
        </p>

        <MindRichText v-if="detailTopic.content" :model-value="detailTopic.content" readonly />
        <p v-else class="text-sm opacity-50">{{ $t('mind.topicNoDescription') }}</p>

        <p class="text-xs font-semibold opacity-60">{{ $t('mind.topicLinkedNotes') }}</p>
        <div class="min-h-0 flex-1 space-y-1 overflow-y-auto">
          <p v-if="!linkedNodes.length" class="text-sm opacity-50">{{ $t('mind.topicNoLinked') }}</p>
          <div
            v-for="n in linkedNodes"
            :key="n.id"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="flex items-center justify-between gap-2 rounded-lg border px-3 py-2"
          >
            <span class="truncate text-sm">{{ n.title }}</span>
            <span class="shrink-0 text-xs opacity-50">
              {{ n.kind === 'topic' ? $t('mind.kindTopic') : $t('mind.kindNote') }}
            </span>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex gap-2">
          <OyaButton variant="secondary" @click="detailTopicId = null">{{ $t('mind.close') }}</OyaButton>
          <OyaButton data-testid="mind-topic-add-note" :disabled="mind.mapFull.value || mind.edgesFull.value" @click="addNote">
            <font-awesome-icon icon="square-plus" />
            {{ $t('mind.topicAddNote') }}
          </OyaButton>
        </div>
      </template>
    </OyaModal>
  </div>
</template>
