<script setup lang="ts">
// Presenting a deck — reveal.js 5.1.0, the same library and the same geometry
// zenobia's player uses, so a deck presents identically on both surfaces.
//
// Slides render through SlideBlock, exactly as the editor does. One definition
// of what a slide looks like; the player only supplies the stage.
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import SlideBlock from "./SlideBlock.vue";
import { columnsOf, slotsFor, type Presentation } from "../formats/presentation";

const props = defineProps<{ deck: Presentation; startAt?: number }>();

interface RevealInstance {
  initialize(): Promise<void>;
  destroy(): void;
  slide(index: number): void;
}
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n({ useScope: "global" });

const stage = ref<HTMLElement | null>(null);
let reveal: RevealInstance | null = null;

function onKey(e: KeyboardEvent) {
  // Reveal takes the arrows; Escape is ours, because there is no browser chrome
  // to leave a fullscreen player with.
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}

onMounted(async () => {
  const [{ default: Reveal }] = await Promise.all([
    import("reveal.js"),
    import("reveal.js/dist/reveal.css"),
  ]);
  await nextTick();
  if (!stage.value) return;

  reveal = new Reveal(stage.value, {
    // 1280×720 matches the editor's slide box exactly, so reveal scales the
    // same geometry the editor lays out — isomorphic, not merely similar.
    width: 1280,
    height: 720,
    // Load-bearing, not a preference: reveal's default centring positions a
    // section from its MEASURED height, and these sections are absolutely
    // positioned with height:auto — so a slide sized as a percentage of that
    // collapses to nothing. With centring off it pins to the stage it has
    // already sized to exactly width × height.
    center: false,
    margin: 0.04,
    transition: "slide",
    // No `hash`: zinnia has no URL bar to write to, and in the desktop webview
    // a hash change is a navigation nobody asked for.
    hash: false,
    slideNumber: "c/t",
    controls: true,
    progress: true,
    embedded: true,
    keyboardCondition: "focused",
  }) as unknown as RevealInstance;

  await reveal.initialize();
  if (props.startAt) reveal.slide(props.startAt);

  window.addEventListener("keydown", onKey, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  try {
    reveal?.destroy();
  } catch {
    /* a player that will not tear down must not block closing the deck */
  }
  reveal = null;
});
</script>

<template>
  <!-- The backdrop is the DECK's own background, not black.
       Reveal insets the slide by its margin, so a backdrop that differs from
       the slide paints that inset as a frame around every slide — and a
       white-themed deck came out framed in black. Taking the colour from the
       theme class makes the inset invisible in both themes while leaving
       reveal's geometry exactly as zenobia has it. -->
  <div class="fixed inset-0 z-50 flex flex-col"
       :class="`memo-theme-${props.deck.theme}`"
       :style="{ background: 'var(--r-background-color)', color: 'var(--r-main-color)' }">
    <div class="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs opacity-70">
      <span class="flex-1 truncate">{{ props.deck.title || t("deck.untitledSlide") }}</span>
      <button type="button" data-testid="player-close"
              class="oya-tip oya-tip-end rounded border border-current/25 px-2 py-1 transition hover:opacity-80"
              :data-tip="t('deck.exitPlay')" :title="t('deck.exitPlay')" @click="emit('close')">
        <font-awesome-icon icon="xmark" />
      </button>
    </div>

    <div ref="stage" class="reveal min-h-0 flex-1">
      <div class="slides">
        <section v-for="slide in props.deck.slides" :key="slide.id">
          <div class="memo-slide" :class="[`memo-theme-${props.deck.theme}`, `memo-font-${props.deck.font}`]"
               :data-layout="slide.layout">
            <h2 v-if="slide.title" class="memo-title">{{ slide.title }}</h2>
            <div v-for="[slot, blocks] in columnsOf(slide)" :key="slot"
                 class="memo-flow" :data-slot="slot"
                 :style="{ '--memo-columns': slotsFor(slide.layout).length }">
              <SlideBlock v-for="block in blocks" :key="block.id" :block="block" trust-html />
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
