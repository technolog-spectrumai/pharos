<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

// One compact bar, as in any messenger: the rooms button, the room's name with
// its state on one line under it, Invite, and a menu for everything rarer.
const props = defineProps<{ channel: ChatChannel; controller: P2pRoomsController }>();
defineEmits<{ "open-sidebar": [] }>();
const { t } = useI18n();
const ch = props.channel;
const { currentRoom, mlsStatus, wsStatus, linkedOnions, p2pRooms } = ch;

const entry = computed(() => p2pRooms.value.find((r) => r.room === currentRoom.value?.slug) ?? null);

/** The room's state in a few words: encryption first, then who is reachable. */
const encryption = computed(() => {
  switch (mlsStatus.value) {
    case "ready":
      return { text: t("chat.mlsReady"), icon: "lock", tone: "text-success-light dark:text-success-dark" };
    case "error":
      return { text: t("chat.mlsError"), icon: "triangle-exclamation", tone: "text-warn-dark" };
    default:
      return { text: t("chat.mlsKeyExchange"), icon: "lock-open", tone: "opacity-70" };
  }
});
const reach = computed(() => {
  switch (wsStatus.value) {
    case "connected":
      return t("chat.linkedTo", { n: linkedOnions.value.length }, linkedOnions.value.length);
    case "waiting":
      return t("chat.waitingForOthers");
    case "disconnected":
      return t("chat.statusOffline");
    case "error":
      return t("chat.statusError");
    default:
      return t("chat.statusConnecting");
  }
});

const menuOpen = ref(false);
function run(fn: () => void) {
  menuOpen.value = false;
  fn();
}
function invite() {
  if (entry.value) props.controller.openInfo(entry.value);
}
</script>

<template>
  <header class="flex items-center gap-2 border-b border-current/10 px-3 py-2.5 sm:px-4">
    <button
      type="button"
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition hover:bg-current/10 lg:hidden"
      :aria-label="$t('chat.a11yOpenRooms')"
      @click="$emit('open-sidebar')"
    >
      <font-awesome-icon icon="bars" />
    </button>

    <div class="min-w-0 flex-1">
      <h2 class="truncate text-lg font-bold leading-tight">
        {{ currentRoom?.name ?? $t("chat.selectARoom") }}
      </h2>
      <p v-if="currentRoom" class="flex items-center gap-1.5 truncate text-xs" data-testid="room-state">
        <font-awesome-icon :icon="encryption.icon" :class="encryption.tone" />
        <span :class="encryption.tone">{{ encryption.text }}</span>
        <span class="opacity-40">·</span>
        <span class="truncate opacity-70">{{ reach }}</span>
      </p>
    </div>

    <template v-if="currentRoom">
      <button
        type="button"
        class="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-accent-dark px-3 text-sm font-semibold text-primary-bg-dark transition hover:opacity-90 disabled:opacity-40"
        :disabled="!entry"
        data-testid="invite-button"
        @click="invite"
      >
        <font-awesome-icon icon="user-plus" /><span class="hidden sm:inline">{{ $t("chat.invite") }}</span>
      </button>

      <div class="relative shrink-0">
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-lg transition hover:bg-current/10"
          :aria-label="$t('chat.roomMenu')"
          :aria-expanded="menuOpen"
          data-testid="room-menu"
          @click="menuOpen = !menuOpen"
        >
          <font-awesome-icon icon="ellipsis-vertical" />
        </button>
        <template v-if="menuOpen">
          <div class="fixed inset-0 z-40" @click="menuOpen = false" />
          <div
            class="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-xl border border-current/15 bg-primary-bg-light text-sm shadow-xl dark:bg-primary-bg-dark"
            role="menu"
          >
            <button v-if="entry" type="button" role="menuitem" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-current/10" @click="run(invite)">
              <font-awesome-icon icon="circle-info" class="w-4 opacity-70" />{{ $t("chat.roomInfo") }}
            </button>
            <button type="button" role="menuitem" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-current/10" @click="run(() => ch.forceResetMls())">
              <font-awesome-icon icon="rotate-right" class="w-4 opacity-70" />{{ $t("chat.resetEncryption") }}
            </button>
            <button type="button" role="menuitem" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-current/10" @click="run(() => ch.leaveParticipant())">
              <font-awesome-icon icon="right-from-bracket" class="w-4 opacity-70" />{{ $t("chat.leave") }}
            </button>
            <button
              v-if="entry"
              type="button"
              role="menuitem"
              class="flex w-full items-center gap-3 border-t border-current/10 px-4 py-3 text-left text-warn-dark hover:bg-warn-dark/10"
              @click="run(() => controller.openDeleteConfirm(entry!))"
            >
              <font-awesome-icon icon="trash" class="w-4" />{{ $t("chat.deleteRoom") }}
            </button>
          </div>
        </template>
      </div>
    </template>
  </header>
</template>
