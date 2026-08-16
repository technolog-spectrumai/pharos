<script setup lang="ts">
// Cyprian's document editor, under zinnia's editor contract (./types.ts).
//
// The host owns the file; this owns the document. The body is edited in TipTap
// with cyprian's own schema (./cyprianSchema.ts); everything else about the
// document — title, font, margins, contents page, cover, metadata — is envelope
// state kept beside it and serialised together by ../formats/document.
//
// Dirtiness is measured against what we WOULD write, the same rule the sketch
// editor uses and for the same reason: re-serialising normalises the markup, so
// comparing against the bytes we read marks every opened document unsaved.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import OyaButton from "rakotis/components/primitives/OyaButton.vue";
import OyaIconButton from "rakotis/components/primitives/OyaIconButton.vue";
import OyaModal from "rakotis/components/primitives/OyaModal.vue";
import OyaTextField from "rakotis/components/primitives/OyaTextField.vue";
import { useI18n } from "vue-i18n";
import { TONE_ICONS } from "../icons";
import ModalPanel from "../components/ModalPanel.vue";
import FormulaPreview from "../components/FormulaPreview.vue";
import { Editor, EditorContent } from "@tiptap/vue-3";
import { cyprianExtensions, INKS } from "./cyprianSchema";
import {
  DocumentParseError, dumps, loads, newDocument,
  FONTS, MARGINS, TONES, outline, type CyDocument,
} from "../formats/document";

const props = defineProps<{
  path: string | null;
  name: string;
  content: string;
  busy?: boolean;
  error?: string;
  /** Whether this editor's tab is the one on screen. */
  active?: boolean;
}>();

const emit = defineEmits<{
  save: [content: string];
  "update:dirty": [boolean];
  "open-as-text": [];
}>();

const { t } = useI18n({ useScope: "global" });

// ── the document ────────────────────────────────────────────────────────────
const doc = ref<CyDocument>(newDocument());
const parseError = ref("");
// shallowRef: TipTap's Editor is a big non-reactive object; Vue must not walk it.
const editor = shallowRef<Editor | null>(null);

// ── block operations ────────────────────────────────────────────────────────
// The writer's body is ONE continuous document (cyprian's format has no block
// list), so "sections" here are the top-level ProseMirror nodes — a paragraph,
// a heading, a table, a callout. These commands operate on whichever one holds
// the cursor, which is what makes them safe: nothing is addressed by index,
// so there is no stale index to act on.

/** The doc-level child under the cursor: its index and its absolute range. */
function currentBlock() {
  const ed = editor.value;
  if (!ed) return null;
  const { $from } = ed.state.selection;
  if ($from.depth < 1) return null;
  const index = $from.index(0);
  const doc = ed.state.doc;
  let from = 0;
  for (let i = 0; i < index; i++) from += doc.child(i).nodeSize;
  return { index, from, to: from + doc.child(index).nodeSize, doc };
}

function moveBlock(dir: -1 | 1) {
  const ed = editor.value;
  const cur = currentBlock();
  if (!ed || !cur) return;
  const target = cur.index + dir;
  if (target < 0 || target >= cur.doc.childCount) return;
  const node = cur.doc.child(cur.index);
  const neighbour = cur.doc.child(target);
  // Delete the node, then insert it on the far side of its neighbour. After
  // the delete the neighbour sits at the removal point, so both directions
  // resolve against `cur.from`.
  const insertAt = dir === -1 ? cur.from - neighbour.nodeSize : cur.from + neighbour.nodeSize;
  const tr = ed.state.tr.delete(cur.from, cur.to).insert(insertAt, node);
  ed.view.dispatch(tr.scrollIntoView());
  ed.commands.focus(insertAt + 1);
}

function deleteBlock() {
  const ed = editor.value;
  const cur = currentBlock();
  if (!ed || !cur) return;
  if (cur.doc.childCount <= 1) {
    // A document is never empty; the last block clears rather than vanishes.
    ed.commands.setContent("<p></p>");
    return;
  }
  ed.view.dispatch(ed.state.tr.delete(cur.from, cur.to).scrollIntoView());
  ed.commands.focus();
}

