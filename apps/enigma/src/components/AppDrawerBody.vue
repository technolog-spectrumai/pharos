<script setup lang="ts">
// What the menu drawer shows (AppDrawer mounts it only while open): your rooms
// with New chat / Join on top, who is in the open room, then the app's pages and
// the light/dark switch. Opening a room or one of its dialogs from another page
// goes to Chat first, where those live.
import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { OyaIconButton } from "petalite/primitives";
import { useChatStore } from "../stores/chat";
import { drawerOpen } from "../stores/ui";
import { isTabVisible } from "../tabs";
import RoomsSidebar from "./chat/RoomsSidebar.vue";
import ParticipantsPanel from "./chat/ParticipantsPanel.vue";

const props = defineProps<{ darkMode: boolean }>();
const emit = defineEmits<{ "update:darkMode": [boolean] }>();

const chat = useChatStore();
const channel = chat.p2p;
const controller = chat.rooms;
const { currentRoom, participants } = channel;
const { createOpen, joinOpen, infoOpen, deleteOpen } = controller;
const route = useRoute();
const router = useRouter();

function close() {
  drawerOpen.value = false;
}

// A room opened, or a room dialog asked for: close the menu and show the chat.
watch([() => currentRoom.value?.slug, createOpen, joinOpen, infoOpen, deleteOpen], (now, before) => {
  if (!drawerOpen.value) return;
  const opened = now.some((v, i) => v && v !== before[i]);
  if (!opened) return;
  close();
  if (route.path !== "/chat") void router.push("/chat");
});

const link = "flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition hover:bg-current/10";
</script>

<template>
  <div>
  <div class="flex items-center justify-between pb-3">
    <span class="text-sm font-bold">{{ $t("chat.rooms") }}</span>
    <OyaIconButton icon="xmark" size="sm" :label="$t('nav.closeMenu')" @click="close" />
  </div>

  <RoomsSidebar :channel="channel" :controller="controller" />

  <div v-if="currentRoom" class="mt-4 border-t border-current/10 pt-4">
    <div class="flex items-center justify-between">
      <span class="text-sm font-bold">{{ $t("chat.participants") }}</span>
      <span class="text-xs opacity-60">{{ participants.length }}</span>
    </div>
    <div class="mt-3">
      <ParticipantsPanel :channel="channel" compact />
    </div>
  </div>

  <nav class="mt-4 space-y-0.5 border-t border-current/10 pt-3" data-testid="drawer-nav">
    <RouterLink v-if="isTabVisible('chat')" to="/chat" :class="link">
      <font-awesome-icon icon="comments" class="w-4 text-center" />{{ $t("nav.chat") }}
    </RouterLink>
    <RouterLink v-if="isTabVisible('files')" to="/files" :class="link">
      <font-awesome-icon icon="file-arrow-up" class="w-4 text-center" />{{ $t("nav.files") }}
      <span v-if="chat.fileShare.state.value === 'incoming'" class="h-2 w-2 animate-pulse rounded-full bg-warn-dark" />
    </RouterLink>
    <RouterLink to="/friends" :class="link">
      <font-awesome-icon icon="user-group" class="w-4 text-center" />{{ $t("nav.friends") }}
    </RouterLink>
    <RouterLink to="/config" :class="link">
      <font-awesome-icon icon="gear" class="w-4 text-center" />{{ $t("nav.settings") }}
    </RouterLink>
    <button type="button" :class="link" class="w-full" @click="emit('update:darkMode', !props.darkMode)">
      <font-awesome-icon :icon="darkMode ? 'sun' : 'moon'" class="w-4 text-center" />
      {{ darkMode ? $t("nav.lightMode") : $t("nav.darkMode") }}
    </button>
  </nav>
  </div>
</template>
