<script setup lang="ts">
// The consent gate for an incoming peer link (peer.md P3/P7). It lives at the
// app root, not in a tab: the request arrives on the main endpoint whatever the
// user is looking at, and the answer window is only connect_timeout_secs — a
// prompt hidden behind a route would simply lapse.
//
// Two things the copy must not soften. The accepter grants what IT ticks, never
// what was asked for (so every wanted scope is an individual checkbox, and
// accepting with everything unticked is a legal answer). And a tick is a
// standing subscription — data keeps flowing until the link is revoked.

import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import {
  OyaButton, OyaCard, OyaModal,
  formatSafetyNumber, type PeerScope,
} from "rakotis";
import { usePeersStore } from "../../stores/peers";
import { orderScopes, scopeDescKey, scopeLabelKey, toggleScope } from "./peerScopes";

defineProps<{ darkMode: boolean }>();

const peers = usePeersStore();
const { incoming } = storeToRefs(peers);

// Default to everything they asked for; the user unticks to grant less.
const ticked = ref<PeerScope[]>([]);
watch(incoming, (req) => { ticked.value = req ? orderScopes(req.want) : []; }, { immediate: true });

const wanted = computed(() => orderScopes(incoming.value?.want ?? []));
const offered = computed(() => orderScopes(incoming.value?.offered ?? []));

function shortNode(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

// Mounted app-wide, so this is also where the listeners come up: without it the
// `plink://request` event has nowhere to land.
onMounted(() => { void peers.init(); });
</script>

<template>
  <OyaModal :open="!!incoming" @close="peers.respond(false, [])">
    <OyaCard v-if="incoming" :padded="true" class="max-h-[85dvh] overflow-y-auto w-full max-w-md space-y-4 text-sm">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ $t('peers.incomingTitle') }}
        </p>
        <p class="mt-1 font-semibold">
          {{ $t('peers.incomingBody', { name: incoming.fromName || shortNode(incoming.fromNodeId) }) }}
        </p>
        <p class="truncate font-mono text-[11px] opacity-50">{{ incoming.fromNodeId }}</p>
      </div>

      <!-- Safety number: the app's only identity check, shown but never enforced -->
      <div class="rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-70">
          {{ $t('peers.safetyNumber') }}
        </p>
        <p class="mt-1 font-mono text-base tracking-widest">
          {{ formatSafetyNumber(incoming.safetyNumber) }}
        </p>
        <p class="mt-1 text-xs opacity-65">
          {{ $t('peers.safetyHint', { name: incoming.fromName || shortNode(incoming.fromNodeId) }) }}
        </p>
      </div>

      <!-- What they are asking ME to share — one tick box each -->
      <div class="space-y-2">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-70">{{ $t('peers.wants') }}</p>
        <p v-if="wanted.length === 0" class="text-xs opacity-65">{{ $t('peers.wantsNothing') }}</p>
        <label
          v-for="s in wanted"
          :key="s"
          class="flex cursor-pointer items-start gap-3 rounded-lg border border-accent-2 px-3 py-2 dark:border-accent-1"
        >
          <input
            type="checkbox"
            class="mt-0.5 h-4 w-4 shrink-0 accent-current"
            :checked="ticked.includes(s)"
            @change="ticked = toggleScope(ticked, s)"
          />
          <span class="min-w-0">
            <span class="block font-semibold">{{ $t(scopeLabelKey(s)) }}</span>
            <span class="block text-xs opacity-65">{{ $t(scopeDescKey(s)) }}</span>
          </span>
        </label>
        <p class="text-xs font-semibold text-warn-dark">{{ $t('peers.continuous') }}</p>
      </div>

      <!-- What they offer back — read-only: their grant is theirs to set -->
      <div class="space-y-1">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-70">{{ $t('peers.offers') }}</p>
        <p v-if="offered.length === 0" class="text-xs opacity-65">{{ $t('peers.offersNothing') }}</p>
        <div v-else class="flex flex-wrap gap-1.5">
          <span
            v-for="s in offered"
            :key="s"
            class="rounded-full border border-current/20 px-2 py-0.5 text-xs"
          >{{ $t(scopeLabelKey(s)) }}</span>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <OyaButton variant="secondary" @click="peers.respond(false, [])">
          <font-awesome-icon icon="xmark" />{{ $t('peers.decline') }}
        </OyaButton>
        <OyaButton @click="peers.respond(true, ticked)">
          <font-awesome-icon icon="check" />
          {{ ticked.length ? $t('peers.accept') : $t('peers.acceptNothing') }}
        </OyaButton>
      </div>
    </OyaCard>
  </OyaModal>
</template>
