<script setup lang="ts">
import { computed } from "vue";
import { OyaModal } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ open: boolean; controller: P2pRoomsController }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const room = computed(() => props.controller.deleteRoomEntry.value);
const busy = computed(() => props.controller.deleteBusy.value);

function close() {
  if (busy.value) return;
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div v-if="room" class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
        <font-awesome-icon icon="triangle-exclamation" />{{ $t("chat.deleteRoomTitle") }}
      </p>

      <p class="flex items-center gap-2 text-sm font-semibold">
        <font-awesome-icon icon="circle-nodes" class="opacity-60" />{{ room.name }}
      </p>

      <!-- Host dissolves for everyone; a joiner only removes it locally. -->
      <p class="text-sm opacity-80">
        {{ room.host ? $t("chat.deleteRoomHostWarn") : $t("chat.deleteRoomLocalWarn") }}
      </p>
    </div>

    <template #footer>
      <button
        type="button"
        :disabled="busy"
        class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50"
        @click="close"
      >
        {{ $t("chat.cancel") }}
      </button>
      <button
        type="button"
        :disabled="busy"
        class="flex items-center gap-2 rounded-lg border border-warn-dark/50 px-4 py-2 text-sm font-semibold text-warn-dark transition hover:bg-warn-dark/10 disabled:opacity-50"
        @click="controller.confirmDelete()"
      >
        <font-awesome-icon :icon="busy ? 'spinner' : 'trash'" :spin="busy" />
        {{ busy ? $t("chat.deleting") : $t("chat.delete") }}
      </button>
    </template>
  </OyaModal>
</template>
