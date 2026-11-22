<script setup lang="ts">
import { ref } from "vue";
import { OyaButton, OyaIconButton } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import { recoverHp } from "../hp/useHp";
import MlsStatusChip from "./MlsStatusChip.vue";
import ConnectionStatusChip from "./ConnectionStatusChip.vue";

const props = defineProps<{ channel: ChatChannel; compact?: boolean }>();
const ch = props.channel;
const { mlsStatus, mlsError, wsStatus, isEncrypted, isParticipant } = ch;

/** Privacy HP: a reset renegotiates the group's keys, so old key material no
 *  longer opens what comes next — a real reduction in risk being carried, and
 *  one of the few recoveries a user can trigger deliberately. Awarded once per
 *  rolling day; Rust applies the cap. */
async function resetEncryption(): Promise<void> {
  await ch.forceResetMls();
  await recoverHp("room.rekey");
}

const busy = ref(false);
async function join() {
  busy.value = true;
  try {
    await ch.joinParticipant();
  } finally {
    busy.value = false;
  }
}
async function leave() {
  busy.value = true;
  try {
    await ch.leaveParticipant();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <template v-if="isParticipant">
      <MlsStatusChip :status="mlsStatus" :error="mlsError" :encrypted="isEncrypted" :compact="compact" />
      <ConnectionStatusChip :status="wsStatus" :compact="compact" />
      <OyaIconButton
        icon="rotate-right"
        size="sm"
        :label="$t('chat.a11yResetEncryption')"
        :class="
          mlsStatus === 'key_exchange' || mlsStatus === 'error'
            ? 'border-highlight/40 bg-highlight/10 text-highlight'
            : 'opacity-60 hover:opacity-100'
        "
        @click="resetEncryption()"
      />
      <button
        v-if="compact"
        :class="{ 'opacity-60 pointer-events-none': busy }"
        class="ml-auto text-xs underline opacity-70 hover:opacity-100"
        @click="leave"
      >
        Leave
      </button>
      <OyaButton
        v-else
        variant="secondary"
        :class="{ 'opacity-60 pointer-events-none': busy }"
        class="inline-flex"
        @click="leave"
      >
        <font-awesome-icon icon="right-from-bracket" />Leave
      </OyaButton>
    </template>

    <OyaButton v-else :class="{ 'opacity-60 pointer-events-none': busy }" class="inline-flex" @click="join">
      <font-awesome-icon icon="right-to-bracket" />Join
    </OyaButton>
  </div>
</template>
