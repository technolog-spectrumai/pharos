<script setup lang="ts">
// A small TipTap for one block payload — the deck editor's rich fields.
//
// The deck's text/quote/heading/html payloads are HTML fragments the server
// sanitises per type (memo's sanitize_rich / sanitize_inline), so editing them
// as raw markup in a textarea was both hostile to non-technical users and easy
// to break. This gives them the writer's editing feel at block scale.
//
// Deliberately tiny: marks and lists only. Structure (which blocks exist,
// where they sit) belongs to the deck editor around it — a payload editor that
// could nest its own headings and tables would be a second document model.
import { onBeforeUnmount, watch } from "vue";
import { Editor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";

const props = defineProps<{
  modelValue: string;
  /** Inline-only fields (heading) drop the list buttons. */
  inline?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [string] }>();

const editor = new Editor({
  content: props.modelValue || "<p></p>",
  extensions: [
    StarterKit.configure({
      heading: false,     // a heading INSIDE a heading block is not a thing
      codeBlock: false,   // code has its own block type with its own escaping
      horizontalRule: false,
      blockquote: false,  // likewise quote
    }),
    Underline,
  ],
  onUpdate: () => emit("update:modelValue", editor.getHTML()),
});

// The modal reuses one instance across blocks; follow the prop when the caller
// swaps payloads (guarded so our own emits do not loop back into setContent).
watch(() => props.modelValue, (next) => {
  if (next !== editor.getHTML()) editor.commands.setContent(next || "<p></p>");
});

onBeforeUnmount(() => editor.destroy());

const isActive = (name: string) => editor.isActive(name);
</script>

<template>
  <div class="rounded border border-accent-2 dark:border-accent-1">
    <div class="flex items-center gap-1 border-b border-current/10 px-1.5 py-1">
      <button v-for="[name, icon, run] in ([
                ['bold', 'bold', () => editor.chain().focus().toggleBold().run()],
                ['italic', 'italic', () => editor.chain().focus().toggleItalic().run()],
                ['underline', 'underline', () => editor.chain().focus().toggleUnderline().run()],
              ] as const)"
              :key="name" type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded transition hover:opacity-80"
              :class="isActive(name) ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
              :data-testid="`rich-${name}`" @click="run()">
        <font-awesome-icon :icon="icon" />
      </button>
      <template v-if="!inline">
        <span class="mx-0.5 h-4 w-px bg-current/20" />
        <button type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded transition hover:opacity-80"
                :class="isActive('bulletList') ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                data-testid="rich-ul" @click="editor.chain().focus().toggleBulletList().run()">
          <font-awesome-icon icon="list-ul" />
        </button>
        <button type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded transition hover:opacity-80"
                :class="isActive('orderedList') ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark' : 'opacity-60'"
                data-testid="rich-ol" @click="editor.chain().focus().toggleOrderedList().run()">
          <font-awesome-icon icon="list-ol" />
        </button>
      </template>
    </div>
    <EditorContent :editor="editor" class="rich-payload max-h-64 overflow-y-auto p-2 text-sm" />
  </div>
</template>
