<script setup lang="ts">
// Memo's presentation editor, under zinnia's editor contract (./types.ts).
//
// The shape follows the format: a deck is slides, a slide is a LAYOUT and an
// ordered list of typed blocks in its boxes. Nothing here resizes or positions
// anything — you pick a layout, you get its boxes, you put a block in one. That
// is the trade memo makes on purpose, and copying it is what keeps a deck
// editable on both surfaces.
//
// Editing a block edits its payload as text: this is a first pass that owns the
// STRUCTURE (slides, order, layouts, block types, slots) faithfully. Rich-text
// editing inside a text block is the next step, and the format does not change
// when it arrives.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import OyaButton from "rakotis/components/primitives/OyaButton.vue";
import OyaIconButton from "rakotis/components/primitives/OyaIconButton.vue";
import OyaModal from "rakotis/components/primitives/OyaModal.vue";
import ModalPanel from "../components/ModalPanel.vue";
import SelectMenu from "../components/SelectMenu.vue";
import FormulaPreview from "../components/FormulaPreview.vue";
import OyaTextField from "rakotis/components/primitives/OyaTextField.vue";
import SlideBlock from "./SlideBlock.vue";
import DeckPlayer from "./DeckPlayer.vue";
import RichPayloadEditor from "./RichPayloadEditor.vue";
import {
  BLOCK_TYPES, FONTS, LAYOUTS, PresentationParseError, THEMES,
  columnsOf, dumps, loads, newBlock, newPresentation, newSlide,
  slotsFor, type Block, type Presentation, type Slide,
} from "../formats/presentation";

const props = defineProps<{
  path: string | null;
  name: string;
  content: string;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  save: [content: string];
  "update:dirty": [boolean];
  "open-as-text": [];
}>();

const { t } = useI18n({ useScope: "global" });

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ── the deck ────────────────────────────────────────────────────────────────
// shallowRef, not ref, and the reason is load-bearing: `mutate` clones the deck
// with structuredClone, which THROWS on a Vue reactive proxy ("could not be
// cloned"). With a deep ref that throw happens inside the click handler, so
// every edit silently does nothing. A shallowRef holds the plain object, and
// replacing it wholesale — which mutate does anyway — is what re-renders.
const deck = shallowRef<Presentation>(newPresentation());
const parseError = ref("");
const current = ref(0);

let savedContent = props.content;
const dirty = ref(false);

function setDirty(v: boolean) {
  if (dirty.value === v) return;
  dirty.value = v;
  emit("update:dirty", v);
}

function currentText(): string {
  return dumps(deck.value);
}

/** Baseline against what we WOULD write — the same rule the other editors use:
 *  re-serialising normalises the file, so comparing against the bytes we read
 *  marks every opened deck unsaved. */
function baseline() {
  savedContent = currentText();
  setDirty(false);
}

/** Every mutation goes through here. One path means the dirty flag cannot be
 *  forgotten by the next command somebody adds. */
function mutate(fn: (d: Presentation) => void) {
  const next = structuredClone(deck.value) as Presentation;
  fn(next);
  deck.value = next;
  setDirty(currentText() !== savedContent);
}

function open(text: string) {
  parseError.value = "";
  try {
    deck.value = text.trim() ? loads(text) : newPresentation();
  } catch (err) {
    parseError.value = err instanceof PresentationParseError ? err.message : String(err);
    return;
  }
  current.value = 0;
  baseline();
}

const slide = computed<Slide | undefined>(() => deck.value.slides[current.value]);
const columns = computed(() => (slide.value ? columnsOf(slide.value) : []));

// ── slides ──────────────────────────────────────────────────────────────────
function addSlide() {
  mutate((d) => {
    d.slides.splice(current.value + 1, 0, newSlide({
      blocks: [newBlock({ type: "text", payload: "<p></p>" })],
    }));
  });
  current.value += 1;
}

function deleteSlide() {
  if (deck.value.slides.length <= 1) return; // a deck is never empty
  mutate((d) => { d.slides.splice(current.value, 1); });
  current.value = Math.max(0, current.value - 1);
}

function moveSlide(delta: number) {
  const to = current.value + delta;
  if (to < 0 || to >= deck.value.slides.length) return;
  mutate((d) => {
    const [s] = d.slides.splice(current.value, 1);
    d.slides.splice(to, 0, s);
  });
  current.value = to;
}

