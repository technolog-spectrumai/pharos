<script setup lang="ts">
// What the formula will look like, while it is being typed.
//
// The alternative is what this replaces: type LaTeX blind, insert it, look at
// the result, reopen the dialog to fix a brace. KaTeX renders in well under a
// frame for anything a slide or a paragraph would hold, so there is no reason
// to make that a round trip.
import { ref, watch } from "vue";

const props = defineProps<{ latex: string }>();

const html = ref("");
const failed = ref(false);

watch(
  () => props.latex,
  async (latex) => {
    const source = latex.trim();
    if (!source) {
      html.value = "";
      failed.value = false;
      return;
    }
    try {
      const katex = await import("katex");
      // throwOnError: false — a half-typed formula is the NORMAL state here,
      // and an exception on every keystroke would leave the box empty exactly
      // when the writer most needs to see how far they have got. KaTeX draws
      // what it can and marks the rest in red.
      html.value = katex.default.renderToString(source, { throwOnError: false });
      failed.value = false;
    } catch {
      html.value = "";
      failed.value = true;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="rounded-lg border border-dashed px-3 py-2 border-accent-2 dark:border-accent-1"
       data-testid="formula-preview">
    <p class="mb-1 text-[10px] font-semibold uppercase opacity-50">{{ $t("common.preview") }}</p>
    <!-- v-html with KaTeX's own output. Safe by construction: this is not user
         markup being echoed, it is KaTeX's rendering of a LaTeX string, and
         KaTeX escapes what it does not understand. -->
    <div v-if="html" class="overflow-x-auto text-center" v-html="html" />
    <p v-else-if="failed" class="text-xs text-warn-dark">{{ $t("common.previewFailed") }}</p>
    <p v-else class="text-xs opacity-40">{{ $t("common.previewEmpty") }}</p>
  </div>
</template>
