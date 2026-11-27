<script setup lang="ts">
import { computed } from "vue";
import { OyaModal } from "petalite/primitives";
import RoomShareCard from "./RoomShareCard.vue";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ open: boolean; controller: P2pRoomsController; channel: ChatChannel }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const room = computed(() => props.controller.infoRoom.value);

function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div v-if="room" class="max-h-[85dvh] w-full max-w-sm space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <div class="flex items-center gap-3">
        <font-awesome-icon icon="circle-nodes" class="text-lg opacity-60" />
        <p class="min-w-0 flex-1 truncate text-lg font-bold">{{ room.name }}</p>
        <span v-if="room.host" class="shrink-0 rounded-full border border-current/20 px-2 py-0.5 text-xs opacity-70">
          {{ $t("chat.youAreHost") }}
        </span>
      </div>

      <!-- What is true of every room: invitation only, over Tor, members linked directly. -->
      <div class="flex items-start gap-3">
        <font-awesome-icon icon="lock" class="mt-0.5 shrink-0 text-success-light dark:text-success-dark" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t("chat.inviteOnly") }}</p>
          <!-- Deliberately not "only people you invite can join": enforcement is
               app convention, so a member on a modified build could still admit
               someone (technology.md §18). -->
          <p class="text-xs leading-relaxed opacity-60">{{ $t("chat.inviteOnlyOnHint") }}</p>
        </div>
      </div>
      <div class="flex items-start gap-3">
        <font-awesome-icon icon="shield-halved" class="mt-0.5 shrink-0 opacity-70" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ $t("chat.overTor") }}</p>
          <p class="text-xs leading-relaxed opacity-60">{{ $t("chat.overTorHint") }}</p>
        </div>
      </div>

      <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareTicket") }}</p>
      <RoomShareCard :room-slug="room.room" :room-name="room.name" />
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        @click="close"
      >
        {{ $t("chat.close") }}
      </button>
    </template>
  </OyaModal>
</template>