function setSlideTitle(title: string) {
  mutate((d) => { d.slides[current.value].title = title; });
}

function setLayout(layout: string) {
  // Blocks keep their own slot even when this layout has no such box — see
  // resolveSlot. Switching away and back must not shuffle the deck.
  mutate((d) => { d.slides[current.value].layout = layout; });
}

// ── blocks ──────────────────────────────────────────────────────────────────
function addBlock(type: string, slot: string) {
  mutate((d) => {
    d.slides[current.value].blocks.push(newBlock({
      type, slot,
      payload: type === "text" ? "<p></p>" : "",
      items: type === "list" ? [""] : [],
    }));
  });
}

/** Bring an image or a drawing in from the filesystem.
 *
 *  These payloads are a FILE's contents, so typing them was never the right
 *  interaction: an image block wanted a pasted data URI and an svg block a
 *  pasted document. The deck is a single self-contained .xml, so the file is
 *  embedded rather than referenced — a path would break the moment the deck
 *  was moved or sent to someone. */
const importing = ref(false);
const importError = ref("");
const importInput = ref<HTMLInputElement | null>(null);

async function importPayload() {
  const type = editing.value?.type;
  if (!type || !IMPORTED_TYPES.has(type)) return;
  importError.value = "";

  if (!isTauri) {
    importInput.value?.click(); // browser build has no dialog
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: type === "svg"
      ? [{ name: "SVG", extensions: ["svg"] }]
      : [{ name: t("deck.blockTypes.image"), extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
  });
  if (typeof picked !== "string") return;

  importing.value = true;
  try {
    const { readFile, readTextFile } = await import("@tauri-apps/plugin-fs");
    if (type === "svg") {
      draftPayload.value = await readTextFile(picked);
    } else {
      const bytes = await readFile(picked);
      draftPayload.value = `<img src="${toDataUri(picked, bytes)}" alt="" />`;
    }
  } catch (err) {
    importError.value = (err as Error)?.message ?? String(err);
  } finally {
    importing.value = false;
  }
}

/** Browser build: the same job through a hidden <input type="file">. */
async function onImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  importError.value = "";
  try {
    if (editing.value?.type === "svg") {
      draftPayload.value = await file.text();
    } else {
      draftPayload.value = `<img src="${await fileToDataUri(file)}" alt="" />`;
    }
  } catch (err) {
    importError.value = (err as Error)?.message ?? String(err);
  } finally {
    importing.value = false;
    (event.target as HTMLInputElement).value = "";
  }
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsDataURL(file);
  });
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp",
};

function toDataUri(path: string, bytes: Uint8Array): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  // Chunked: btoa(String.fromCharCode(...bytes)) blows the argument limit on
  // anything but a tiny image.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function deleteBlock(id: string) {
  mutate((d) => {
    const s = d.slides[current.value];
    s.blocks = s.blocks.filter((b) => b.id !== id);
  });
}

function moveBlock(id: string, delta: number) {
  mutate((d) => {
    const blocks = d.slides[current.value].blocks;
    const i = blocks.findIndex((b) => b.id === id);
    const to = i + delta;
    if (i === -1 || to < 0 || to >= blocks.length) return;
    const [b] = blocks.splice(i, 1);
    blocks.splice(to, 0, b);
  });
}

function setBlockSlot(id: string, slot: string) {
  mutate((d) => {
    const b = d.slides[current.value].blocks.find((x) => x.id === id);
    if (b) b.slot = slot;
  });
}

// ── the block being edited ──────────────────────────────────────────────────
/** Payloads that ARE html fragments — these get TipTap. code keeps its
 *  characters verbatim, image/svg hold markup-as-data, formula holds LaTeX:
 *  all of those must stay raw. */
/** A block type's icon. Icons rather than "+ heading" chips, for the same
 *  reason the writer's toolbar went icon-only: nine words wrap onto two lines
 *  inside a column and turn a slot into a wall of text. The name arrives on
 *  hover instead, through the same .oya-tip bubble the rest of the app uses. */
const BLOCK_ICONS: Record<string, string> = {
  heading: "heading",
  text: "align-left",
  list: "list-ul",
  image: "image",
  svg: "pencil",
  code: "code",
  quote: "quote-left",
  formula: "square-root-variable",
  html: "file-code",
};

