<script setup lang="ts">
// Privacy MANA as a tab of its own (technology.md §17).
//
// It lived as a sixth pill inside Settings until the meters became something
// people check rather than configure — a budget you glance at belongs beside the
// things it scores, not three levels down beside the passphrase and the panic
// code. The header chip links straight here.
//
// The panel itself is shared with the welcome page, so the two can never
// disagree about a number.
import ManaPanel from "../components/mana/ManaPanel.vue";

defineProps<{ darkMode?: boolean }>();
</script>

<template>
  <section class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 pb-8">
    <div class="flex flex-col gap-1">
      <h1 class="text-lg font-bold">{{ $t("mana.title") }}</h1>
      <p class="text-sm leading-relaxed opacity-70">{{ $t("mana.intro") }}</p>
    </div>
    <ManaPanel />
  </section>
</template>
