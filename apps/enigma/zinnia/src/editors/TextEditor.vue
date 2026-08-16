<script setup lang="ts">
// ACE editor for one text file — enigma's NoteEditor under zinnia's editor
// contract (../editors/types.ts): the host owns the file, this owns the buffer,
// and the vault half (locked/encrypt) is gone. The header moved to the host's
// file bar with everything else file-shaped.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import ace, { modeForFilename, THEME_DARK, THEME_LIGHT } from "./aceSetup";

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
}>();

const host = ref<HTMLElement | null>(null);
let editor: ReturnType<typeof ace.edit> | null = null;
/** The text as of the last successful save; the dirty flag measures against it. */
let savedContent = props.content;
const dirty = ref(false);

function setDirty(v: boolean) {
  if (dirty.value === v) return;
  dirty.value = v;
  emit("update:dirty", v);
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function save() {
  if (props.busy) return;
  emit("save", editor?.getValue() ?? savedContent);
}

onMounted(() => {
  if (!host.value) return;
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
  editor.session.on("change", () => setDirty(editor!.getValue() !== savedContent));
  editor.commands.addCommand({
    name: "saveFile",
    bindKey: { win: "Ctrl-S", mac: "Cmd-S" },
    exec: save,
  });
  editor.focus();
});

// Save As can rename the file, and the highlighting should follow it.
watch(
  () => props.name,
  (name) => editor?.session.setMode(modeForFilename(name)),
);

onBeforeUnmount(() => {
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
    <p v-if="error" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
      {{ error }}
    </p>
    <!-- ACE mounts here and sizes itself to this box. -->
    <div ref="host" class="min-h-0 w-full flex-1" data-testid="ace-host" />
  </div>
</template>
