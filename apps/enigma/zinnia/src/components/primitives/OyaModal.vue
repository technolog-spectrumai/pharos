<script setup lang="ts">
// Centered overlay modal (teleported to <body>) with backdrop + click-outside close.
//
// Stacking: every modal teleports to <body>, so two open at the same time are
// siblings with the same z-index and the one MOUNTED last paints on top — mount
// order (the parent's template/import order), not open order. A modal that can be
// launched from inside another one must therefore claim its own layer with `:z`
// instead of trusting where its component happens to sit in the parent template.
// The app's ladder: sticky header 50 · modal 60 (this default) · idle-lock warning
// 70 · vault gate 80. Keep custom values inside it.
//
// Sizing: the overlay is measured against the DYNAMIC viewport (100dvh) — 100vh
// counts the mobile URL bar, so a full-height child would be pushed under it —
// and its padding carries the safe-area insets so content clears notches and the
// home indicator. Content taller than the viewport scrolls (the inner wrapper is
// `min-h-full` + auto margins so centred content can never become unreachable).
withDefaults(defineProps<{ open: boolean; z?: number }>(), { z: 60 });
const emit = defineEmits<{ "update:open": [boolean]; close: [] }>();
function close() {
  emit("update:open", false);
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 h-[100dvh] overflow-y-auto bg-black/70 p-6 pt-[calc(1.5rem+env(safe-area-inset-top))] pr-[calc(1.5rem+env(safe-area-inset-right))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] pl-[calc(1.5rem+env(safe-area-inset-left))] text-text-main-light dark:text-text-main-dark"
        :style="{ zIndex: z }"
        data-testid="oya-modal-overlay"
        @click.self="close"
      >
        <div class="m-auto flex min-h-full w-full flex-col items-center justify-center gap-3" @click.self="close">
          <slot />
          <div v-if="$slots.footer"><slot name="footer" /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
