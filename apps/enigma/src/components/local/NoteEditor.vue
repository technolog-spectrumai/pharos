<script setup lang="ts">
// ACE editor for one local text file. The buffer lives here; the parent owns the
// file (path, lock state, passphrase) and does the actual reading and writing, so
// this component never touches disk or crypto itself. It reports when the buffer
// diverges from the last saved text and exposes markSaved() for the parent to call
// after a write lands.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { OyaIconButton } from "rakotis";
import ace, { modeForFilename, THEME_DARK, THEME_LIGHT } from "./aceSetup";

const props = defineProps<{
  /** null while the note has never been saved (a new note awaiting Save As). */
  path: string | null;
  name: string;
  content: string;
  /** True if the file is stored encrypted on disk. */
  locked: boolean;
  darkMode?: boolean;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  save: [content: string];
  back: [];
  encrypt: [];
  "update:dirty": [boolean];
}>();

const host = ref<HTMLElement | null>(null);
let editor: ReturnType<typeof ace.edit> | null = null;
/** The text as of the last successful save; the dirty flag is measured against it. */
let savedContent = props.content;
const dirty = ref(false);

function setDirty(v: boolean) {
  if (dirty.value === v) return;
  dirty.value = v;
  emit("update:dirty", v);
}

/** Fall back to the document class when the parent doesn't pass darkMode. */
function isDark(): boolean {
  return props.darkMode ?? document.documentElement.classList.contains("dark");
}

/** Hand the current buffer to the parent, which owns writing it. */
function save() {
  if (props.busy) return;
  emit("save", editor?.getValue() ?? savedContent);
}

/** A never-saved note is always savable; an existing one only when changed. */
const canSave = () => !props.busy && (dirty.value || props.path === null);

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
    name: "saveNote",
    bindKey: { win: "Ctrl-S", mac: "Cmd-S" },
    exec: save,
  });
  editor.focus();
});

watch(
  () => props.darkMode,
  () => editor?.setTheme(isDark() ? THEME_DARK : THEME_LIGHT),
);

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
  /** Re-baseline the dirty flag after the parent saves this buffer. */
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
    <!-- Toolbar -->
    <div class="flex items-center gap-2 border-b border-current/10 px-3 py-2">
      <OyaIconButton size="sm" icon="arrow-left" :label="$t('local.back')" @click="emit('back')" />
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-1.5">
          <span class="truncate text-sm font-semibold">{{ name }}</span>
          <span v-if="dirty" class="shrink-0 opacity-60" :title="$t('local.unsavedTitle')">•</span>
        </p>
        <p class="truncate text-xs opacity-50">
          <font-awesome-icon :icon="locked ? 'lock' : 'file'" class="mr-1" />
          {{ locked ? $t('local.editorEncrypted') : $t('local.editorPlain') }}
        </p>
      </div>
      <OyaIconButton
        v-if="!locked"
        size="sm"
        icon="lock"
        :label="$t('local.encryptAction')"
        :disabled="busy"
        @click="emit('encrypt')"
      />
      <button
        class="shrink-0 rounded-lg bg-accent-light px-3 py-1.5 text-xs font-bold text-primary-bg-light transition hover:opacity-90 dark:bg-accent-dark dark:text-primary-bg-dark"
        :class="{ 'pointer-events-none opacity-50': !canSave() }"
        @click="save"
      >
        <font-awesome-icon :icon="busy ? 'spinner' : 'floppy-disk'" :spin="busy" />
        {{ $t('local.save') }}
      </button>
    </div>

    <p v-if="error" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
      {{ error }}
    </p>

    <!-- ACE mounts here and sizes itself to this box. -->
    <div ref="host" class="min-h-0 w-full flex-1" />
  </div>
</template>
