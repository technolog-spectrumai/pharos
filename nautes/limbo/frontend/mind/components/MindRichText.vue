<script setup lang="ts">
// Trix wrapper for node notes. Trix registers <trix-editor> as a custom
// element at import time and edits into a hidden <input>; this component only
// bridges modelValue ↔ that input. The HTML that leaves here is re-parsed
// through Trix's own whitelist on every load, and is never rendered via
// v-html anywhere in the app.
//
// Trix is fully offline: the JS and CSS are bundled by Vite (npm dep, no CDN)
// and every toolbar icon in trix.css is an inline data: SVG — nothing in the
// editor ever fetches. Keeping it that way takes three guards, because the
// webview ships with NO CSP and would happily fetch a remote <img>:
// - trix-file-accept is cancelled and the attach button hidden in CSS: a file
//   blob has no business inside the encrypted kv document;
// - trix-attachment-add removes anything that slips through another pipeline;
// - rich pastes are intercepted in the CAPTURE phase and scrubbed BEFORE Trix
//   parses them — Trix parses pasted HTML by assigning innerHTML, and a remote
//   <img> would start its network fetch right there, even detached.
// The same scrub runs at validation (kv load + import), so stored content can
// never carry a fetchable reference either.
import "trix/dist/trix.css";
import "trix";
import { onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { scrubContentHtml } from "./mindModel";

const props = defineProps<{
  modelValue: string;
  /** Display-only rendering (Topics details): toolbar hidden via CSS, the
   *  editing surface locked. Still Trix, so stored HTML renders exactly as it
   *  was written — and still never v-html. */
  readonly?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [string] }>();

const inputId = useId();
const editorEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

type TrixEditorElement = HTMLElement & {
  editor?: { loadHTML(html: string): void; insertHTML(html: string): void };
};

function onChange() {
  emit("update:modelValue", inputEl.value?.value ?? "");
}

function onFileAccept(e: Event) {
  e.preventDefault();
}

function onAttachmentAdd(e: Event) {
  (e as Event & { attachment?: { remove(): void } }).attachment?.remove();
}

function onPaste(e: ClipboardEvent) {
  const html = e.clipboardData?.getData("text/html");
  if (!html || !/<(img|picture|source|video|audio|iframe|object|embed|figure)\b|\ssrc\s*=/i.test(html)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  (editorEl.value as TrixEditorElement | null)?.editor?.insertHTML(scrubContentHtml(html));
}

onMounted(() => {
  editorEl.value?.addEventListener("trix-change", onChange);
  editorEl.value?.addEventListener("trix-file-accept", onFileAccept);
  editorEl.value?.addEventListener("trix-attachment-add", onAttachmentAdd);
  editorEl.value?.addEventListener("paste", onPaste, true);
  if (props.readonly) editorEl.value?.setAttribute("contenteditable", "false");
});

onBeforeUnmount(() => {
  editorEl.value?.removeEventListener("trix-change", onChange);
  editorEl.value?.removeEventListener("trix-file-accept", onFileAccept);
  editorEl.value?.removeEventListener("trix-attachment-add", onAttachmentAdd);
  editorEl.value?.removeEventListener("paste", onPaste, true);
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
  <div class="mind-trix-wrap" :class="{ 'mind-trix-readonly': readonly }">
    <input :id="inputId" ref="inputEl" type="hidden" :value="modelValue" />
    <trix-editor ref="editorEl" :input="inputId" />
  </div>
</template>
