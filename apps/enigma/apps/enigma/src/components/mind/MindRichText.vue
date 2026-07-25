<script setup lang="ts">
// Trix wrapper for node notes. Trix registers <trix-editor> as a custom
// element at import time and edits into a hidden <input>; this component only
// bridges modelValue ↔ that input. The HTML that leaves here is re-parsed
// through Trix's own whitelist on every load, and is never rendered via
// v-html anywhere in the app.
//
// Attachments are refused outright (trix-file-accept is cancelled and the
// button group hidden in CSS): a file blob has no business inside the
// encrypted kv document, and Trix would otherwise hold it as a blob: URL that
// dies with the session.
import "trix/dist/trix.css";
import "trix";
import { onBeforeUnmount, onMounted, ref, useId, watch } from "vue";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [string] }>();

const inputId = useId();
const editorEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

function onChange() {
  emit("update:modelValue", inputEl.value?.value ?? "");
}

function onFileAccept(e: Event) {
  e.preventDefault();
}

onMounted(() => {
  editorEl.value?.addEventListener("trix-change", onChange);
  editorEl.value?.addEventListener("trix-file-accept", onFileAccept);
});

onBeforeUnmount(() => {
  editorEl.value?.removeEventListener("trix-change", onChange);
  editorEl.value?.removeEventListener("trix-file-accept", onFileAccept);
});

// External value changes (selection moved, undo/redo) reload the editor; an
// echo of our own trix-change leaves the caret alone.
watch(
  () => props.modelValue,
  (v) => {
    const input = inputEl.value;
    if (!input || v === input.value) return;
    input.value = v;
    const editor = (editorEl.value as (HTMLElement & { editor?: { loadHTML(html: string): void } }) | null)?.editor;
    editor?.loadHTML(v);
  },
);
</script>

<template>
  <div class="mind-trix-wrap">
    <input :id="inputId" ref="inputEl" type="hidden" :value="modelValue" />
    <trix-editor ref="editorEl" :input="inputId" />
  </div>
</template>
