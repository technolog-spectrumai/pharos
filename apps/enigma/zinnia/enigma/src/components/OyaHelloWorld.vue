<script setup lang="ts">
defineProps<{
  darkMode: boolean;
}>();
</script>

<template>
  <section
    class="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[15rem_minmax(0,1fr)_16rem] xl:grid-cols-[17rem_minmax(0,1fr)_18rem]"
  >
    <!-- LEFT ROOMS PANEL -->
    <aside
      :class="
        darkMode
          ? 'bg-[#182033] border-[#5b6fba]'
          : 'bg-[#f0f1f4] border-[#25345c]'
      "
      class="hidden min-h-0 rounded-lg border p-4 shadow-md lg:block"
    >
      <div class="flex items-center justify-between border-b border-current/10 pb-3">
        <span class="text-sm font-semibold">Rooms</span>
        <span class="text-xs opacity-60">2</span>
      </div>

      <nav class="mt-4 space-y-2">
        <a
          href="#"
          :class="
            darkMode
              ? 'bg-[#05080d] border-[#5b6fba]'
              : 'bg-white border-[#25345c]'
          "
          class="block rounded border px-3 py-3 transition hover:opacity-85"
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
          class="block rounded border border-current/20 px-3 py-3 transition hover:bg-current/10"
        >
          <span class="block truncate text-sm font-semibold">
            Test Room
          </span>
          <span class="mt-1 block text-xs opacity-60">
            Work in progress
          </span>
        </a>
      </nav>
    </aside>

    <!-- MAIN CHAT PANEL -->
    <section
      :class="
        darkMode
          ? 'bg-[#182033] border-[#5b6fba]'
          : 'bg-[#f0f1f4] border-[#25345c]'
      "
      class="grid min-h-[calc(100vh-12rem)] overflow-hidden rounded-lg border shadow-md grid-rows-[auto_minmax(0,1fr)_auto]"
    >
      <!-- CHAT HEADER -->
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-current/10 p-4">
        <div>
          <h2
            :class="darkMode ? 'text-[#7f91df]' : 'text-[#25345c]'"
            class="text-2xl font-bold"
          >
            Hello Room
          </h2>

          <div class="mt-1 flex flex-wrap gap-3 text-xs opacity-70">
            <span>1 participant</span>
            <span>1 human</span>
            <span>Encrypted demo</span>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <span
            class="rounded border border-current/20 px-3 py-2 text-xs font-bold shadow-sm"
          >
            Connected
          </span>

          <span
            :class="
              darkMode
                ? 'bg-[#7f91df] text-[#05080d]'
                : 'bg-[#25345c] text-white'
            "
            class="rounded px-3 py-2 text-xs font-bold shadow-sm"
          >
            Work in progress
          </span>
        </div>
      </header>

      <!-- MESSAGES -->
      <div
        :class="darkMode ? 'bg-[#05080d]' : 'bg-white'"
        class="min-h-0 space-y-4 overflow-y-auto p-4"
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
                ? 'bg-[#182033] border-[#5b6fba]'
                : 'bg-[#f0f1f4] border-[#25345c]'
            "
            class="max-w-[78%] rounded-lg border p-3 shadow-sm"
          >
            <p class="text-sm font-semibold">
              Oya System
            </p>

            <p class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90">
              Hello World. This chat scaffold is ready for the next feature.
            </p>
          </div>
        </article>

        <article class="flex justify-end gap-3">
          <div
            :class="
              darkMode
                ? 'bg-[#5b6fba] text-[#05080d] border-[#7f91df]'
                : 'bg-[#25345c] text-white border-[#25345c]'
            "
            class="max-w-[78%] rounded-lg border p-3 text-right shadow-sm"
          >
            <p class="text-sm font-semibold">
              You
            </p>

            <p class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90">
              Nice. The box and button can stay as work in progress.
            </p>
          </div>

          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 text-sm font-bold"
          >
            J
          </div>
        </article>

        <div class="flex justify-center">
          <div
            class="rounded-full border border-current/15 px-4 py-2 text-xs opacity-70"
          >
            More chat features coming soon
          </div>
        </div>
      </div>

      <!-- INPUT / WORK IN PROGRESS BOX -->
      <div
        :class="darkMode ? 'bg-[#121827]' : 'bg-[#e6e8ef]'"
        class="border-t border-current/10 p-4"
      >
        <div class="flex flex-col gap-3 sm:flex-row">
          <div
            :class="
              darkMode
                ? 'bg-[#05080d] border-[#5b6fba] text-white/60'
                : 'bg-white border-[#25345c] text-black/60'
            "
            class="flex min-h-12 flex-1 items-center rounded border px-3 py-3 text-sm"
          >
            Message box — work in progress
          </div>

          <button
            type="button"
            :class="
              darkMode
                ? 'bg-[#7f91df] text-[#05080d]'
                : 'bg-[#25345c] text-white'
            "
            class="rounded px-5 py-3 text-sm font-bold transition hover:opacity-90"
          >
            Work in progress
          </button>
        </div>
      </div>
    </section>

    <!-- RIGHT PARTICIPANTS PANEL -->
    <aside
      :class="
        darkMode
          ? 'bg-[#182033] border-[#5b6fba]'
          : 'bg-[#f0f1f4] border-[#25345c]'
      "
      class="hidden min-h-0 rounded-lg border p-4 shadow-md lg:block"
    >
      <div class="border-b border-current/10 pb-3">
        <h2
          :class="darkMode ? 'text-[#7f91df]' : 'text-[#25345c]'"
          class="text-lg font-bold"
        >
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

        <div class="rounded border border-current/15 p-3 text-xs opacity-70">
          Invite agent panel coming later.
        </div>
      </div>
    </aside>
  </section>
</template>