/** Types whose payload is a FILE, not something you type. */
const IMPORTED_TYPES = new Set(["image", "svg"]);

const RICH_TYPES = new Set(["text", "quote", "html"]);
const INLINE_TYPES = new Set(["heading"]);

const editing = ref<Block | null>(null);
const draftPayload = ref("");
const draftItems = ref<string[]>([]);

function editBlock(block: Block) {
  editing.value = block;
  draftPayload.value = block.payload;
  draftItems.value = [...block.items];
}

async function commitBlock() {
  const target = editing.value;
  if (!target) return;
  let render = "";
  if (target.type === "formula" && draftPayload.value.trim()) {
    try {
      // Cached at save time because WeasyPrint runs no JavaScript — without it
      // an exported deck loses every formula.
      const katex = await import("katex");
      render = katex.default.renderToString(draftPayload.value.trim(), { throwOnError: false });
    } catch {
      render = ""; // the renderer falls back to showing the source
    }
  }
  mutate((d) => {
    const b = d.slides[current.value].blocks.find((x) => x.id === target.id);
    if (!b) return;
    if (b.type === "list") b.items = draftItems.value.filter((i) => i !== "");
    else { b.payload = draftPayload.value; b.render = render; }
  });
  editing.value = null;
}

// ── presenting ──────────────────────────────────────────────────────────────
const playing = ref(false);

function play() {
  if (!deck.value.slides.length) return;
  playing.value = true;
}

// ── deck settings ───────────────────────────────────────────────────────────
const setupOpen = ref(false);

function setDeck<K extends keyof Presentation>(key: K, value: Presentation[K]) {
  mutate((d) => { (d[key] as Presentation[K]) = value; });
}

// ── keyboard ────────────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!props.busy) emit("save", currentText());
  } else if (e.key === "PageDown" && current.value < deck.value.slides.length - 1) {
    current.value += 1;
  } else if (e.key === "PageUp" && current.value > 0) {
    current.value -= 1;
  }
}

