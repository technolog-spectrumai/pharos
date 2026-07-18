<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { OyaModal, OyaQrCode, OyaCopyField, RULES_MAX_CHARS } from "rakotis";
import type { ChatChannel } from "rakotis";
import type { P2pRoomsController } from "./useP2pRooms";

const props = defineProps<{ open: boolean; controller: P2pRoomsController; channel: ChatChannel }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const room = computed(() => props.controller.infoRoom.value);

// Logo + rules + moderation are captain-editable only for the room that is
// currently OPEN (edits broadcast over its live MLS group). For other saved
// rooms the modal just displays whatever meta was last received.
const isCurrent = computed(() => !!room.value && props.channel.currentRoom.value?.slug === room.value.room);
const canEdit = computed(() => isCurrent.value && props.channel.amCaptain.value);
const logo = computed(() =>
  isCurrent.value ? props.channel.roomLogo.value : room.value?.logo ?? "");
const rules = computed(() =>
  isCurrent.value ? props.channel.roomRules.value : room.value?.rules ?? "");

const logoInput = ref<HTMLInputElement | null>(null);
async function onLogoPicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (logoInput.value) logoInput.value.value = "";
  if (file) await props.channel.setRoomLogo(file);
}

const editingRules = ref(false);
const rulesDraft = ref("");
watch(() => props.open, () => { editingRules.value = false; });
function startEditRules() {
  rulesDraft.value = rules.value;
  editingRules.value = true;
}
async function saveRules() {
  await props.channel.setRoomRules(rulesDraft.value);
  editingRules.value = false;
}

const bannedIds = computed(() => (isCurrent.value ? props.channel.bans.value : room.value?.bans ?? []));

function close() {
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="close">
    <div v-if="room" class="max-h-[85vh] w-full max-w-sm space-y-3 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <div class="flex items-center gap-3">
        <img v-if="logo" :src="logo" alt="Room logo" class="h-10 w-10 shrink-0 rounded-lg object-cover" />
        <font-awesome-icon v-else icon="circle-nodes" class="text-lg opacity-60" />
        <p class="min-w-0 flex-1 truncate text-lg font-bold">{{ room.name }}</p>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="rounded-full border border-current/20 px-2 py-0.5 opacity-70">
          {{ room.tor ? "Tor" : "iroh" }}
        </span>
        <span v-if="room.host" class="flex items-center gap-1 font-semibold text-success-dark">
          <font-awesome-icon v-if="room.tor" icon="star" class="text-highlight" />{{ $t("chat.youAreHost") }}
        </span>
      </div>

      <!-- Room logo (captain-set, shared to all members) -->
      <div v-if="canEdit" class="flex items-center gap-2 text-xs">
        <input ref="logoInput" type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="onLogoPicked" />
        <button
          type="button"
          class="rounded-lg border border-current/20 px-2.5 py-1 font-semibold transition hover:opacity-80"
          @click="logoInput?.click()"
        >
          <font-awesome-icon icon="image" class="mr-1" />{{ $t("chat.setLogo") }}
        </button>
        <button
          v-if="logo"
          type="button"
          class="rounded-lg border border-current/20 px-2.5 py-1 font-semibold opacity-70 transition hover:opacity-100"
          @click="channel.setRoomLogo(null)"
        >
          {{ $t("chat.removeLogo") }}
        </button>
      </div>

      <!-- Room rules (captain-set, shown to everyone) -->
      <div v-if="rules || canEdit" class="space-y-1">
        <p class="flex items-center justify-between text-[10px] uppercase tracking-wide opacity-50">
          {{ $t("chat.roomRules") }}
          <button
            v-if="canEdit && !editingRules"
            type="button"
            class="rounded border border-current/20 px-1.5 py-0.5 font-semibold normal-case opacity-80 transition hover:opacity-100"
            @click="startEditRules"
          >
            {{ $t("chat.editRules") }}
          </button>
        </p>
        <template v-if="editingRules">
          <textarea
            v-model="rulesDraft"
            :maxlength="RULES_MAX_CHARS"
            rows="4"
            :placeholder="$t('chat.rulesPlaceholder')"
            class="w-full rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm"
          ></textarea>
          <div class="flex justify-end gap-2 text-xs">
            <button type="button" class="rounded-lg px-2.5 py-1 font-semibold opacity-60 hover:opacity-100" @click="editingRules = false">
              {{ $t("chat.cancel") }}
            </button>
            <button type="button" class="rounded-lg border border-current/20 px-2.5 py-1 font-semibold hover:opacity-80" @click="saveRules">
              {{ $t("chat.saveRules") }}
            </button>
          </div>
        </template>
        <p v-else-if="rules" class="whitespace-pre-wrap rounded-lg bg-current/5 p-2 text-xs">{{ rules }}</p>
        <p v-else class="text-xs opacity-40">{{ $t("chat.noRules") }}</p>
      </div>

      <!-- Banned identities (captain can lift a ban) -->
      <div v-if="canEdit && bannedIds.length" class="space-y-1">
        <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.banned") }}</p>
        <div v-for="id in bannedIds" :key="id" class="flex items-center gap-2 text-xs">
          <span class="min-w-0 flex-1 truncate font-mono opacity-70">{{ id }}</span>
          <button
            type="button"
            class="shrink-0 rounded border border-current/20 px-1.5 py-0.5 font-semibold transition hover:opacity-80"
            @click="channel.unbanMember(id)"
          >
            {{ $t("chat.unban") }}
          </button>
        </div>
      </div>

      <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareTicket") }}</p>
      <OyaQrCode :value="room.ticket" :size="176" alt="Room QR code" />
      <p class="text-center text-[10px] opacity-50">{{ $t("chat.scanToJoin") }}</p>
      <OyaCopyField :value="room.ticket" mono :copy-label="$t('chat.copy')" />
      <!-- Ticketless-join room code (DHT rendezvous) — present when minted -->
      <template v-if="room.code">
        <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareCode") }}</p>
        <OyaCopyField :value="room.code" mono :copy-label="$t('chat.copy')" />
      </template>
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
