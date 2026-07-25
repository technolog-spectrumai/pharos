<script setup lang="ts">
// Dump sub-tab: the capture inbox. Type fast, sort later — an entry leaves the
// list by being linked to a topic (it becomes a note node under it) or deleted.
// Captures persist IMMEDIATELY (no debounce): a jotted thought should hit disk
// before the app closes.
import { computed, ref } from "vue";
import { OyaButton, OyaEmptyState, OyaModal, OyaTextArea } from "rakotis";
import type { MindDumpEntry } from "./mindModel";
import type { Mind } from "./useMind";

const props = defineProps<{
  mind: Mind;
  darkMode?: boolean;
}>();

const draft = ref("");

/** Chronological capture order, newest first for reading. */
const entries = computed(() => [...props.mind.dump.value.entries].reverse());

function capture() {
  if (props.mind.addDumpEntry(draft.value)) draft.value = "";
}

/** Ctrl/Cmd+Enter captures without leaving the textarea. */
function onDraftKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    capture();
  }
}

function stamp(entry: MindDumpEntry): string {
  return new Date(entry.createdAt).toLocaleString();
}

// ── link-to-topic picker ────────────────────────────────────────────────────
const linkEntryId = ref<string | null>(null);

function linkTo(topicId: string) {
  if (linkEntryId.value) props.mind.linkDumpEntryToTopic(linkEntryId.value, topicId);
  linkEntryId.value = null;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <div :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="rounded-xl border p-3" @keydown="onDraftKey">
      <OyaTextArea
        v-model="draft"
        :rows="3"
        :placeholder="$t('mind.dumpPlaceholder')"
        :disabled="mind.dumpFull.value"
      />
      <div class="mt-2 flex items-center justify-between gap-2">
        <p v-if="mind.dumpFull.value" class="text-xs text-warn-dark">
          {{ $t('mind.dumpFull', { n: mind.caps.maxDumpEntries }) }}
        </p>
        <span v-else />
        <OyaButton :disabled="!draft.trim() || mind.dumpFull.value" @click="capture">
          <font-awesome-icon icon="lightbulb" />
          {{ $t('mind.dumpAdd') }}
        </OyaButton>
      </div>
    </div>

    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto">
      <OyaEmptyState v-if="!entries.length" icon="lightbulb" size="lg" class="py-10">
        {{ $t('mind.dumpEmpty') }}
      </OyaEmptyState>
      <div
        v-for="entry in entries"
        :key="entry.id"
        :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
        class="rounded-xl border p-3"
      >
        <p class="whitespace-pre-wrap break-words text-sm">{{ entry.text }}</p>
        <div class="mt-2 flex items-center justify-between gap-2">
          <p class="text-xs opacity-50">{{ stamp(entry) }}</p>
          <div class="flex gap-2">
            <OyaButton variant="secondary" @click="linkEntryId = entry.id">
              <font-awesome-icon icon="link" />
              {{ $t('mind.linkToTopic') }}
            </OyaButton>
            <OyaButton variant="secondary" @click="mind.deleteDumpEntry(entry.id)">
              <font-awesome-icon icon="trash" />
              {{ $t('mind.deleteEntry') }}
            </OyaButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Topic picker -->
    <OyaModal :open="linkEntryId !== null" @close="linkEntryId = null">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="link" />
          {{ $t('mind.chooseTopic') }}
        </p>
        <p v-if="!mind.topicNodes.value.length" class="text-sm opacity-70">
          {{ $t('mind.noTopics') }}
        </p>
        <div v-else class="max-h-64 space-y-1 overflow-y-auto">
          <button
            v-for="topic in mind.topicNodes.value"
            :key="topic.id"
            type="button"
            class="block w-full truncate rounded-lg border border-accent-2 px-3 py-2 text-left text-sm transition hover:opacity-70 dark:border-accent-1"
            @click="linkTo(topic.id)"
          >
            {{ topic.title }}
          </button>
        </div>
        <div class="flex justify-end pt-1">
          <OyaButton variant="secondary" @click="linkEntryId = null">{{ $t('mind.cancel') }}</OyaButton>
        </div>
      </div>
    </OyaModal>
  </div>
</template>
