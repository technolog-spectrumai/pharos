<script setup lang="ts">
import { OyaModal, OyaTextField, OyaButton } from "petalite/primitives";
import RoomShareCard from "./RoomShareCard.vue";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ open: boolean; controller: P2pRoomsController }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const { name, createdRoom, createBusy, createError, createRoom } = props.controller;

// Every Enigma room is a Tor room: the spinner says the wait is Tor's, and the
// creator hosts the onion (the captain ★ hint).
const tor = true;

function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <!-- Same shape as "Add a friend": one panel, wide enough on a desktop, the
         whole width of a phone, its actions inside it. -->
    <div
      class="max-h-[85dvh] w-[min(32rem,92vw)] space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      data-testid="create-room"
    >
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="circle-nodes" />{{ $t("chat.newChat") }}
      </h2>

      <!-- Name form -->
      <section v-if="!createdRoom && !createBusy && !createError" class="space-y-2">
        <label class="block text-sm font-semibold" for="new-room-name">{{ $t("chat.newRoomLabel") }}</label>
        <OyaTextField id="new-room-name" v-model="name" :placeholder="$t('chat.newRoomName')" @enter="createRoom" />
        <p class="text-xs opacity-60">{{ $t("chat.newRoomHelp") }}</p>
      </section>

      <!-- Launching -->
      <section v-else-if="createBusy" class="flex flex-col items-center gap-3 py-8 text-center" role="status">
        <font-awesome-icon icon="spinner" spin class="text-3xl text-accent-dark" />
        <p class="text-sm opacity-70">{{ tor ? $t("chat.launchingOnion") : $t("chat.creatingRoom") }}</p>
      </section>

      <!-- Created: you host it; invite people from here -->
      <section v-else-if="createdRoom" class="space-y-3">
        <div class="rounded-xl border border-success-dark/30 bg-success-dark/10 p-3">
          <p class="flex items-center gap-2 text-sm font-semibold text-success-dark">
            <font-awesome-icon v-if="tor" icon="star" class="text-highlight" />{{ $t("chat.youAreHost") }}
          </p>
          <p v-if="tor" class="mt-1 text-xs opacity-70">{{ $t("chat.hostStarHint") }}</p>
        </div>
        <h3 class="font-bold">{{ $t("chat.shareTicket") }}</h3>
        <!-- The same card Room info uses, so the two can never disagree. -->
        <RoomShareCard :room-slug="createdRoom.slug" :room-name="createdRoom.name" :tor="tor" />
      </section>

      <!-- Error -->
      <section v-else-if="createError" class="space-y-2" role="alert">
        <p class="flex items-center gap-2 text-sm font-semibold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />{{ $t("chat.launchFailed") }}
        </p>
        <p class="text-xs opacity-70">{{ $t(createError) }}</p>
      </section>

      <div class="flex justify-end gap-2 pt-1">
        <OyaButton type="button" @click="close">{{ createdRoom ? $t("chat.done") : $t("chat.close") }}</OyaButton>
        <OyaButton v-if="!createdRoom && !createBusy && !createError" type="button" data-testid="create-room-submit" @click="createRoom">
          <font-awesome-icon icon="plus" />{{ $t("chat.create") }}
        </OyaButton>
        <OyaButton v-if="createError" type="button" @click="createRoom">
          <font-awesome-icon icon="rotate" />{{ $t("chat.retry") }}
        </OyaButton>
      </div>
    </div>
  </OyaModal>
</template>
