<script setup lang="ts">
// Ask a contact for a peer link. The two checkbox groups are the whole point:
// `want` is what I ask them to share and `give` is what I offer, and neither
// implies the other — the grants are separate records in separate directions
// (peer.md P3). They may also grant less than I asked for, so the outcome here
// is "they answered", not "I got what I picked".
//
// Sending discloses nothing: the request frame carries a description only (who,
// which scopes, the safety number). The link key is minted after they accept.

import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { OyaButton, PEER_SCOPES, type PeerScope } from "rakotis";
import { useNetworkStore } from "../../stores/network";
import { usePeersStore } from "../../stores/peers";
import { scopeDescKey, scopeLabelKey, toggleScope } from "./peerScopes";

const props = defineProps<{ darkMode: boolean; nodeId: string; name: string }>();

const peers = usePeersStore();
const { outgoing, outgoingError } = storeToRefs(peers);

const want = ref<PeerScope[]>([]);
const give = ref<PeerScope[]>([]);
const localError = ref("");

// The handshake is a direct QUIC dial, so airplane and Tor-exclusive mode block
// it outright (the file_xfer/device_link precedent): disable with the reason,
// never hide the control.
const network = useNetworkStore();
const offline = computed(() => network.offline);
const torMode = computed(() => network.useTor);
const blocked = computed(() => offline.value || torMode.value);
const blockedReason = computed(() => (offline.value ? "peers.blockedOffline" : "peers.blockedTor"));

const alreadyLinked = computed(() => peers.isLinked(props.nodeId));
// The store surfaces the browser-fallback case as an i18n key rather than a
// message; anything else is a raw Rust error and is shown as-is.
const errorIsKey = computed(() => outgoingError.value === "peers.unavailable");

async function send() {
  if (blocked.value) return;
  if (want.value.length === 0 && give.value.length === 0) {
    localError.value = "peers.pickSomething";
    return;
  }
  localError.value = "";
  await peers.request(props.nodeId, want.value, give.value);
}

onMounted(async () => {
  peers.resetOutgoing();
  void peers.init();
  await network.refresh();
});
</script>

<template>
  <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
    <p class="flex items-center gap-2 text-lg font-bold">
      <font-awesome-icon icon="arrows-rotate" />
      {{ $t('peers.requestTitle', { name }) }}
    </p>

    <!-- Scope picker -->
    <template v-if="outgoing === 'idle'">
      <p class="text-sm opacity-65">{{ $t('peers.requestIntro') }}</p>
      <p v-if="alreadyLinked" class="text-xs text-warn-dark">{{ $t('peers.alreadyLinked', { name }) }}</p>

      <div class="space-y-2">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-70">
          {{ $t('peers.askFor', { name }) }}
        </p>
        <label v-for="s in PEER_SCOPES" :key="`w-${s}`" class="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            class="mt-1 h-4 w-4 shrink-0 accent-current"
            :checked="want.includes(s)"
            @change="want = toggleScope(want, s)"
          />
          <span class="min-w-0">
            <span class="block font-semibold">{{ $t(scopeLabelKey(s)) }}</span>
            <span class="block text-xs opacity-65">{{ $t(scopeDescKey(s)) }}</span>
          </span>
        </label>
      </div>

      <div class="space-y-2 border-t border-current/10 pt-3">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-70">
          {{ $t('peers.offer', { name }) }}
        </p>
        <p class="text-xs opacity-60">{{ $t('peers.offerHint') }}</p>
        <label v-for="s in PEER_SCOPES" :key="`g-${s}`" class="flex cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 accent-current"
            :checked="give.includes(s)"
            @change="give = toggleScope(give, s)"
          />
          <span class="font-semibold">{{ $t(scopeLabelKey(s)) }}</span>
        </label>
      </div>

      <p v-if="blocked" class="text-sm font-semibold text-amber-500">{{ $t(blockedReason) }}</p>
      <p v-if="localError" class="text-sm text-warn-dark">{{ $t(localError) }}</p>
      <OyaButton class="w-full justify-center" :disabled="blocked" @click="send">
        <font-awesome-icon icon="paper-plane" />{{ $t('peers.send') }}
      </OyaButton>
    </template>

    <!-- Waiting on their answer (the window is connect_timeout_secs) -->
    <div v-else-if="outgoing === 'waiting'" class="flex flex-col items-center gap-3 py-6 text-center">
      <font-awesome-icon icon="spinner" spin class="text-3xl text-accent-dark" />
      <p class="text-sm opacity-70">{{ $t('peers.waiting', { name }) }}</p>
    </div>

    <!-- Outcome -->
    <template v-else-if="outgoing === 'linked'">
      <p class="flex items-center gap-2 text-sm font-semibold text-success-dark">
        <font-awesome-icon icon="check" />{{ $t('peers.linkedOk', { name }) }}
      </p>
      <p class="text-xs opacity-60">{{ $t('peers.linkedHint') }}</p>
    </template>

    <p v-else-if="outgoing === 'declined'" class="flex items-center gap-2 text-sm text-warn-dark">
      <font-awesome-icon icon="xmark" />{{ $t('peers.declinedBy', { name }) }}
    </p>

    <div v-else-if="outgoing === 'error'" class="space-y-2">
      <p class="flex items-center gap-2 text-sm text-warn-dark">
        <font-awesome-icon icon="triangle-exclamation" />{{ $t('peers.failed', { name }) }}
      </p>
      <p v-if="errorIsKey" class="text-xs opacity-60">{{ $t('peers.unavailable') }}</p>
      <p v-else-if="outgoingError" class="text-xs opacity-60">{{ outgoingError }}</p>
      <OyaButton variant="secondary" class="w-full justify-center" @click="peers.resetOutgoing()">
        {{ $t('peers.retry') }}
      </OyaButton>
    </div>
  </div>
</template>
