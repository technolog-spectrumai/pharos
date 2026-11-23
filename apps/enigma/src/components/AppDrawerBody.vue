<script setup lang="ts">
// What the ☰ menu shows (AppDrawer mounts it only while open), as plain rows:
// New chat, Join chat, your rooms, then the app's pages and the light/dark
// switch. Opening a room or a room dialog from another page goes to the chat
// first, where those live.
import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useChatStore } from "../stores/chat";
import { drawerOpen } from "../stores/ui";
import { isTabVisible } from "../tabs";

const props = defineProps<{ darkMode: boolean }>();
const emit = defineEmits<{ "update:darkMode": [boolean] }>();

const chat = useChatStore();
const channel = chat.p2p;
const controller = chat.rooms;
const { currentRoom, p2pRooms } = channel;
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

const row = "flex w-full items-center gap-3 px-5 py-3.5 text-left text-sm transition hover:bg-current/10";
</script>

<template>
  <div class="divide-y divide-current/10" data-testid="drawer-nav">
    <button type="button" :class="row" data-testid="menu-new-chat" @click="controller.openCreate()">
      <font-awesome-icon icon="circle-nodes" class="w-4 text-center" />{{ $t("chat.newChat") }}
    </button>
    <button type="button" :class="row" data-testid="menu-join-chat" @click="controller.openJoin()">
      <font-awesome-icon icon="right-to-bracket" class="w-4 text-center" />{{ $t("chat.joinChat") }}
    </button>

    <div v-if="p2pRooms.length" data-testid="menu-rooms">
      <p class="px-5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide opacity-50">{{ $t("chat.savedRooms") }}</p>
      <button
        v-for="r in p2pRooms"
        :key="r.room"
        type="button"
        :class="[row, currentRoom?.slug === r.room ? 'font-semibold text-accent-light dark:text-accent-dark' : '']"
        @click="channel.openP2pRoom(r)"
      >
        <font-awesome-icon icon="comments" class="w-4 text-center opacity-70" />
        <span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
        <font-awesome-icon v-if="currentRoom?.slug === r.room" icon="check" class="opacity-70" />
      </button>
    </div>

    <RouterLink v-if="isTabVisible('chat')" to="/chat" :class="row">
      <font-awesome-icon icon="comments" class="w-4 text-center" />{{ $t("nav.chat") }}
    </RouterLink>
    <RouterLink v-if="isTabVisible('files')" to="/files" :class="row">
      <font-awesome-icon icon="file-arrow-up" class="w-4 text-center" />{{ $t("nav.files") }}
      <span v-if="chat.fileShare.state.value === 'incoming'" class="h-2 w-2 animate-pulse rounded-full bg-warn-dark" />
    </RouterLink>
    <RouterLink to="/friends" :class="row">
      <font-awesome-icon icon="user-group" class="w-4 text-center" />{{ $t("nav.friends") }}
    </RouterLink>
    <RouterLink to="/config" :class="row">
      <font-awesome-icon icon="gear" class="w-4 text-center" />{{ $t("nav.settings") }}
    </RouterLink>
    <button type="button" :class="row" @click="emit('update:darkMode', !props.darkMode)">
      <font-awesome-icon :icon="darkMode ? 'sun' : 'moon'" class="w-4 text-center" />
      {{ darkMode ? $t("nav.lightMode") : $t("nav.darkMode") }}
    </button>
  </div>
</template>
