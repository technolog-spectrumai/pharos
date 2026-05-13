<script setup lang="ts">
import logo2Dark from "../assets/logo2_dark.png";
import logo2Light from "../assets/logo2_light.png";
import OyaCard from "./OyaCard.vue";
import OyaButton from "./OyaButton.vue";

defineProps<{
  darkMode: boolean;
}>();

const emit = defineEmits<{
  openChat: [];
}>();
</script>

<template>
  <section class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6">
    <header class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div class="space-y-2">
        <a href="#" class="inline-flex items-center gap-2 text-sm underline hover:opacity-80">
          <font-awesome-icon icon="arrow-left" />
          Dashboard
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
                A compact encrypted chat workspace for rooms, participants, and messages.
              </p>
            </div>
          </div>
        </div>
      </div>

      <nav class="flex flex-wrap gap-2">
        <OyaButton :dark-mode="darkMode" variant="secondary">
          <font-awesome-icon icon="comments" />
          Rooms
        </OyaButton>

        <OyaButton :dark-mode="darkMode" @click="emit('openChat')">
          <font-awesome-icon icon="door-open" />
          Enter chat
        </OyaButton>
      </nav>
    </header>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <OyaCard :dark-mode="darkMode" :padded="true">
        <div class="text-2xl font-bold">Encrypted</div>
        <div class="mt-1 text-xs opacity-65">Room-based communication scaffold</div>
      </OyaCard>

      <OyaCard :dark-mode="darkMode">
        <div class="text-2xl font-bold">Simple</div>
        <div class="mt-1 text-xs opacity-65">Rooms, users, and chat messages</div>
      </OyaCard>

      <OyaCard :dark-mode="darkMode" :padded="true">
        <div class="text-2xl font-bold">Modular</div>
        <div class="mt-1 text-xs opacity-65">Ready for vault, tasks, and maps later</div>
      </OyaCard>
    </div>

    <OyaCard :dark-mode="darkMode" class="overflow-hidden">
      <div class="grid gap-6 p-5 lg:grid-cols-[1fr_18rem] lg:p-6">
        <div>
          <p
            :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
            class="text-xs font-semibold uppercase tracking-wide"
          >
            Present more
          </p>

          <h2 class="mt-2 text-2xl font-bold">
            Start with the chat core
          </h2>

          <p class="mt-3 max-w-2xl text-sm leading-relaxed opacity-75">
            Enigma should begin as a clean communication workspace. Add rooms,
            participants, messages, and presence first. Then connect Vault,
            Tasks, Calendar, and Locations as modules.
          </p>

          <div class="mt-5 flex flex-wrap gap-2">
            <OyaButton :dark-mode="darkMode" @click="emit('openChat')">
              <font-awesome-icon icon="comments" />
              Open chat view
            </OyaButton>

            <OyaButton :dark-mode="darkMode" variant="secondary">
              <font-awesome-icon icon="plus" />
              Create room
            </OyaButton>
          </div>
        </div>

        <div
          :class="
            darkMode
              ? 'border-accent-1 bg-primary-bg-dark'
              : 'border-accent-2 bg-primary-bg-light'
          "
          class="rounded-lg border p-4"
        >
          <h3 class="text-sm font-bold">Next modules</h3>

          <ul class="mt-3 space-y-2 text-sm opacity-75">
            <li>Vault integration</li>
            <li>Room tasks</li>
            <li>Calendar events</li>
            <li>Map/location cards</li>
          </ul>
        </div>
      </div>
    </OyaCard>
  </section>
</template>