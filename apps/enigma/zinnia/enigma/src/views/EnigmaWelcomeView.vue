<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../services/api";
import { logo2Dark, logo2Light } from "../assets/logos";
import OyaButton from "../components/OyaButton.vue";

const props = defineProps<{ darkMode: boolean }>();
const router = useRouter();

const stats = ref({
  rooms: null as number | null,
  notes: null as number | null,
  files: null as number | null,
  projects: null as number | null,
  addresses: null as number | null,
  zones: null as number | null,
  profiles: null as number | null,
  communities: null as number | null,
});

const dashLoading = ref(true);

onMounted(async () => {
  await Promise.allSettled([
    api.getRooms().then((r) => { stats.value.rooms = r.channels.length; }),
    api.getBoxes().then((r) => { stats.value.notes = r.boxes.length; }),
    api.getFiles().then((r) => { stats.value.files = r.files.length; }),
    api.getProjects().then((r) => { stats.value.projects = r.projects.length; }),
    api.getAddresses().then((r) => { stats.value.addresses = r.addresses.length; }),
    api.getZones().then((r) => { stats.value.zones = r.zones.length; }),
    api.getProfiles().then((r) => { stats.value.profiles = r.profiles.length; }),
    api.getCommunities().then((r) => { stats.value.communities = r.communities.length; }),
  ]);
  dashLoading.value = false;
});

function statLabel(n: number | null): string {
  if (n === null) return "—";
  return String(n);
}

