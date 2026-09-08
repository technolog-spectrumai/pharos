<script setup lang="ts">
// ACE editor for one text file — enigma's NoteEditor under zinnia's editor
// contract (../editors/types.ts): the host owns the file, this owns the buffer,
// and the vault half (locked/encrypt) is gone. The header moved to the host's
// file bar with everything else file-shaped.
//
// It serves TWO tabs, told apart by one prop:
//
//   withPicker  — the Code tab. A language dropdown above the buffer.
//   (default)   — the refusal fallback. A file whose own editor turned it away
//                 (see EditorHost.openAsText) opens here as plain text, and
//                 stays deliberately bare: nothing was chosen about it, so
//                 there is nothing to offer.
//
// One component rather than two because the ~60 lines below — the mount
// options, the dirty baseline, Ctrl-S, the teardown, the exposed handle — are
// the same editor either way, and a second copy is a second thing to fix. The
// prop comes from the HOST, like `kind`: the tab decides, never the file.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import SelectMenu from "petalite/SelectMenu.vue";
import ace, {
  languageForFilename, LANGUAGES, modeForFilename, THEME_DARK, THEME_LIGHT,
  type CodeLanguage,
} from "./aceSetup";
import { isDark, watchDark } from "petalite/theme";
import { isImageName } from "petalite/files";

const props = defineProps<{
  path: string | null;
  name: string;
  content: string;
  busy?: boolean;
  error?: string;
  /** The Code tab sets this; the fallback leaves it off. */
  withPicker?: boolean;
}>();

const { t } = useI18n({ useScope: "global" });

const emit = defineEmits<{
  save: [content: string];
  "update:dirty": [boolean];
}>();

/** A picture is SHOWN, not read. The buffer is replaced by the image for as
 *  long as this file is open; nothing about the file changes, and the host
 *  refuses to save it — see `readOnly` there, which asks the same question of
 *  the same function so the two cannot disagree. */
const isImage = computed(() => isImageName(props.name));

const host = ref<HTMLElement | null>(null);
let editor: ReturnType<typeof ace.edit> | null = null;
let stopDark: (() => void) | null = null;

// ── the language ────────────────────────────────────────────────────────────
// `null` means "nobody has said", so the file name decides. Once it holds a
// language the user chose it, and nothing infers over the top of that.
//
// It resets by REMOUNTING, not by being cleared: the host keys this component
// on `generation` and bumps it on every open, so a new file arrives with a
// fresh instance and a fresh null. Save As does not bump it, which is exactly
// why the rename watch below has to check.
const picked = ref<CodeLanguage | null>(null);

const languageLabels = LANGUAGES.map((l) => l.label);
const currentLabel = computed(
  () => (picked.value ?? languageForFilename(props.name)).label,
);

// ── the undo stack ──────────────────────────────────────────────────────────
// ACE keeps it and binds Ctrl+Z / Ctrl+Shift+Z itself; what was missing is a
// way to SEE it. Both refs are recomputed on every document change, which is
// the one event that can move either end of the stack — typing clears the redo
// side, an undo fills it, and both fire `change`.
const canUndo = ref(false);
const canRedo = ref(false);

function syncHistory() {
  const undoManager = editor?.session.getUndoManager?.();
  canUndo.value = undoManager?.hasUndo?.() ?? false;
  canRedo.value = undoManager?.hasRedo?.() ?? false;
}

function undo() {
  editor?.undo();
  syncHistory();
  editor?.focus();
}

function redo() {
  editor?.redo();
  syncHistory();
  editor?.focus();
}

function pickLanguage(label: string) {
  const language = LANGUAGES.find((l) => l.label === label);
  if (!language) return;
  picked.value = language;
  editor?.session.setMode(`ace/mode/${language.mode}`);
}
/** The text as of the last successful save; the dirty flag measures against it. */
let savedContent = props.content;
const dirty = ref(false);

function setDirty(v: boolean) {
  if (dirty.value === v) return;
  dirty.value = v;
  emit("update:dirty", v);
}

