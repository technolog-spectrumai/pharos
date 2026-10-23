<script setup lang="ts">
// The one node editor. Opened from the canvas ✎ chip, the inspector's Edit
// button, F2, node creation, and the Topics tab's "add note" — whoever sets
// `mind.editNodeId`. Everything is edited into LOCAL drafts and lands in the
// document only on Save (one `commitNodeEdit` = one undo step); Discard drops
// the drafts on the floor. The singleton ref doubling as the open flag is what
// lets the view's keyboard handler hold its fire while the modal is up.
//
// Content edits in two modes: rich (Trix) or plain text. Flipping rich → plain
// converts through htmlToPlainText and sheds formatting — that is the point of
// the flip, not an accident; plain drafts are re-escaped to HTML on Save.
import { computed, ref, watch } from "vue";
import { OyaButton, OyaModal, OyaTextArea, OyaTextField } from "rakotis";
import { htmlToPlainText, plainTextToHtml, type MindNodeKind } from "./mindModel";
import MindRichText from "./MindRichText.vue";
import type { Mind } from "./useMind";

const props = defineProps<{
  mind: Mind;
  darkMode?: boolean;
}>();

const open = computed(() => props.mind.editNodeId.value !== null);
const node = computed(() => {
  const id = props.mind.editNodeId.value;
  return id ? (props.mind.doc.value.nodes.find((n) => n.id === id) ?? null) : null;
});

const titleDraft = ref("");
const kindDraft = ref<MindNodeKind>("note");
const contentHtml = ref("");
const contentPlain = ref("");
const mode = ref<"rich" | "plain">("rich");

// Seed drafts when the modal opens (or is retargeted at another node).
watch(
  () => props.mind.editNodeId.value,
  (id) => {
    if (!id) return;
    const n = props.mind.doc.value.nodes.find((nn) => nn.id === id);
    if (!n) {
      props.mind.editNodeId.value = null;
      return;
    }
    titleDraft.value = n.title;
    kindDraft.value = n.kind;
    contentHtml.value = n.content;
    contentPlain.value = "";
    mode.value = "rich";
  },
  { immediate: true },
);

// The node can vanish under an open modal (undo, import) — close, drafts and all.
watch(node, (n) => {
  if (props.mind.editNodeId.value && !n) props.mind.editNodeId.value = null;
});

function setMode(next: "rich" | "plain") {
  if (mode.value === next) return;
  if (next === "plain") contentPlain.value = htmlToPlainText(contentHtml.value);
  else contentHtml.value = plainTextToHtml(contentPlain.value);
  mode.value = next;
}

function submit() {
  const id = props.mind.editNodeId.value;
  if (id) {
    props.mind.commitNodeEdit(id, {
      title: titleDraft.value,
      kind: kindDraft.value,
      content: mode.value === "rich" ? contentHtml.value : plainTextToHtml(contentPlain.value),
    });
  }
  props.mind.editNodeId.value = null;
}

function reject() {
  props.mind.editNodeId.value = null;
}
</script>

<template>
  <OyaModal :open="open" @close="reject">
    <form
      class="w-full max-w-lg space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      @submit.prevent="submit"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="pen" />
        {{ $t('mind.editNodeTitle') }}
      </p>

      <label class="text-xs font-semibold opacity-60">{{ $t('mind.nodeTitle') }}</label>
      <OyaTextField
        :model-value="titleDraft"
        :maxlength="mind.caps.maxTitleLen"
        data-testid="mind-edit-title"
        @update:model-value="titleDraft = $event"
      />

      <div class="flex gap-1 rounded-lg border p-1 text-xs font-semibold" :class="darkMode ? 'border-accent-1' : 'border-accent-2'">
        <button
          type="button"
          data-testid="mind-edit-kind-note"
          :class="kindDraft === 'note'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
            : 'opacity-60 hover:opacity-100'"
          class="flex-1 rounded-md px-2 py-1.5 transition"
          @click="kindDraft = 'note'"
        >
          {{ $t('mind.kindNote') }}
        </button>
        <button
          type="button"
          data-testid="mind-edit-kind-topic"
          :class="kindDraft === 'topic'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
            : 'opacity-60 hover:opacity-100'"
          class="flex-1 rounded-md px-2 py-1.5 transition"
          @click="kindDraft = 'topic'"
        >
          {{ $t('mind.kindTopic') }}
        </button>
      </div>

      <div class="flex items-center justify-between gap-2">
        <label class="text-xs font-semibold opacity-60">{{ $t('mind.nodeContent') }}</label>
        <div class="flex gap-1 rounded-lg border p-0.5 text-xs" :class="darkMode ? 'border-accent-1' : 'border-accent-2'">
          <button
            type="button"
            data-testid="mind-edit-mode-rich"
            :class="mode === 'rich'
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
              : 'opacity-60 hover:opacity-100'"
            class="rounded-md px-2 py-1 transition"
            @click="setMode('rich')"
          >
            {{ $t('mind.modeRich') }}
          </button>
          <button
            type="button"
            data-testid="mind-edit-mode-plain"
            :class="mode === 'plain'
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
              : 'opacity-60 hover:opacity-100'"
            class="rounded-md px-2 py-1 transition"
            @click="setMode('plain')"
          >
            {{ $t('mind.modePlain') }}
          </button>
        </div>
      </div>

      <MindRichText v-if="mode === 'rich'" :model-value="contentHtml" @update:model-value="contentHtml = $event" />
      <OyaTextArea
        v-else
        :model-value="contentPlain"
        :rows="8"
        data-testid="mind-edit-plain"
        @update:model-value="contentPlain = $event"
      />

      <div class="flex justify-end gap-2 pt-1">
        <OyaButton variant="secondary" type="button" data-testid="mind-edit-discard" @click="reject">
          <font-awesome-icon icon="xmark" />
          {{ $t('mind.discard') }}
        </OyaButton>
        <OyaButton type="submit" data-testid="mind-edit-save">
          <font-awesome-icon icon="check" />
          {{ $t('mind.save') }}
        </OyaButton>
      </div>
    </form>
  </OyaModal>
</template>