onMounted(() => {
  open(props.content);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

// Save As renames the file; the buffer is unchanged, so do NOT re-open it.
watch(() => props.path, () => undefined);

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

    <div v-if="parseError" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <font-awesome-icon icon="triangle-exclamation" class="text-3xl text-warn-dark" />
      <p class="text-sm font-semibold">{{ t("deck.notADeck") }}</p>
      <p class="max-w-md text-sm opacity-70" data-testid="deck-parse-error">{{ parseError }}</p>
      <OyaButton variant="secondary" @click="emit('open-as-text')">
        {{ t("file.openAsText") }}
      </OyaButton>
    </div>

    <template v-else>
      <!-- Deck toolbar -->
      <div class="flex flex-wrap items-center gap-1 border-b border-current/10 px-3 py-1.5">
        <OyaIconButton size="sm" icon="file-circle-plus" :label="t('deck.addSlide')" class="oya-tip" :data-tip="t('deck.addSlide')"
                       data-testid="add-slide" @click="addSlide" />
        <OyaIconButton size="sm" icon="trash" :label="t('deck.deleteSlide')" class="oya-tip" :data-tip="t('deck.deleteSlide')"
                       :disabled="deck.slides.length <= 1" @click="deleteSlide" />
        <OyaIconButton size="sm" icon="arrow-left" :label="t('deck.moveBack')" class="oya-tip" :data-tip="t('deck.moveBack')" @click="moveSlide(-1)" />
        <OyaIconButton size="sm" icon="arrow-right" :label="t('deck.moveForward')" class="oya-tip" :data-tip="t('deck.moveForward')" @click="moveSlide(1)" />
        <span class="mx-1 h-4 w-px bg-current/20" />

        <label class="text-xs opacity-70">{{ t("deck.layout") }}</label>
        <!-- Not a native <select>: WebKitGTK draws the open list as a GTK popup
             that ignores CSS, so it stayed dark on a dark desktop whatever the
             app's theme was. SelectMenu is ours in both states. -->
        <SelectMenu data-testid="layout-select" :label="t('deck.layout')"
                    :model-value="slide?.layout ?? ''" :options="LAYOUTS"
                    @update:model-value="setLayout($event)" />

        <OyaIconButton size="sm" icon="play" :label="t('deck.play')" class="oya-tip"
                       :data-tip="t('deck.play')" data-testid="deck-play" @click="play" />

        <span class="flex-1" />
        <span class="text-xs opacity-60" data-testid="slide-counter">
          {{ current + 1 }} / {{ deck.slides.length }}
        </span>
        <OyaIconButton size="sm" icon="gear" :label="t('deck.settings')" class="oya-tip" :data-tip="t('deck.settings')"
                       data-testid="deck-setup" @click="setupOpen = true" />
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- Filmstrip -->
        <div class="w-40 shrink-0 overflow-y-auto border-r border-current/10 p-2">
          <button v-for="(s, i) in deck.slides" :key="s.id" type="button"
                  class="mb-2 w-full rounded border p-2 text-left text-xs transition"
                  :class="i === current
                    ? 'border-accent-2 bg-bubble-bg-light dark:border-accent-1 dark:bg-bubble-bg-dark'
                    : 'border-transparent opacity-60 hover:opacity-100'"
                  :data-testid="`filmstrip-${i}`" @click="current = i">
            <span class="opacity-50">{{ i + 1 }}.</span>
            {{ s.title || t("deck.untitledSlide") }}
          </button>
        </div>

        <!-- The slide -->
        <div class="min-h-0 flex-1 overflow-y-auto p-6">
          <div v-if="slide" class="mx-auto max-w-4xl">
            <OyaTextField :model-value="slide.title" :placeholder="t('deck.slideTitle')"
                          data-testid="slide-title"
                          @update:model-value="setSlideTitle($event)" />

            <div class="mt-4 grid gap-4"
                 :style="{ gridTemplateColumns: `repeat(${slotsFor(slide.layout).length}, minmax(0, 1fr))` }">
              <div v-for="[slot, blocks] in columns" :key="slot"
                   class="min-h-[8rem] rounded border border-dashed border-current/20 p-3"
                   :data-slot="slot">
                <p v-if="slot" class="mb-2 text-[10px] uppercase tracking-wide opacity-40">{{ slot }}</p>

                <div v-for="block in blocks" :key="block.id"
                     class="group relative mb-2 rounded border border-current/10 p-2"
                     :data-testid="`block-${block.id}`">
                  <div class="mb-1 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <span class="flex-1 font-mono text-[10px] opacity-50">{{ block.type }}</span>
                    <OyaIconButton size="sm" icon="pencil" :label="t('deck.editBlock')" class="oya-tip" :data-tip="t('deck.editBlock')"
                                   :data-testid="`edit-${block.id}`" @click="editBlock(block)" />
                    <OyaIconButton size="sm" icon="arrow-up" :label="t('deck.moveUp')" class="oya-tip" :data-tip="t('deck.moveUp')"
                                   @click="moveBlock(block.id, -1)" />
                    <OyaIconButton size="sm" icon="arrow-down" :label="t('deck.moveDown')" class="oya-tip" :data-tip="t('deck.moveDown')"
                                   @click="moveBlock(block.id, 1)" />
                    <SelectMenu v-if="slotsFor(slide.layout).length > 1"
                                :label="t('deck.slot')"
                                :model-value="block.slot" :options="slotsFor(slide.layout)"
                                @update:model-value="setBlockSlot(block.id, $event)" />
                    <OyaIconButton size="sm" icon="trash" :label="t('deck.deleteBlock')" class="oya-tip" :data-tip="t('deck.deleteBlock')"
                                   @click="deleteBlock(block.id)" />
                  </div>
                  <SlideBlock :block="block" trust-html />
                </div>

                <div class="flex flex-wrap gap-1">
                  <button v-for="type in BLOCK_TYPES" :key="type" type="button"
                          class="oya-tip inline-flex h-7 w-7 items-center justify-center rounded border
                                 text-xs opacity-50 transition hover:opacity-100 border-accent-2 dark:border-accent-1"
                          :data-tip="t(`deck.blockTypes.${type}`)"
                          :title="t(`deck.blockTypes.${type}`)"
                          :aria-label="t(`deck.blockTypes.${type}`)"
                          :data-testid="`add-${type}-${slot || 'main'}`"
                          @click="addBlock(type, slot)">
                    <font-awesome-icon :icon="BLOCK_ICONS[type]" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <DeckPlayer v-if="playing" :deck="deck" :start-at="current" @close="playing = false" />

    <!-- Block editor -->
    <OyaModal :open="editing !== null" @close="editing = null">
      <ModalPanel wide :title="editing?.type">
        <template v-if="editing?.type === 'list'">
          <div v-for="(_, i) in draftItems" :key="i" class="flex gap-1">
            <OyaTextField v-model="draftItems[i]" />
            <OyaIconButton size="sm" icon="trash" label="—" @click="draftItems.splice(i, 1)" />
          </div>
          <OyaButton variant="secondary" @click="draftItems.push('')">+ {{ t("deck.item") }}</OyaButton>
        </template>

        <RichPayloadEditor v-else-if="RICH_TYPES.has(editing?.type ?? '')"
                           v-model="draftPayload" data-testid="block-rich" />
        <RichPayloadEditor v-else-if="INLINE_TYPES.has(editing?.type ?? '')"
                           v-model="draftPayload" inline data-testid="block-rich" />
        <template v-else-if="IMPORTED_TYPES.has(editing?.type ?? '')">
          <button type="button" data-testid="block-import"
                  class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition
                         border-accent-2 hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
                  :disabled="importing" @click="importPayload()">
            <font-awesome-icon :icon="importing ? 'spinner' : 'folder-open'" :spin="importing" />
            {{ t("deck.importFile") }}
          </button>
          <p v-if="importError" class="text-xs text-warn-dark" data-testid="block-import-error">
            {{ importError }}
          </p>
          <!-- Still editable: an imported payload is ordinary markup, and a
               deck that could only ever import would refuse a hand-written
               <img> that already worked. -->
          <textarea v-model="draftPayload" rows="6" data-testid="block-payload"
                    class="w-full rounded border bg-transparent p-2 font-mono text-xs border-accent-2 dark:border-accent-1" />
          <input ref="importInput" type="file" class="hidden"
                 :accept="editing?.type === 'svg' ? '.svg' : 'image/*'" @change="onImportFile" />
        </template>
        <template v-else-if="editing?.type === 'formula'">
          <textarea v-model="draftPayload" rows="4" data-testid="block-payload"
                    class="w-full rounded border bg-transparent p-2 font-mono text-xs border-accent-2 dark:border-accent-1" />
          <FormulaPreview :latex="draftPayload" />
        </template>
        <textarea v-else v-model="draftPayload" rows="8" data-testid="block-payload"
                  class="w-full rounded border bg-transparent p-2 font-mono text-xs border-accent-2 dark:border-accent-1" />

        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="editing = null">{{ t("common.cancel") }}</OyaButton>
          <OyaButton data-testid="block-commit" @click="commitBlock">{{ t("common.save") }}</OyaButton>
        </div>
      </ModalPanel>
    </OyaModal>

    <!-- Deck settings -->
    <OyaModal :open="setupOpen" @close="setupOpen = false">
      <ModalPanel :title="t('deck.settings')">

        <label class="block text-xs opacity-70">{{ t("deck.title") }}</label>
        <OyaTextField :model-value="deck.title" data-testid="deck-title"
                      @update:model-value="setDeck('title', $event)" />

        <label class="block text-xs opacity-70">{{ t("deck.theme") }}</label>
        <div class="flex gap-1">
          <button v-for="th in THEMES" :key="th" type="button"
                  class="rounded border px-2 py-1 text-xs transition border-accent-2 dark:border-accent-1"
                  :class="deck.theme === th ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                  @click="setDeck('theme', th)">{{ th }}</button>
        </div>

        <label class="block text-xs opacity-70">{{ t("deck.font") }}</label>
        <div class="flex flex-wrap gap-1">
          <button v-for="f in FONTS" :key="f" type="button"
                  class="rounded border px-2 py-1 text-xs transition border-accent-2 dark:border-accent-1"
                  :class="deck.font === f ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                  @click="setDeck('font', f)">{{ f }}</button>
        </div>

        <div class="flex justify-end">
          <OyaButton @click="setupOpen = false">{{ t("common.close") }}</OyaButton>
        </div>
      </ModalPanel>
    </OyaModal>
  </div>
</template>