function save() {
  if (props.busy) return;
  emit("save", editor?.getValue() ?? savedContent);
}

onMounted(() => {
  // No ACE at all for a picture: mounting an editor over a data: URI would
  // build an undo stack for a buffer nobody can edit.
  if (isImage.value || !host.value) return;
  editor = ace.edit(host.value, {
    mode: modeForFilename(props.name),
    theme: isDark() ? THEME_DARK : THEME_LIGHT,
    fontSize: 13,
    showPrintMargin: false,
    wrap: true,
    useSoftTabs: true,
    tabSize: 2,
  });
  editor.session.setValue(props.content);
  savedContent = props.content;
  editor.session.on("change", () => {
    setDirty(editor!.getValue() !== savedContent);
    syncHistory();
  });
  editor.commands.addCommand({
    name: "saveFile",
    bindKey: { win: "Ctrl-S", mac: "Cmd-S" },
    exec: save,
  });
  editor.focus();
  // Sampled once was the bug: every tab stays mounted across a theme toggle, so
  // an editor that only read the class at mount kept the old theme forever.
  stopDark = watchDark((on) => editor?.setTheme(on ? THEME_DARK : THEME_LIGHT));
  // `session.setValue` resets the manager, so a freshly opened file starts with
  // nothing to undo — asserted rather than assumed, because a stack that began
  // life one step deep would offer to undo the act of opening the file.
  syncHistory();
});

// Save As can rename the file, and the highlighting should follow it — unless
// the user has said what this is. A pick is an instruction; a rename is a guess,
// and a guess must not overrule an instruction.
watch(
  () => props.name,
  (name) => {
    if (picked.value) return;
    editor?.session.setMode(modeForFilename(name));
  },
);

onBeforeUnmount(() => {
  stopDark?.();
  stopDark = null;
  editor?.destroy();
  editor = null;
});

defineExpose({
  markSaved() {
    savedContent = editor?.getValue() ?? savedContent;
    setDirty(false);
  },
  getContent(): string {
    return editor?.getValue() ?? savedContent;
  },
  isDirty(): boolean {
    return dirty.value;
  },
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="withPicker"
         class="flex flex-wrap items-center gap-2 border-b border-current/10 px-3 py-1.5">
      <template v-if="!isImage">
      <button type="button" data-testid="editor-undo"
              class="rounded border border-accent-2 px-2 py-1 text-xs transition hover:opacity-80 disabled:opacity-30 dark:border-accent-1"
              :title="t('code.undo')" :aria-label="t('code.undo')"
              :disabled="!canUndo" @click="undo">
        <font-awesome-icon icon="rotate-left" />
      </button>
      <button type="button" data-testid="editor-redo"
              class="rounded border border-accent-2 px-2 py-1 text-xs transition hover:opacity-80 disabled:opacity-30 dark:border-accent-1"
              :title="t('code.redo')" :aria-label="t('code.redo')"
              :disabled="!canRedo" @click="redo">
        <font-awesome-icon icon="rotate-right" />
      </button>

      <span class="mx-1 h-4 w-px bg-current opacity-20" />

      </template>
      <label v-if="!isImage" class="text-xs opacity-70">{{ t("code.language") }}</label>
      <SelectMenu v-if="!isImage" data-testid="language-select" :label="t('code.language')"
                  :model-value="currentLabel" :options="languageLabels"
                  :empty-label="t('code.plainText')"
                  @update:model-value="pickLanguage($event)" />
    </div>

    <p v-if="error" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
      {{ error }}
    </p>
    <!-- A picture takes the buffer's place while it is open. -->
    <div v-if="isImage" class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
         data-testid="image-view">
      <img :src="content" :alt="name" data-testid="image-preview"
           class="max-h-full max-w-full object-contain" />
    </div>

    <!-- ACE mounts here and sizes itself to this box. -->
    <div v-else ref="host" class="min-h-0 w-full flex-1" data-testid="ace-host" />
  </div>
</template>
