<script setup lang="ts">
defineProps<{
  darkMode: boolean;
}>();
</script>

<template>
  <section class="mx-auto flex w-full max-w-7xl flex-1 items-center justify-center">
    <article
      :class="
        darkMode
          ? 'bg-[#182033] border-[#5b6fba] text-white'
          : 'bg-[#f0f1f4] border-[#25345c] text-[#25345c]'
      "
      class="w-full max-w-md rounded-lg border p-6 text-center shadow-lg transition sm:p-8"
    >
      <h2 class="text-2xl font-bold leading-tight sm:text-3xl">
        Welcome to Spectrum Platform
      </h2>

      <p
        :class="darkMode ? 'text-white/70' : 'text-black/70'"
        class="mt-5 text-sm leading-relaxed"
      >
        A compact portal into the Spectrum Platform — streamlined, ready, and
        built to explore.
      </p>

      <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <button
          type="button"
          :class="
            darkMode
              ? 'bg-[#5b6fba] text-black hover:bg-[#6f83d1]'
              : 'bg-[#25345c] text-white hover:bg-[#334675]'
          "
          class="rounded px-4 py-2 text-sm font-semibold transition"
        >
          Enter Dashboard
        </button>

        <button
          type="button"
          :class="
            darkMode
              ? 'bg-[#5b6fba] text-black hover:bg-[#6f83d1]'
              : 'bg-[#25345c] text-white hover:bg-[#334675]'
          "
          class="rounded px-4 py-2 text-sm font-semibold transition"
        >
          Show Details
        </button>
      </div>
    </article>
  </section>
</template>