function cardCls() {
  return props.darkMode
    ? "bg-bubble-bg-dark border-accent-1"
    : "bg-bubble-bg-light border-accent-2";
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6">

    <!-- Header -->
    <header class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div class="space-y-2">
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          Oya Studio
        </p>

        <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
          <img
            :src="darkMode ? logo2Dark : logo2Light"
            alt="Enigma logo"
            class="h-20 w-20 rounded-2xl object-contain sm:h-24 sm:w-24"
          />
          <div>
            <h1 class="text-3xl font-bold sm:text-4xl">Enigma</h1>
            <p class="mt-1.5 max-w-xl text-sm opacity-65">
              Encrypted workspace — chat, notes, vault, tasks, maps, and more.
            </p>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <OyaButton :dark-mode="darkMode" variant="secondary" @click="router.push('/chat')">
          <font-awesome-icon icon="comments" />
          Rooms
        </OyaButton>
        <OyaButton :dark-mode="darkMode" @click="router.push('/chat')">
          <font-awesome-icon icon="door-open" />
          Enter chat
        </OyaButton>
      </div>
    </header>

    <!-- Top stats row -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div
        v-for="stat in [
          { label: 'Rooms', value: stats.rooms, icon: 'comments' },
          { label: 'Notes', value: stats.notes, icon: 'note-sticky' },
          { label: 'Files', value: stats.files, icon: 'hard-drive' },
          { label: 'Projects', value: stats.projects, icon: 'list-check' },
        ]"
        :key="stat.label"
        :class="cardCls()"
        class="rounded-xl border p-4 shadow-sm"
      >
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-semibold uppercase tracking-wide opacity-50">{{ stat.label }}</span>
          <font-awesome-icon :icon="stat.icon" class="opacity-30 text-sm" />
        </div>
        <div class="text-3xl font-bold">
          <span v-if="dashLoading" class="opacity-30 text-lg">…</span>
          <span v-else>{{ statLabel(stat.value) }}</span>
        </div>
      </div>
    </div>

    <!-- Module grid -->
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">

      <!-- Chat -->
      <div :class="cardCls()" class="rounded-xl border p-5 shadow-sm flex flex-col gap-4">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div :class="darkMode ? 'bg-accent-dark/15' : 'bg-accent-light/10'" class="h-10 w-10 rounded-xl flex items-center justify-center">
              <font-awesome-icon icon="comments" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
            </div>
            <div>
              <p class="font-bold text-sm">Chat</p>
              <p class="text-xs opacity-50">Encrypted messaging</p>
            </div>
          </div>
          <span :class="darkMode ? 'bg-accent-dark/20 text-accent-dark' : 'bg-accent-light/10 text-accent-light'" class="rounded-full px-2 py-0.5 text-xs font-bold">
            {{ statLabel(stats.rooms) }} rooms
          </span>
        </div>
        <p class="text-xs opacity-60 leading-relaxed">MLS-encrypted chat rooms with voice message support and participant management.</p>
        <OyaButton :dark-mode="darkMode" class="mt-auto" @click="router.push('/chat')">
          <font-awesome-icon icon="arrow-right" />Open chat
        </OyaButton>
      </div>

      <!-- Notes -->
      <div :class="cardCls()" class="rounded-xl border p-5 shadow-sm flex flex-col gap-4">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div :class="darkMode ? 'bg-accent-dark/15' : 'bg-accent-light/10'" class="h-10 w-10 rounded-xl flex items-center justify-center">
              <font-awesome-icon icon="note-sticky" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
            </div>
            <div>
              <p class="font-bold text-sm">Notes</p>
              <p class="text-xs opacity-50">Knowledge graph</p>
            </div>
          </div>
          <span :class="darkMode ? 'bg-accent-dark/20 text-accent-dark' : 'bg-accent-light/10 text-accent-light'" class="rounded-full px-2 py-0.5 text-xs font-bold">
            {{ statLabel(stats.notes) }} notes
          </span>
        </div>
        <p class="text-xs opacity-60 leading-relaxed">Linked notes, concepts, and a graph view connecting your ideas.</p>
        <OyaButton :dark-mode="darkMode" class="mt-auto" @click="router.push('/notes')">
          <font-awesome-icon icon="arrow-right" />Open notes
        </OyaButton>
      </div>

      <!-- Storage -->
      <div :class="cardCls()" class="rounded-xl border p-5 shadow-sm flex flex-col gap-4">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div :class="darkMode ? 'bg-accent-dark/15' : 'bg-accent-light/10'" class="h-10 w-10 rounded-xl flex items-center justify-center">
              <font-awesome-icon icon="hard-drive" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
            </div>
            <div>
              <p class="font-bold text-sm">Storage</p>
              <p class="text-xs opacity-50">Encrypted vault</p>
            </div>
          </div>
          <span :class="darkMode ? 'bg-accent-dark/20 text-accent-dark' : 'bg-accent-light/10 text-accent-light'" class="rounded-full px-2 py-0.5 text-xs font-bold">
            {{ statLabel(stats.files) }} files
          </span>
        </div>
        <p class="text-xs opacity-60 leading-relaxed">Encrypted file storage with bucket organization and password-protected GeoJSON support.</p>
        <OyaButton :dark-mode="darkMode" class="mt-auto" @click="router.push('/vault')">
          <font-awesome-icon icon="arrow-right" />Open storage
        </OyaButton>
      </div>

      <!-- Tasks -->
      <div :class="cardCls()" class="rounded-xl border p-5 shadow-sm flex flex-col gap-4">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div :class="darkMode ? 'bg-accent-dark/15' : 'bg-accent-light/10'" class="h-10 w-10 rounded-xl flex items-center justify-center">
              <font-awesome-icon icon="list-check" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
            </div>
            <div>
              <p class="font-bold text-sm">Tasks</p>
              <p class="text-xs opacity-50">Kanban projects</p>
            </div>
          </div>
          <span :class="darkMode ? 'bg-accent-dark/20 text-accent-dark' : 'bg-accent-light/10 text-accent-light'" class="rounded-full px-2 py-0.5 text-xs font-bold">
            {{ statLabel(stats.projects) }} projects
          </span>
        </div>
        <p class="text-xs opacity-60 leading-relaxed">Kanban boards with missions, sprints, backlogs, and the Eisenhower matrix.</p>
        <OyaButton :dark-mode="darkMode" class="mt-auto" @click="router.push('/tasks')">
          <font-awesome-icon icon="arrow-right" />Open tasks
        </OyaButton>
      </div>

      <!-- Locations -->
      <div :class="cardCls()" class="rounded-xl border p-5 shadow-sm flex flex-col gap-4">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div :class="darkMode ? 'bg-accent-dark/15' : 'bg-accent-light/10'" class="h-10 w-10 rounded-xl flex items-center justify-center">
              <font-awesome-icon icon="map" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
            </div>
            <div>
              <p class="font-bold text-sm">Locations</p>
              <p class="text-xs opacity-50">Map & geodata</p>
            </div>
          </div>
          <div class="flex flex-col items-end gap-0.5">
            <span :class="darkMode ? 'bg-accent-dark/20 text-accent-dark' : 'bg-accent-light/10 text-accent-light'" class="rounded-full px-2 py-0.5 text-xs font-bold">
              {{ statLabel(stats.addresses) }} addresses
            </span>
            <span class="text-[10px] opacity-40">{{ statLabel(stats.zones) }} zones</span>
          </div>
        </div>
        <p class="text-xs opacity-60 leading-relaxed">Interactive OSM map with territories, zones, routes, addresses, and data layers.</p>
        <OyaButton :dark-mode="darkMode" class="mt-auto" @click="router.push('/locations')">
          <font-awesome-icon icon="arrow-right" />Open map
        </OyaButton>
      </div>

      <!-- People -->
      <div :class="cardCls()" class="rounded-xl border p-5 shadow-sm flex flex-col gap-4">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div :class="darkMode ? 'bg-accent-dark/15' : 'bg-accent-light/10'" class="h-10 w-10 rounded-xl flex items-center justify-center">
              <font-awesome-icon icon="users" :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" />
            </div>
            <div>
              <p class="font-bold text-sm">People</p>
              <p class="text-xs opacity-50">Social network</p>
            </div>
          </div>
          <div class="flex flex-col items-end gap-0.5">
            <span :class="darkMode ? 'bg-accent-dark/20 text-accent-dark' : 'bg-accent-light/10 text-accent-light'" class="rounded-full px-2 py-0.5 text-xs font-bold">
              {{ statLabel(stats.profiles) }} profiles
            </span>
            <span class="text-[10px] opacity-40">{{ statLabel(stats.communities) }} communities</span>
          </div>
        </div>
        <p class="text-xs opacity-60 leading-relaxed">People directory with org charts and community membership management.</p>
        <OyaButton :dark-mode="darkMode" class="mt-auto" @click="router.push('/people')">
          <font-awesome-icon icon="arrow-right" />Open people
        </OyaButton>
      </div>

    </div>

  </section>
</template>