function addBlockBelow() {
  const ed = editor.value;
  const cur = currentBlock();
  if (!ed || !cur) return;
  const paragraph = ed.state.schema.nodes.paragraph.create();
  ed.view.dispatch(ed.state.tr.insert(cur.to, paragraph).scrollIntoView());
  // Land the cursor in the block that was just made.
  ed.commands.focus(cur.to + 1);
}

// ── WYSIWYG ⇄ source ────────────────────────────────────────────────────────
// Two views of ONE body, never two documents — zenobia's cyprian rule, kept
// verbatim: switching does not save, and returning to the editor APPLIES the
// source through TipTap's schema (which is also what defuses hostile markup —
// anything the schema does not know is dropped on the way in, exactly as a
// paste would be).
const view = ref<"wysiwyg" | "source">("wysiwyg");
const sourceText = ref("");

function setView(next: "wysiwyg" | "source") {
  if (next === view.value) return;
  if (next === "source") {
    sourceText.value = editor.value?.getHTML() ?? doc.value.content;
  } else {
    editor.value?.commands.setContent(sourceText.value);
    // setContent fires onUpdate, so dirt is tracked the ordinary way.
  }
  view.value = next;
}

let savedContent = props.content;
const dirty = ref(false);

function setDirty(v: boolean) {
  if (dirty.value === v) return;
  dirty.value = v;
  emit("update:dirty", v);
}

/** The document as it would be written right now. */
function currentText(): string {
  const body = view.value === "source"
    ? sourceText.value
    : editor.value?.getHTML() ?? doc.value.content;
  return dumps({ ...doc.value, content: body });
}

function baseline() {
  savedContent = currentText();
  setDirty(false);
}

function touch() {
  setDirty(currentText() !== savedContent);
}

function open(text: string) {
  parseError.value = "";
  try {
    doc.value = text.trim() ? loads(text) : newDocument();
  } catch (err) {
    // A file that is not a cyprian document at all: say so and offer the text
    // editor rather than replacing the user's bytes with a blank document.
    parseError.value = err instanceof DocumentParseError
      ? err.message : String(err);
    return;
  }
  editor.value?.destroy();
  editor.value = new Editor({
    extensions: cyprianExtensions({ placeholder: t("doc.placeholder") }),
    content: doc.value.content,
    onUpdate: touch,
  });
  baseline();
}

// ── envelope edits ──────────────────────────────────────────────────────────
// Page setup and metadata are not the body, so they go through here rather than
// through TipTap — but they are still document changes and must mark it dirty.
function setEnvelope<K extends keyof CyDocument>(key: K, value: CyDocument[K]) {
  doc.value = { ...doc.value, [key]: value };
  touch();
}

/** TipTap types heading levels as a union, not a number — cyprian allows 1-3
 *  (the sanitiser drops h4+, and the outline assumes it). */
const HEADING_LEVELS = [1, 2, 3] as const;

const setupOpen = ref(false);
const headings = computed(() => outline(editor.value?.getHTML() ?? doc.value.content));

// ── formula ─────────────────────────────────────────────────────────────────
const formulaOpen = ref(false);
const formulaInput = ref("");

async function confirmFormula() {
  const latex = formulaInput.value.trim();
  if (!latex || !editor.value) return;
  let rendered = "";
  try {
    // KaTeX renders to static HTML, which is exactly what the format caches so
    // the PDF (no JavaScript) has something to show.
    const katex = await import("katex");
    rendered = katex.default.renderToString(latex, { throwOnError: false });
  } catch {
    rendered = ""; // the format falls back to showing the source
  }
  editor.value.chain().focus().insertContent({
    type: "formula", attrs: { latex, rendered },
  }).run();
  formulaOpen.value = false;
  formulaInput.value = "";
}

// ── toolbar commands ────────────────────────────────────────────────────────
const chain = () => editor.value?.chain().focus();
const isActive = (name: string, attrs?: Record<string, unknown>) =>
  editor.value?.isActive(name, attrs) ?? false;

function setInk(ink: string) {
  const c = chain();
  if (!c) return;
  // The mark's own command, so the class prefix stays in one place.
  (c as unknown as { setCyInk(v: string): { run(): void } }).setCyInk(ink).run();
}

