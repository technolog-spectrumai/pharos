<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { OyaModal } from "rakotis";
import type { ChatChannel } from "rakotis";
import { useChatStore } from "../stores/chat";
import { useP2pRooms } from "./chat/useP2pRooms";
import ChatHeader from "./chat/ChatHeader.vue";
import FilePanel from "./chat/FilePanel.vue";
import ObserverBanner from "./chat/ObserverBanner.vue";
import RoomStatusBar from "./chat/RoomStatusBar.vue";
import MessageList from "./chat/MessageList.vue";
import MessageComposer from "./chat/MessageComposer.vue";
import RoomsSidebar from "./chat/RoomsSidebar.vue";
import ParticipantsPanel from "./chat/ParticipantsPanel.vue";
import QrScannerModal from "./chat/QrScannerModal.vue";
import CreateRoomModal from "./chat/CreateRoomModal.vue";
import JoinRoomModal from "./chat/JoinRoomModal.vue";
import RoomInfoModal from "./chat/RoomInfoModal.vue";
import DeleteRoomModal from "./chat/DeleteRoomModal.vue";
import MobileRoomsDrawer from "./chat/MobileRoomsDrawer.vue";

const props = defineProps<{ channel: ChatChannel }>();
const channel = props.channel;
const { currentRoom, error, isParticipant } = channel;

// Shared P2P room state — one instance feeds both the desktop sidebar and the drawer.
const p2p = useP2pRooms(channel);
const { createOpen, joinOpen, infoOpen, deleteOpen } = p2p;
const sidebarOpen = ref(false);
const scanning = ref(false);

// P2P file transfer: the fileShare singleton lives in the chat store (so offers
// arrive while the modal is closed); this panel only owns the modal visibility.
// An incoming offer auto-opens the modal, call-style.
const { fileShare } = useChatStore();
const filesOpen = ref(false);
watch(fileShare.state, (s) => {
  if (s === "incoming") filesOpen.value = true;
});

onMounted(() => channel.loadP2pRooms());
watch(currentRoom, () => (sidebarOpen.value = false));
</script>

<template>
  <div class="grid h-full min-h-0 w-full gap-4 overflow-hidden lg:grid-cols-[16rem_minmax(0,1fr)_16rem]">
    <!-- Rooms sidebar (desktop) -->
    <aside
      class="hidden min-h-0 flex-col overflow-hidden rounded-lg border shadow-md lg:flex bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
    >
      <div class="flex items-center justify-between border-b border-current/10 p-4">
        <h2 class="text-sm font-bold"><font-awesome-icon icon="comments" class="mr-2" />{{ $t("chat.p2p") }}</h2>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <RoomsSidebar :channel="channel" :controller="p2p" />
      </div>
    </aside>

    <!-- Chatbox -->
    <section
      class="grid min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border shadow-md bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
    >
      <ChatHeader :channel="channel" @open-sidebar="sidebarOpen = true" @open-files="filesOpen = true" />
      <ObserverBanner v-if="currentRoom && !isParticipant" :channel="channel" />
      <div
        v-if="currentRoom && isParticipant"
        class="flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:hidden bg-primary-bg-light border-accent-2 dark:bg-primary-bg-dark dark:border-accent-1"
      >
        <RoomStatusBar :channel="channel" compact />
      </div>
      <div v-if="error" class="border-b border-warn-dark/30 bg-warn-dark/10 px-4 py-2 text-xs text-warn-dark">
        <font-awesome-icon icon="triangle-exclamation" class="mr-1" />{{ error }}
      </div>
      <MessageList :channel="channel" @open-sidebar="sidebarOpen = true" />
      <MessageComposer :channel="channel" />
    </section>

    <!-- Participants sidebar (desktop) -->
    <aside
      class="hidden min-h-0 flex-col overflow-hidden rounded-lg border shadow-md lg:flex bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
    >
      <div class="border-b border-current/10 p-4">
        <h2 class="text-lg font-bold text-accent-light dark:text-accent-dark">
          <font-awesome-icon icon="user" class="mr-2" />Participants
        </h2>
      </div>
      <div class="flex-1 overflow-y-auto p-4 pr-3">
        <ParticipantsPanel :channel="channel" />
      </div>
    </aside>

    <!-- Off-screen mount point for html5-qrcode's scan-from-image-file flow. -->
    <div id="p2p-qr-file-region" class="hidden"></div>

    <!-- QR camera scanner (feeds the join modal's progress via the controller) -->
    <QrScannerModal v-model:open="scanning" @decoded="p2p.joinTicket($event)" />

    <!-- Create / Join modals (teleport to body, so they also cover the mobile drawer) -->
    <CreateRoomModal v-model:open="createOpen" :controller="p2p" />
    <JoinRoomModal
      v-model:open="joinOpen"
      :channel="channel"
      :controller="p2p"
      :scanning="scanning"
      @toggle-camera="scanning = !scanning"
    />
    <RoomInfoModal v-model:open="infoOpen" :controller="p2p" />
    <DeleteRoomModal v-model:open="deleteOpen" :controller="p2p" />

    <!-- P2P file transfer (offer / accept / progress) -->
    <OyaModal v-model:open="filesOpen">
      <FilePanel />
    </OyaModal>

    <!-- Mobile rooms + participants drawer (reuses the same sub-components) -->
    <MobileRoomsDrawer v-model:open="sidebarOpen" :channel="channel" :controller="p2p" />
  </div>
</template>
