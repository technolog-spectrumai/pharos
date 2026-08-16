<script setup lang="ts">
// One block, rendered the way memo's `_slide.html` renders it — the same
// markup, the same class names, the same per-type decisions:
//
//   * `code` is ESCAPED, never raw: a code block is plain text by definition,
//     and showing the markup is the entire point of it. Vue's text
//     interpolation gives us that for free.
//   * `formula` shows the cached KaTeX if there is any, otherwise the LaTeX
//     source. Never a blank — a formula you can read as source beats an empty
//     space where one used to be.
//   * `html` is v1's escape hatch and is the only type memo does not sanitise.
//     `trustHtml` decides whether it renders live, exactly as memo's gallery
//     does: legitimate when you opened one deck, not when listing other
//     people's.
//   * An unknown type renders as a placeholder rather than a guess — it
//     round-trips through the file untouched either way.
import { computed } from "vue";
import type { Block } from "../formats/presentation";

const props = defineProps<{
  block: Block;
  /** Render a legacy `html` block live. False shows an inert placeholder. */
  trustHtml?: boolean;
}>();

/** The resolved auto-fit multiplier, or "" at full size. Templates cannot parse
 *  `auto:0.80`, so the parsing lives in one place — memo puts it on the Block. */
const scaleCss = computed(() => {
  const raw = (props.block.attrs?.scale || "auto").trim();
  const number = raw.startsWith("auto:") ? raw.slice(5) : raw.startsWith("auto") ? "" : raw;
  if (!number) return "";
  const value = Number(number);
  if (!Number.isFinite(value)) return "";
  // Only an exact 1.0 is a no-op: a manually enlarged block must keep its size.
  return Math.abs(value - 1) < 0.005 ? "" : value.toFixed(2);
});

const style = computed(() =>
  scaleCss.value ? { "--memo-block-scale": scaleCss.value } : undefined);

const headingTag = computed(() => {
  const level = props.block.attrs?.level;
  return level === "1" ? "h1" : level === "3" ? "h3" : level === "4" ? "h4" : "h2";
});
</script>

<template>
  <component :is="headingTag" v-if="block.type === 'heading'"
             class="memo-block" data-type="heading" :data-block-id="block.id" :style="style"
             v-html="block.payload" />

  <div v-else-if="block.type === 'text'" class="memo-block" data-type="text"
       :data-block-id="block.id" :style="style" v-html="block.payload" />

  <div v-else-if="block.type === 'list'" class="memo-block" data-type="list"
       :data-block-id="block.id" :style="style">
    <ol v-if="block.attrs?.ordered === 'true'">
      <li v-for="(item, i) in block.items" :key="i" v-html="item" />
    </ol>
    <ul v-else>
      <li v-for="(item, i) in block.items" :key="i" v-html="item" />
    </ul>
  </div>

  <div v-else-if="block.type === 'image'" class="memo-block" data-type="image"
       :data-block-id="block.id" :data-fit="block.attrs?.fit || 'contain'">
    <img v-if="block.payload" :src="block.payload" :alt="block.attrs?.alt || ''" />
  </div>

  <div v-else-if="block.type === 'svg'" class="memo-block" data-type="svg"
       :data-block-id="block.id" role="img" :aria-label="block.attrs?.alt || ''"
       v-html="block.payload" />

  <!-- Escaped, not raw: showing the markup is the point of a code block. -->
  <pre v-else-if="block.type === 'code'" class="memo-block" data-type="code"
       :data-block-id="block.id" :data-language="block.attrs?.language || ''"
       :style="style">{{ block.payload }}</pre>

  <div v-else-if="block.type === 'formula'" class="memo-block" data-type="formula"
       :data-block-id="block.id" :style="style">
    <span v-if="block.render" v-html="block.render" />
    <code v-else class="memo-formula-source">{{ block.payload }}</code>
  </div>

  <blockquote v-else-if="block.type === 'quote'" class="memo-block" data-type="quote"
              :data-block-id="block.id" :style="style">
    <span v-html="block.payload" />
    <cite v-if="block.attrs?.cite" class="memo-cite">{{ block.attrs.cite }}</cite>
  </blockquote>

  <div v-else-if="block.type === 'html'" class="memo-block" data-type="html"
       :data-block-id="block.id">
    <span v-if="trustHtml" v-html="block.payload" />
    <span v-else class="memo-legacy">Legacy HTML slide</span>
  </div>

  <!-- A block from a newer build. It round-trips untouched; rendering a guess
       at it would be worse than nothing. -->
  <div v-else class="memo-block" data-type="unknown" :data-block-id="block.id">
    <span class="memo-legacy">{{ block.type }}</span>
  </div>
</template>