function setCallout(tone: string) {
  chain()?.toggleWrap("callout", { tone }).run();
}

onMounted(() => {
  open(props.content);
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  editor.value?.destroy();
  editor.value = null;
});

// Save As renames the file; the buffer is unchanged, so do NOT re-open it.
watch(() => props.path, () => undefined);

function onKey(e: KeyboardEvent) {
  // Every visited tab stays mounted, so every editor has a live window
  // listener. Without this gate one Ctrl+S saves all of them at once.
  if (props.active === false) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!props.busy) emit("save", currentText());
  }
}

defineExpose({
  markSaved() {
    savedContent = currentText();
    setDirty(false);
  },
  getContent(): string {
    return currentText();
  },
  isDirty(): boolean {
    return dirty.value;
  },
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="error" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
      {{ error }}
    </p>

    <!-- Not a cyprian document: say so, offer the editor that can open it. -->
    <div v-if="parseError" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <font-awesome-icon icon="triangle-exclamation" class="text-3xl text-warn-dark" />
      <p class="text-sm font-semibold">{{ t("doc.notADocument") }}</p>
      <p class="max-w-md text-sm opacity-70" data-testid="doc-parse-error">{{ parseError }}</p>
      <OyaButton variant="secondary" @click="emit('open-as-text')">
        {{ t("file.openAsText") }}
      </OyaButton>
    </div>

    <template v-else-if="editor">
      <!-- Toolbar -->
      <div class="flex flex-wrap items-center gap-1 border-b border-current/10 px-3 py-1.5">
        <OyaIconButton size="sm" icon="rotate-left" :label="t('doc.undo')" class="oya-tip" :data-tip="t('doc.undo')" @click="chain()?.undo().run()" />
        <OyaIconButton size="sm" icon="rotate-right" :label="t('doc.redo')" class="oya-tip" :data-tip="t('doc.redo')" @click="chain()?.redo().run()" />
        <span class="mx-1 h-4 w-px bg-current/20" />

        <OyaIconButton size="sm" icon="bold" :label="t('doc.bold')" class="oya-tip" :data-tip="t('doc.bold')" :active="isActive('bold')"
                       @click="chain()?.toggleBold().run()" />
        <OyaIconButton size="sm" icon="italic" :label="t('doc.italic')" class="oya-tip" :data-tip="t('doc.italic')" :active="isActive('italic')"
                       @click="chain()?.toggleItalic().run()" />
        <OyaIconButton size="sm" icon="underline" :label="t('doc.underline')" class="oya-tip" :data-tip="t('doc.underline')" :active="isActive('underline')"
                       @click="chain()?.toggleUnderline().run()" />
        <span class="mx-1 h-4 w-px bg-current/20" />

        <!-- FontAwesome's numeric glyphs, so a heading button is an icon like
             everything else rather than the one place with letters in it. -->
        <button v-for="level in HEADING_LEVELS" :key="level" type="button"
                class="oya-tip inline-flex h-9 w-9 items-center justify-center gap-0.5 rounded-lg
                       border border-accent-2 transition hover:opacity-80 dark:border-accent-1"
                :data-tip="t('doc.heading', { level })" :title="t('doc.heading', { level })"
                :aria-label="t('doc.heading', { level })"
                :class="isActive('heading', { level }) ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                @click="chain()?.toggleHeading({ level }).run()">
          <font-awesome-icon icon="heading" class="text-[0.7rem]" />
          <font-awesome-icon :icon="String(level)" class="text-[0.55rem]" />
        </button>
        <span class="mx-1 h-4 w-px bg-current/20" />

        <OyaIconButton size="sm" icon="list-ul" :label="t('doc.bulletList')" class="oya-tip" :data-tip="t('doc.bulletList')" :active="isActive('bulletList')"
                       @click="chain()?.toggleBulletList().run()" />
        <OyaIconButton size="sm" icon="list-ol" :label="t('doc.orderedList')" class="oya-tip" :data-tip="t('doc.orderedList')" :active="isActive('orderedList')"
                       @click="chain()?.toggleOrderedList().run()" />
        <OyaIconButton size="sm" icon="quote-right" :label="t('doc.quote')" class="oya-tip" :data-tip="t('doc.quote')" :active="isActive('blockquote')"
                       @click="chain()?.toggleBlockquote().run()" />
        <OyaIconButton size="sm" icon="code" :label="t('doc.code')" class="oya-tip" :data-tip="t('doc.code')" :active="isActive('codeBlock')"
                       @click="chain()?.toggleCodeBlock().run()" />
        <span class="mx-1 h-4 w-px bg-current/20" />

        <!-- Colour as a class, never a style attribute — the server strips styles. -->
        <button v-for="ink in INKS" :key="ink" type="button"
                class="oya-tip h-5 w-5 rounded-full border border-current/30 transition hover:scale-110"
                :class="`cy-ink-${ink}`"
                :data-tip="t(`doc.ink.${ink}`)" :title="t(`doc.ink.${ink}`)"
                :aria-label="t(`doc.ink.${ink}`)"
                :data-testid="`ink-${ink}`" @click="setInk(ink)" />
        <span class="mx-1 h-4 w-px bg-current/20" />

        <button v-for="tone in TONES" :key="tone" type="button"
                class="oya-tip inline-flex h-9 w-9 items-center justify-center rounded-lg
                       border border-accent-2 transition hover:opacity-80 dark:border-accent-1"
                :data-tip="t(`doc.tone.${tone}`)" :title="t(`doc.tone.${tone}`)"
                :aria-label="t(`doc.tone.${tone}`)"
                :data-testid="`tone-${tone}`"
                :class="isActive('callout', { tone }) ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                @click="setCallout(tone)">
          <font-awesome-icon :icon="TONE_ICONS[tone]" />
        </button>
        <span class="mx-1 h-4 w-px bg-current/20" />

        <OyaIconButton size="sm" icon="square-root-variable" :label="t('doc.formula')" class="oya-tip" :data-tip="t('doc.formula')"
                       data-testid="doc-formula" @click="formulaOpen = true" />
        <OyaIconButton size="sm" icon="table" :label="t('doc.table')" class="oya-tip" :data-tip="t('doc.table')"
                       @click="chain()?.insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()" />
        <OyaIconButton size="sm" icon="scissors" :label="t('doc.pageBreak')" class="oya-tip" :data-tip="t('doc.pageBreak')"
                       @click="chain()?.insertContent({ type: 'pageBreak' }).run()" />

        <span class="mx-1 h-4 w-px bg-current/20" />
        <OyaIconButton size="sm" icon="square-plus" :label="t('doc.blockAdd')" class="oya-tip"
                       :data-tip="t('doc.blockAdd')" data-testid="blk-add" @click="addBlockBelow" />
        <OyaIconButton size="sm" icon="arrow-up" :label="t('doc.blockUp')" class="oya-tip"
                       :data-tip="t('doc.blockUp')" data-testid="blk-up" @click="moveBlock(-1)" />
        <OyaIconButton size="sm" icon="arrow-down" :label="t('doc.blockDown')" class="oya-tip"
                       :data-tip="t('doc.blockDown')" data-testid="blk-down" @click="moveBlock(1)" />
        <OyaIconButton size="sm" icon="trash" :label="t('doc.blockDelete')" class="oya-tip"
                       :data-tip="t('doc.blockDelete')" data-testid="blk-del" @click="deleteBlock" />

        <span class="flex-1" />

        <!-- Drawing-or-source, the same two-view pill sketch uses in zenobia. -->
        <span class="inline-flex overflow-hidden rounded-lg border border-accent-2 dark:border-accent-1">
          <button type="button" data-testid="view-wysiwyg"
                  class="px-2.5 py-1.5 text-xs font-semibold transition"
                  :class="view === 'wysiwyg'
                    ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                    : 'opacity-55 hover:opacity-100'"
                  @click="setView('wysiwyg')">
            <font-awesome-icon icon="pen-nib" /> {{ t("doc.viewEditor") }}
          </button>
          <button type="button" data-testid="view-source"
                  class="px-2.5 py-1.5 text-xs font-semibold transition"
                  :class="view === 'source'
                    ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
                    : 'opacity-55 hover:opacity-100'"
                  @click="setView('source')">
            <font-awesome-icon icon="code" /> {{ t("doc.viewSource") }}
          </button>
        </span>

        <OyaIconButton size="sm" icon="gear" :label="t('doc.pageSetup')" class="oya-tip" :data-tip="t('doc.pageSetup')"
                       data-testid="doc-setup" @click="setupOpen = true" />
      </div>

      <!-- The sheet -->
      <div class="min-h-0 flex-1 overflow-y-auto bg-sunken-light px-4 py-6 dark:bg-sunken-dark">
        <!-- `cy-doc` is what document.css hangs everything on: the page box, the
             margins, the fonts and --cy-paper / --cy-ink. Paper is a token, not
             a utility class, so the page and the exported PDF cannot drift.
             The border and shadow are zinnia's: on a dark desk the page needs
             an edge, and before this it was #0a0c11 paper on #141821 desk —
             darker than what it sat on, with no visible boundary at all. -->
        <div class="cy-doc mx-auto max-w-3xl rounded border border-black/10 p-10 shadow-lg
                    dark:border-accent-1/40 dark:shadow-black/50"
             :data-margins="doc.margins"
             :class="`cy-font-${doc.font}`">
          <EditorContent v-show="view === 'wysiwyg'" :editor="editor" class="cy-body" data-testid="doc-body" />
          <textarea v-if="view === 'source'" v-model="sourceText" data-testid="doc-source"
                    spellcheck="false"
                    class="min-h-[60vh] w-full resize-y bg-transparent font-mono text-xs leading-relaxed
                           outline-none" />
        </div>
      </div>
    </template>

    <!-- Page setup: the envelope, everything that is not the body. -->
    <OyaModal :open="setupOpen" @close="setupOpen = false">
      <div class="w-full max-w-sm space-y-3">
        <p class="text-sm font-semibold">{{ t("doc.pageSetup") }}</p>

        <label class="block text-xs opacity-70">{{ t("doc.title") }}</label>
        <OyaTextField :model-value="doc.title" data-testid="doc-title"
                      @update:model-value="setEnvelope('title', $event)" />

        <label class="block text-xs opacity-70">{{ t("doc.font") }}</label>
        <div class="flex flex-wrap gap-1">
          <button v-for="f in FONTS" :key="f" type="button"
                  class="rounded border px-2 py-1 text-xs transition border-accent-2 dark:border-accent-1"
                  :class="doc.font === f ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                  @click="setEnvelope('font', f)">{{ f }}</button>
        </div>

        <label class="block text-xs opacity-70">{{ t("doc.margins") }}</label>
        <div class="flex flex-wrap gap-1">
          <button v-for="m in MARGINS" :key="m" type="button"
                  class="rounded border px-2 py-1 text-xs transition border-accent-2 dark:border-accent-1"
                  :class="doc.margins === m ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                  @click="setEnvelope('margins', m)">{{ m }}</button>
        </div>

        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="doc.toc" data-testid="doc-toc"
                 @change="setEnvelope('toc', ($event.target as HTMLInputElement).checked)" />
          {{ t("doc.toc") }}
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="doc.cover"
                 @change="setEnvelope('cover', ($event.target as HTMLInputElement).checked)" />
          {{ t("doc.cover") }}
        </label>

        <p v-if="headings.length" class="text-xs opacity-60">
          {{ t("doc.outlineCount", { n: headings.length }) }}
        </p>

        <div class="flex justify-end">
          <OyaButton @click="setupOpen = false">{{ t("common.close") }}</OyaButton>
        </div>
      </div>
    </OyaModal>

    <OyaModal :open="formulaOpen" @close="formulaOpen = false">
      <ModalPanel :title="t('doc.formula')">
        <OyaTextField v-model="formulaInput" mono placeholder="e^{i\pi}+1=0"
                      data-testid="formula-input" @enter="confirmFormula" />
        <FormulaPreview :latex="formulaInput" />
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="formulaOpen = false">{{ t("common.cancel") }}</OyaButton>
          <OyaButton @click="confirmFormula">{{ t("common.save") }}</OyaButton>
        </div>
      </ModalPanel>
    </OyaModal>
  </div>
</template>
