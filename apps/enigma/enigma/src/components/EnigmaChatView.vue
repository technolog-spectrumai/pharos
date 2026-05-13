<script setup lang="ts">
import OyaCard from "./OyaCard.vue";
import OyaButton from "./OyaButton.vue";

defineProps<{
  darkMode: boolean;
}>();

const emit = defineEmits<{
  back: [];
}>();

const rooms = [
  { name: "Hello Room", detail: "1 participant" },
  { name: "Test Room", detail: "Work in progress" },
];

const users = [
  { name: "Jan", role: "Human", initials: "J" },
];

const messages = [
  {
    user: "Oya System",
    initials: "O",
    body: "Hello World. This is the simplified Enigma chat scaffold.",
    self: false,
  },
  {
    user: "You",
    initials: "J",
    body: "Nice. Rooms, users, and chatbox only for now.",
    self: true,
  },
];
</script>

<template>
  <section class="mx-auto grid w-full max-w-7xl flex-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_16rem]">
    <!-- ROOMS -->
    <OyaCard :dark-mode="darkMode" class="hidden min-h-[70vh] lg:block">
      <div class="flex items-center justify-between border-b border-current/10 pb-3">
        <h2 class="text-sm font-bold">
          <font-awesome-icon icon="comments" class="mr-2" />
          Rooms
        </h2>

        <button class="text-xs underline opacity-70 hover:opacity-100" @click="emit('back')">
          Welcome
        </button>
      </div>

      <nav class="mt-4 space-y-2">
        <a
          v-for="room in rooms"
          :key="room.name"
          href="#"
          :class="
            room.name === 'Hello Room'
              ? darkMode
                ? 'bg-primary-bg-dark border-accent-dark'
                : 'bg-primary-bg-light border-accent-light'
              : darkMode
                ? 'border-accent-1 hover:bg-primary-bg-dark'
                : 'border-accent-2 hover:bg-primary-bg-light'
          "
          class="block rounded-lg border px-3 py-3 transition"
        >
          <span class="block truncate text-sm font-semibold">
            {{ room.name }}
          </span>

          <span class="mt-1 block text-xs opacity-60">
            {{ room.detail }}
          </span>
        </a>
      </nav>

      <OyaButton :dark-mode="darkMode" class="mt-4 w-full">
        <font-awesome-icon icon="plus" />
        New room
      </OyaButton>
    </OyaCard>

    <!-- CHATBOX -->
    <OyaCard
      :dark-mode="darkMode"
      :padded="false"
      class="grid min-h-[70vh] overflow-hidden grid-rows-[auto_minmax(0,1fr)_auto]"
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
            <span>Encrypted demo</span>
          </div>
        </div>

        <span
          :class="
            darkMode
              ? 'bg-success-dark text-primary-bg-dark border-success-dark'
              : 'bg-success-light text-primary-bg-light border-success-light'
          "
          class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold shadow-sm"
        >
          <font-awesome-icon icon="check" />
          Connected
        </span>
      </header>

      <div
        :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'"
        class="min-h-0 space-y-4 overflow-y-auto p-4"
      >
        <article
          v-for="message in messages"
          :key="message.body"
          class="flex min-w-0 gap-3"
          :class="message.self ? 'justify-end' : 'justify-start'"
        >
          <div
            v-if="!message.self"
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 text-sm font-bold"
          >
            {{ message.initials }}
          </div>

            <div
            :class="[
                darkMode
                ? 'bg-bubble-bg-dark border-accent-1'
                : 'bg-bubble-bg-light border-accent-2',
                message.self ? 'text-right' : ''
            ]"
            class="min-w-0 max-w-[calc(100%-3.25rem)] overflow-hidden rounded-lg border p-3 shadow-sm sm:max-w-[78%]"
            >
            <p class="text-sm font-semibold">
              {{ message.user }}
            </p>

            <p class="mt-1 whitespace-pre-wrap break-words text-sm opacity-90 [overflow-wrap:anywhere]">
              {{ message.body }}
            </p>
          </div>

          <div
            v-if="message.self"
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 text-sm font-bold"
          >
            {{ message.initials }}
          </div>
        </article>
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

          <OyaButton :dark-mode="darkMode">
            <font-awesome-icon icon="paper-plane" />
            Send
          </OyaButton>
        </div>
      </div>
    </OyaCard>

    <!-- USERS -->
    <OyaCard :dark-mode="darkMode" class="hidden min-h-[70vh] lg:block">
      <div class="border-b border-current/10 pb-3">
        <h2
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-lg font-bold"
        >
          <font-awesome-icon icon="user" class="mr-2" />
          Users
        </h2>
      </div>

      <div class="mt-4 space-y-3">
        <div
          v-for="user in users"
          :key="user.name"
          class="flex items-center gap-3"
        >
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/15 text-sm font-bold"
          >
            {{ user.initials }}
          </div>

          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">
              {{ user.name }}
            </p>

            <p class="text-xs opacity-60">
              {{ user.role }}
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
      </div>
    </OyaCard>
  </section>
</template>