<script setup lang="ts">
// ACE over one buffer.
//
// The HOST owns the file; this owns the text. It emits every change rather than
// only on save, because the store's `dirty` is a comparison against what the
// server last confirmed — a component that only reported on save would make
// that comparison lie.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import ace, { modeForFilename, THEME_DARK, THEME_LIGHT } from "./aceSetup";
import { isDark, watchDark } from "petalite/theme";

const props = defineProps<{
  name: string;
  text: string;
  /** A truncated or generated file, or a read-only workspace. The editor is
   *  still shown — reading a failed run's log is the point — but not editable. */
  readonly?: boolean;
}>();

const emit = defineEmits<{ change: [string]; save: [] }>();

const host = ref<HTMLDivElement | null>(null);
let editor: ace.Ace.Editor | null = null;
let stopDark: (() => void) | null = null;
/** Set while the component is writing INTO ace, so the resulting change event
 *  is not echoed back out as a user edit — which would loop. */
let applying = false;

onMounted(() => {
  if (!host.value) return;
  editor = ace.edit(host.value, {
    value: props.text,
    mode: modeForFilename(props.name),
    theme: isDark() ? THEME_DARK : THEME_LIGHT,
    readOnly: Boolean(props.readonly),
    showPrintMargin: false,
    tabSize: 4,
    useSoftTabs: true,
    fontSize: 13,
  });
  editor.on("change", () => {
    if (applying || !editor) return;
    emit("change", editor.getValue());
  });
  // Ctrl-S is what people press. Without it the Save button is the only path
  // and the habit costs a lost edit the first time somebody trusts it.
  editor.commands.addCommand({
    name: "save",
    bindKey: { win: "Ctrl-S", mac: "Cmd-S" },
    exec: () => emit("save"),
  });
  stopDark = watchDark((dark) => editor?.setTheme(dark ? THEME_DARK : THEME_LIGHT));
});

// A DIFFERENT FILE, not a keystroke. Compared against the editor's own value so
// switching tabs replaces the buffer while typing never does.
watch(() => [props.name, props.text] as const, ([name, text]) => {
  if (!editor) return;
  editor.session.setMode(modeForFilename(name));
  if (editor.getValue() !== text) {
    applying = true;
    // `setValue(…, -1)` puts the cursor at the start rather than selecting
    // everything, which is what a fresh file should look like.
    editor.setValue(text, -1);
    applying = false;
  }
});

watch(() => props.readonly, (ro) => editor?.setReadOnly(Boolean(ro)));

onBeforeUnmount(() => {
  stopDark?.();
  editor?.destroy();
  editor = null;
});
</script>

<template>
  <div ref="host" class="h-full w-full" data-testid="code-editor"></div>
</template>
