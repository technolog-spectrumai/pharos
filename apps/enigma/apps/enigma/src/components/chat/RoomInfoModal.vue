<script setup lang="ts">
import { computed } from "vue";
import { OyaModal, OyaQrCode, OyaCopyField } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ open: boolean; controller: P2pRoomsController }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const room = computed(() => props.controller.infoRoom.value);

function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div v-if="room" class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="circle-nodes" />{{ room.name }}
      </p>

      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="rounded-full border border-current/20 px-2 py-0.5 opacity-70">
          {{ room.tor ? "Tor" : "iroh" }}
        </span>
        <span v-if="room.host" class="flex items-center gap-1 font-semibold text-success-dark">
          <font-awesome-icon v-if="room.tor" icon="star" class="text-yellow-400" />{{ $t("chat.youAreHost") }}
        </span>
      </div>

      <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareTicket") }}</p>
      <OyaQrCode :value="room.ticket" :size="176" alt="Room QR code" />
      <p class="text-center text-[10px] opacity-50">{{ $t("chat.scanToJoin") }}</p>
      <OyaCopyField :value="room.ticket" mono :copy-label="$t('chat.copy')" />
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
