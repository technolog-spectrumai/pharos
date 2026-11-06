<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { ChatChannel } from "rakotis";
import { useP2pRooms } from "./chat/useP2pRooms";
import ChatHeader from "./chat/ChatHeader.vue";
import ObserverBanner from "./chat/ObserverBanner.vue";
import RoomStatusBar from "./chat/RoomStatusBar.vue";
import MessageList from "./chat/MessageList.vue";
import MessageComposer from "./chat/MessageComposer.vue";
import RoomsSidebar from "./chat/RoomsSidebar.vue";
import QrScannerModal from "./chat/QrScannerModal.vue";
import CreateRoomModal from "./chat/CreateRoomModal.vue";
import JoinRoomModal from "./chat/JoinRoomModal.vue";
import RoomInfoModal from "./chat/RoomInfoModal.vue";
import DeleteRoomModal from "./chat/DeleteRoomModal.vue";
import RoomsModal from "./chat/RoomsModal.vue";
import ParticipantsModal from "./chat/ParticipantsModal.vue";

const props = defineProps<{ channel: ChatChannel }>();
const channel = props.channel;
const { currentRoom, error, isParticipant } = channel;

// Shared P2P room state — one instance feeds both the desktop sidebar and the drawer.
const p2p = useP2pRooms(channel);
const { createOpen, joinOpen, infoOpen, deleteOpen } = p2p;
const sidebarOpen = ref(false);
const participantsOpen = ref(false);

// ── Join ⇄ camera handoff ────────────────────────────────────────────────────
// The scanner is only reachable from inside the join window, and both are
// body-teleported overlays: leaving the join modal open behind the camera meant
// its backdrop + opaque card painted over the live feed (teleport siblings stack
// by MOUNT order, not by which opened last). So the two are mutually exclusive —
// the camera takes the whole screen, and the join window comes straight back on a
// decode or a dismiss, since it owns the connect/MLS progress and the auto-close
// countdown.
const scanning = ref(false);

function openScanner() {
  joinOpen.value = false;
  scanning.value = true;
}
function closeScanner() {
  scanning.value = false;
  joinOpen.value = true;
}
async function onScanned(ticket: string) {
  scanning.value = false;
  joinOpen.value = true; // progress renders there, so restore it BEFORE joining
  await p2p.joinTicket(ticket);
}

onMounted(() => channel.loadP2pRooms());
watch(currentRoom, () => (sidebarOpen.value = false));
</script>

<template>
  <div class="grid h-full min-h-0 w-full gap-4 overflow-hidden lg:grid-cols-[16rem_minmax(0,1fr)]">
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
      <ChatHeader :channel="channel" @open-sidebar="sidebarOpen = true" @participants="participantsOpen = true" @new-chat="p2p.openCreate()" @join-chat="p2p.openJoin()" />
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

    <!-- Off-screen mount point for html5-qrcode's scan-from-image-file flow. -->
    <div id="p2p-qr-file-region" class="hidden"></div>

    <!-- QR camera scanner — replaces the join window while it's up, then hands the
         screen back (never open at the same time; it also rides its own z layer). -->
    <QrScannerModal
      :open="scanning"
      @update:open="$event ? openScanner() : closeScanner()"
      @decoded="onScanned($event)"
    />

    <!-- Create / Join modals (teleport to body, so they also cover the mobile drawer) -->
    <CreateRoomModal v-model:open="createOpen" :controller="p2p" />
    <JoinRoomModal v-model:open="joinOpen" :channel="channel" :controller="p2p" @open-camera="openScanner" />
    <RoomInfoModal v-model:open="infoOpen" :controller="p2p" :channel="channel" />
    <DeleteRoomModal v-model:open="deleteOpen" :controller="p2p" />

    <!-- Rooms (the phone's ☰) and participants: dialogs, not side sliders. -->
    <RoomsModal v-model:open="sidebarOpen" :channel="channel" :controller="p2p" />
    <ParticipantsModal v-model:open="participantsOpen" :channel="channel" />
  </div>
</template>
