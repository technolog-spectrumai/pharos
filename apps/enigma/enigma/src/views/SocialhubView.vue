<script setup lang="ts">
import { ref, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useSocialhubStore } from "../stores/socialhub";

defineProps<{ darkMode: boolean }>();

const store = useSocialhubStore();
const { profiles, communities, selectedProfile, selectedCommunity, loading, error } = storeToRefs(store);

const tab = ref<"people" | "communities">("people");

onMounted(() => {
  store.fetchProfiles();
  store.fetchCommunities();
});

const ORG_TYPE_COLORS: Record<string, string> = {
  guild: "bg-purple-500/20 text-purple-400",
  company: "bg-blue-500/20 text-blue-400",
  non_profit: "bg-green-500/20 text-green-400",
  family: "bg-orange-500/20 text-orange-400",
  other: "bg-gray-500/20 text-gray-400",
};
</script>

<template>
  <div class="flex w-full h-[calc(100vh-9rem)] gap-4 overflow-hidden">

    <!-- Left panel -->
    <div class="flex flex-1 flex-col gap-4 overflow-hidden">

      <!-- Tabs -->
      <div class="flex gap-1 shrink-0">
        <button
          @click="tab = 'people'; store.clearSelection()"
          :class="[
            'rounded-lg px-4 py-2 text-sm font-semibold border transition',
            tab === 'people'
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
              : 'border-current/20 opacity-60 hover:opacity-100'
          ]"
        >
          <font-awesome-icon icon="users" class="mr-1.5" />People
        </button>
        <button
          @click="tab = 'communities'; store.clearSelection()"
          :class="[
            'rounded-lg px-4 py-2 text-sm font-semibold border transition',
            tab === 'communities'
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
              : 'border-current/20 opacity-60 hover:opacity-100'
          ]"
        >
          <font-awesome-icon icon="building" class="mr-1.5" />Communities
        </button>
      </div>

      <div v-if="error" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400 shrink-0">{{ error }}</div>

      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center py-16 opacity-50">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>

      <!-- People grid -->
      <div v-else-if="tab === 'people'" class="overflow-y-auto">
        <div v-if="profiles.length === 0" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
          <font-awesome-icon icon="users" class="text-4xl" />
          <p class="text-sm">No people found</p>
        </div>
        <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <button
            v-for="p in profiles"
            :key="p.id"
            @click="store.openProfile(p.slug)"
            :class="[
              'flex flex-col items-center gap-2 rounded-xl border p-3 text-left transition hover:opacity-80',
              selectedProfile?.id === p.id
                ? (darkMode ? 'border-accent-dark bg-accent-dark/20' : 'border-accent-light bg-accent-light/20')
                : (darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2')
            ]"
          >
            <img
              v-if="p.avatar_url"
              :src="p.avatar_url"
              :alt="p.display_name"
              class="h-14 w-14 rounded-full object-cover"
            />
            <div v-else class="flex h-14 w-14 items-center justify-center rounded-full bg-current/10">
              <font-awesome-icon icon="user" class="text-2xl opacity-40" />
            </div>
            <p class="text-xs font-semibold text-center truncate w-full">{{ p.display_name }}</p>
            <p class="text-xs opacity-40">{{ p.community_count }} comm.</p>
          </button>
        </div>
      </div>

      <!-- Communities grid -->
      <div v-else class="overflow-y-auto">
        <div v-if="communities.length === 0" class="flex flex-col items-center justify-center py-16 opacity-40 gap-3">
          <font-awesome-icon icon="building" class="text-4xl" />
          <p class="text-sm">No communities found</p>
        </div>
        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <button
            v-for="c in communities"
            :key="c.id"
            @click="store.openCommunity(c.slug)"
            :class="[
              'flex items-start gap-3 rounded-xl border p-4 text-left transition hover:opacity-80',
              selectedCommunity?.id === c.id
                ? (darkMode ? 'border-accent-dark bg-accent-dark/20' : 'border-accent-light bg-accent-light/20')
                : (darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2')
            ]"
          >
            <font-awesome-icon icon="building" class="mt-0.5 opacity-50 shrink-0" />
            <div class="min-w-0">
              <p class="font-semibold text-sm truncate">{{ c.name }}</p>
              <span :class="ORG_TYPE_COLORS[c.org_type] ?? 'bg-gray-500/20 text-gray-400'"
                class="mt-1 inline-block rounded px-2 py-0.5 text-xs">{{ c.org_type_label }}</span>
              <p class="mt-1 text-xs opacity-40">{{ c.member_count }} members</p>
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- Detail slide-in -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      enter-from-class="translate-x-8 opacity-0"
      enter-to-class="translate-x-0 opacity-100"
      leave-active-class="transition-all duration-150 ease-in"
      leave-from-class="translate-x-0 opacity-100"
      leave-to-class="translate-x-8 opacity-0"
    >
      <aside
        v-if="selectedProfile || selectedCommunity"
        :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="w-72 shrink-0 rounded-xl border p-4 shadow-md overflow-y-auto"
      >
        <!-- Close -->
        <button @click="store.clearSelection()" class="mb-3 text-xs opacity-50 transition hover:opacity-100">
          <font-awesome-icon icon="xmark" /> Close
        </button>

        <!-- Profile detail -->
        <template v-if="selectedProfile">
          <div class="flex flex-col items-center gap-3 text-center">
            <img v-if="selectedProfile.avatar_url" :src="selectedProfile.avatar_url" class="h-20 w-20 rounded-full object-cover" />
            <div v-else class="flex h-20 w-20 items-center justify-center rounded-full bg-current/10">
              <font-awesome-icon icon="user" class="text-3xl opacity-40" />
            </div>
            <p class="font-bold text-lg">{{ selectedProfile.display_name }}</p>
            <p v-if="selectedProfile.full_name !== selectedProfile.display_name" class="text-sm opacity-60">{{ selectedProfile.full_name }}</p>
          </div>
          <div v-if="selectedProfile.communities?.length" class="mt-4">
            <p class="text-xs font-semibold opacity-60 mb-2">Communities</p>
            <ul class="space-y-1">
              <li v-for="c in selectedProfile.communities" :key="c.id" class="text-sm opacity-70 flex items-center gap-1.5">
                <font-awesome-icon icon="building" class="opacity-40 text-xs" />
                {{ c.name }}
              </li>
            </ul>
          </div>
        </template>

        <!-- Community detail -->
        <template v-if="selectedCommunity">
          <div class="flex flex-col items-center gap-2 text-center mb-4">
            <div class="flex h-16 w-16 items-center justify-center rounded-full bg-current/10">
              <font-awesome-icon icon="building" class="text-3xl opacity-40" />
            </div>
            <p class="font-bold text-lg">{{ selectedCommunity.name }}</p>
            <span :class="ORG_TYPE_COLORS[selectedCommunity.org_type] ?? ''"
              class="rounded px-2 py-0.5 text-xs">{{ selectedCommunity.org_type_label }}</span>
          </div>
          <div class="space-y-2 text-sm">
            <div v-if="selectedCommunity.head_name">
              <span class="opacity-50 text-xs">Head:</span>
              <span class="ml-1">{{ selectedCommunity.head_name }}</span>
            </div>
            <div><span class="opacity-50 text-xs">Members:</span> <span class="ml-1">{{ selectedCommunity.member_count }}</span></div>
            <div v-if="selectedCommunity.latest_news_title">
              <p class="text-xs opacity-50 mb-0.5">Latest news</p>
              <p class="text-xs">{{ selectedCommunity.latest_news_title }}</p>
            </div>
          </div>
          <div v-if="selectedCommunity.members?.length" class="mt-4">
            <p class="text-xs font-semibold opacity-60 mb-2">Senior Members</p>
            <ul class="space-y-1">
              <li v-for="m in selectedCommunity.members" :key="m.id" class="text-sm opacity-70 flex items-center gap-1.5">
                <font-awesome-icon icon="user" class="opacity-40 text-xs" />
                {{ m.name }}
              </li>
            </ul>
          </div>
        </template>
      </aside>
    </Transition>
  </div>
</template>
