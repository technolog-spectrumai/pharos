<script setup lang="ts">
import logo2Dark from "../assets/logo2_dark.png";
import logo2Light from "../assets/logo2_light.png";

defineProps<{
  darkMode: boolean;
}>();
</script>

<template>
  <section class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6">
    <!-- PAGE HEADER -->
    <header class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div class="space-y-2">
        <a href="#" class="inline-flex items-center gap-2 text-sm underline hover:opacity-80">
          ← Dashboard
        </a>

        <div>
          <p
            :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
            class="text-xs font-semibold uppercase tracking-wide"
          >
            Oya Studio
          </p>

          <div class="mt-2 flex flex-col gap-4 sm:flex-row sm:items-center">
            <img
              :src="darkMode ? logo2Dark : logo2Light"
              alt="Enigma logo"
              class="h-24 w-24 rounded-2xl object-contain sm:h-28 sm:w-28 lg:h-32 lg:w-32"
            />

            <div>
              <h1 class="flex items-center gap-3 text-3xl font-bold sm:text-4xl">
                Enigma
              </h1>

              <p class="mt-2 max-w-2xl text-sm opacity-70">
                A compact encrypted chat workspace. Rooms, participants, messages,
                and agents will live here.
              </p>
            </div>
          </div>

          <p class="mt-2 max-w-2xl text-sm opacity-70">
            A compact encrypted chat workspace. Rooms, participants, messages,
            and agents will live here.
          </p>
        </div>
      </div>

      <nav class="flex flex-wrap gap-2">
        <button
          type="button"
          :class="
            darkMode
              ? 'border-accent-1 bg-bubble-bg-dark'
              : 'border-accent-2 bg-bubble-bg-light'
          "
          class="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold shadow-sm transition hover:opacity-85"
        >
          Rooms
        </button>

        <button
          type="button"
          :class="
            darkMode
              ? 'bg-accent-dark text-primary-bg-dark'
              : 'bg-accent-light text-primary-bg-light'
          "
          class="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition hover:opacity-90"
        >
          New room
        </button>

        <button
          type="button"
          :class="
            darkMode
              ? 'border-accent-1 bg-bubble-bg-dark'
              : 'border-accent-2 bg-bubble-bg-light'
          "
          class="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold shadow-sm transition hover:opacity-85"
        >
          Agents
        </button>
      </nav>
    </header>

    <!-- STATS -->
    <div class="grid gap-3 sm:grid-cols-3">
      <div
        :class="
          darkMode
            ? 'border-accent-1 bg-bubble-bg-dark'
            : 'border-accent-2 bg-bubble-bg-light'
        "
        class="rounded-lg border p-4 shadow-sm"
      >
        <div class="text-2xl font-bold">1</div>
        <div class="text-xs opacity-65">Active room</div>
      </div>

      <div
        :class="
          darkMode
            ? 'border-accent-1 bg-bubble-bg-dark'
            : 'border-accent-2 bg-bubble-bg-light'
        "
        class="rounded-lg border p-4 shadow-sm"
      >
        <div class="text-2xl font-bold">1</div>
        <div class="text-xs opacity-65">Participant</div>
      </div>

      <div
        :class="
          darkMode
            ? 'border-accent-1 bg-bubble-bg-dark'
            : 'border-accent-2 bg-bubble-bg-light'
        "
        class="rounded-lg border p-4 shadow-sm"
      >
        <div class="text-2xl font-bold">0</div>
        <div class="text-xs opacity-65">Agents</div>
      </div>
    </div>

    <!-- CHAT WORKSPACE -->
    <section
      class="grid min-h-[70vh] gap-4 lg:grid-cols-[18rem_minmax(0,1fr)_18rem]"
    >
      <!-- ROOMS -->
      <aside
        :class="
          darkMode
            ? 'border-accent-1 bg-bubble-bg-dark'
            : 'border-accent-2 bg-bubble-bg-light'
        "
        class="hidden min-h-0 rounded-lg border p-4 shadow-md lg:flex lg:flex-col"
      >
        <div class="flex items-center justify-between border-b border-current/10 pb-3">
          <h2 class="text-sm font-bold">Rooms</h2>
          <span class="text-xs opacity-60">2</span>
        </div>

        <nav class="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          <a
            href="#"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-dark'
                : 'bg-primary-bg-light border-accent-light'
            "
            class="block rounded-lg border px-3 py-3 transition hover:opacity-85"
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
                ? 'border-accent-1 hover:bg-primary-bg-dark'
                : 'border-accent-2 hover:bg-primary-bg-light'
            "
            class="block rounded-lg border px-3 py-3 transition"
          >
            <span class="block truncate text-sm font-semibold">
              Agent Lab
            </span>
            <span class="mt-1 block text-xs opacity-60">
              Work in progress
            </span>
          </a>
        </nav>

        <button
          type="button"
          :class="
            darkMode
              ? 'bg-accent-dark text-primary-bg-dark'
              : 'bg-accent-light text-primary-bg-light'
          "
          class="mt-4 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition hover:opacity-90"
        >
          Create room
        </button>
      </aside>

      <!-- MAIN CHAT -->
      <section
        :class="
          darkMode
            ? 'border-accent-1 bg-bubble-bg-dark'
            : 'border-accent-2 bg-bubble-bg-light'
        "
        class="grid min-h-0 overflow-hidden rounded-lg border shadow-md grid-rows-[auto_minmax(0,1fr)_auto]"
      >
        <header class="flex flex-wrap items-center gap-3 border-b border-current/10 p-4">
          <div class="min-w-0 flex-1">
            <p
              :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
              class="text-xs font-semibold uppercase tracking-wide"
            >
              Active room
            </p>

            <h2 class="mt-1 truncate text-2xl font-bold">
              Hello Room
            </h2>

            <div class="mt-1 flex flex-wrap gap-3 text-xs opacity-70">
              <span>1 participant</span>
              <span>1 human</span>
              <span>Encrypted demo</span>
            </div>
          </div>

          <span
            :class="
              darkMode
                ? 'bg-success-dark text-primary-bg-dark border-success-dark'
                : 'bg-success-light text-primary-bg-light border-success-light'
            "
            class="rounded-lg border px-3 py-2 text-xs font-bold shadow-sm"
          >
            Connected
          </span>

          <span
            :class="
              darkMode
                ? 'bg-warn-dark text-primary-bg-dark border-warn-dark'
                : 'bg-warn-light text-primary-bg-light border-warn-light'
            "
            class="rounded-lg border px-3 py-2 text-xs font-bold shadow-sm"
          >
            Work in progress
          </span>
        </header>

        <div
          :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'"
          class="min-h-0 space-y-4 overflow-y-auto p-4"
        >
          <article class="flex min-w-0 justify-start gap-3">
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
              class="min-w-0 max-w-[calc(100%-3.25rem)] overflow-hidden rounded-lg border p-3 shadow-sm sm:max-w-[78%]"
            >
              <p class="text-sm font-semibold">
                Oya System
              </p>

              <p class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90 [overflow-wrap:anywhere]">
                Hello World. This is the Enigma chat scaffold using only Oya theme colors.
              </p>
            </div>
          </article>

          <article class="flex min-w-0 justify-end gap-3">
            <div
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1'
                  : 'bg-primary-bg-light border-accent-2'
              "
              class="min-w-0 max-w-[calc(100%-3.25rem)] overflow-hidden rounded-lg border p-3 text-right shadow-sm sm:max-w-[78%]"
            >
              <p class="text-sm font-semibold">
                You
              </p>

              <p class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90 [overflow-wrap:anywhere]">
                Nice. Keep this as a work-in-progress chat interface.
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
              :class="
                darkMode
                  ? 'border-accent-1 bg-bubble-bg-dark'
                  : 'border-accent-2 bg-bubble-bg-light'
              "
              class="rounded-full border px-4 py-2 text-xs opacity-70 shadow-sm"
            >
              More chat features coming soon
            </div>
          </div>
        </div>

        <div
          :class="darkMode ? 'bg-bubble-bg-dark' : 'bg-bubble-bg-light'"
          class="border-t border-current/10 p-4"
        >
          <div class="flex flex-col gap-3 sm:flex-row">
            <div
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark/50'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light/50'
              "
              class="flex h-12 flex-1 items-center rounded-lg border px-3 text-sm"
            >
              Message composer — work in progress
            </div>

            <button
              type="button"
              :class="
                darkMode
                  ? 'bg-accent-dark text-primary-bg-dark'
                  : 'bg-accent-light text-primary-bg-light'
              "
              class="rounded-lg px-5 py-3 text-sm font-bold shadow-sm transition hover:opacity-90"
            >
              Work in progress
            </button>
          </div>
        </div>
      </section>

      <!-- PARTICIPANTS -->
      <aside
        :class="
          darkMode
            ? 'border-accent-1 bg-bubble-bg-dark'
            : 'border-accent-2 bg-bubble-bg-light'
        "
        class="hidden min-h-0 rounded-lg border p-4 shadow-md lg:flex lg:flex-col"
      >
        <div class="border-b border-current/10 pb-3">
          <h2
            :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
            class="text-lg font-bold"
          >
            Participants
          </h2>
        </div>

        <div class="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
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

            <span
              :class="
                darkMode
                  ? 'bg-success-dark text-primary-bg-dark'
                  : 'bg-success-light text-primary-bg-light'
              "
              class="rounded-full px-2 py-0.5 text-xs font-bold"
            >
              On
            </span>
          </div>

          <div
            :class="
              darkMode
                ? 'border-accent-1 bg-primary-bg-dark'
                : 'border-accent-2 bg-primary-bg-light'
            "
            class="rounded-lg border p-3 text-xs opacity-70"
          >
            Invite agent panel coming later.
          </div>
        </div>

        <button
          type="button"
          :class="
            darkMode
              ? 'border-accent-1 bg-bubble-bg-dark'
              : 'border-accent-2 bg-bubble-bg-light'
          "
          class="mt-4 rounded-lg border px-4 py-2 text-sm font-semibold shadow-sm transition hover:opacity-85"
        >
          Invite agent
        </button>
      </aside>
    </section>
  </section>
</template>