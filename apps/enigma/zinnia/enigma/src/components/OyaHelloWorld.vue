<script setup lang="ts">
defineProps<{
  darkMode: boolean;
}>();
</script>

<template>
  <section
    :class="
      darkMode
        ? 'bg-bubble-bg-dark border-accent-1'
        : 'bg-bubble-bg-light border-accent-2'
    "
    class="mx-auto grid min-h-[calc(100vh-12rem)] max-w-7xl overflow-hidden rounded-lg border shadow-md lg:grid-cols-[15rem_minmax(0,1fr)_16rem]"
  >
    <aside
      :class="
        darkMode
          ? 'bg-appbar-bg-dark border-accent-1'
          : 'bg-appbar-bg-light border-accent-2 text-appbar-text-light'
      "
      class="hidden border-r p-4 lg:block"
    >
      <div class="border-b border-current/10 pb-3">
        <span class="text-sm font-semibold tracking-wide">Rooms</span>
      </div>

      <nav class="mt-4 space-y-2">
        <a
          href="#"
          :class="
            darkMode
              ? 'bg-sunken-dark border-accent-dark text-text-main-dark'
              : 'bg-sunken-light border-accent-light text-text-main-light'
          "
          class="block rounded border px-3 py-3 transition"
        >
          <span class="block truncate text-sm font-semibold">
            Hello Room
          </span>
          <span class="mt-1 block text-xs opacity-60">
            1 participant
          </span>
        </a>

        <a
          href="#"
          :class="
            darkMode
              ? 'border-accent-1 text-text-main-dark hover:bg-sunken-dark'
              : 'border-accent-2 text-appbar-text-light hover:bg-accent-light'
          "
          class="block rounded border px-3 py-3 transition"
        >
          <span class="block truncate text-sm font-semibold">
            Test Room
          </span>
          <span class="mt-1 block text-xs opacity-60">
            0 participants
          </span>
        </a>
      </nav>
    </aside>

    <section class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <header
        :class="
          darkMode
            ? 'bg-appbar-bg-dark text-appbar-text-dark'
            : 'bg-appbar-bg-light text-appbar-text-light'
        "
        class="flex items-center justify-between gap-3 border-b border-current/10 p-4"
      >
        <div>
          <h2
            :class="darkMode ? 'text-accent-dark' : 'text-appbar-text-light'"
            class="text-2xl font-bold tracking-wide"
          >
            Hello Room
          </h2>

          <div class="mt-1 flex gap-3 text-xs opacity-70">
            <span>1 participant</span>
            <span>1 human</span>
            <span>Encrypted demo</span>
          </div>
        </div>

        <div class="flex gap-2">
          <span
            :class="
              darkMode
                ? 'bg-success-dark text-primary-bg-dark border-success-dark'
                : 'bg-success-light text-primary-bg-light border-success-light'
            "
            class="rounded border px-3 py-2 text-xs font-bold shadow-sm"
          >
            Connected
          </span>

          <span
            :class="
              darkMode
                ? 'bg-success-dark text-primary-bg-dark border-success-dark'
                : 'bg-success-light text-primary-bg-light border-success-light'
            "
            class="rounded border px-3 py-2 text-xs font-bold shadow-sm"
          >
            Encrypted
          </span>
        </div>
      </header>

      <div
        :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'"
        class="space-y-4 overflow-y-auto p-4"
      >
        <article class="flex justify-start gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 text-sm font-bold"
          >
            O
          </div>

          <div
            :class="
              darkMode
                ? 'bg-bubble-bg-dark border-accent-1'
                : 'bg-bubble-bg-light border-accent-2'
            "
            class="max-w-[78%] rounded-lg border p-3 shadow-sm"
          >
            <p class="text-sm font-semibold">
              Oya System
            </p>

            <p class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90">
              Hello from your first Vue component in Amazing Moon style.
            </p>
          </div>
        </article>

        <article class="flex justify-end gap-3">
          <div
            :class="
              darkMode
                ? 'bg-accent-dark border-accent-1 text-text-main-dark'
                : 'bg-accent-light border-accent-2 text-appbar-text-light'
            "
            class="max-w-[78%] rounded-lg border p-3 text-right shadow-sm"
          >
            <p class="text-sm font-semibold">
              You
            </p>

            <p class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90">
              Nice. The Amazing Moon shell works.
            </p>
          </div>

          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 text-sm font-bold"
          >
            J
          </div>
        </article>
      </div>

      <div
        :class="darkMode ? 'bg-appbar-bg-dark' : 'bg-appbar-bg-light'"
        class="border-t border-current/10 p-4"
      >
        <div class="flex gap-3">
          <textarea
            placeholder="Message Hello Room"
            :class="
              darkMode
                ? 'bg-sunken-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/40'
                : 'bg-sunken-light border-accent-2 text-text-main-light placeholder:text-text-main-light/40'
            "
            class="h-12 min-h-12 flex-1 resize-none rounded border px-3 py-3 text-sm outline-none transition focus:ring-2 focus:ring-current/20"
          />

          <button
            type="button"
            :class="
              darkMode
                ? 'bg-accent-dark text-text-main-dark'
                : 'bg-accent-light text-appbar-text-light'
            "
            class="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded font-semibold transition hover:opacity-90"
            aria-label="Send"
          >
            →
          </button>
        </div>
      </div>
    </section>

    <aside
      :class="
        darkMode
          ? 'bg-appbar-bg-dark border-accent-1 text-appbar-text-dark'
          : 'bg-appbar-bg-light border-accent-2 text-appbar-text-light'
      "
      class="hidden border-l p-4 lg:block"
    >
      <div class="border-b border-current/10 pb-3">
        <h2 class="text-lg font-bold tracking-wide">
          Participants
        </h2>
      </div>

      <div class="mt-4 space-y-3">
        <div class="flex items-center gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 text-sm font-bold"
          >
            J
          </div>

          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">
              Jan
            </p>
            <p class="text-xs opacity-60">
              Human
            </p>
          </div>
        </div>
      </div>
    </aside>
  </section>
</template>