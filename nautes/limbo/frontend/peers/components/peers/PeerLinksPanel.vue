<script setup lang="ts">
// Peer links — the management surface for scoped person-to-person sync
// (peer.md). The whole panel is built around the two directions being separate
// records: what I share is mine to widen or narrow whenever I like, what they
// share is theirs and is shown read-only.
//
// Revoked links stay visible (greyed) rather than vanishing, because the
// tombstone is the thing that keeps admission refused — and because the revoke
// confirm makes a promise the UI must not walk back: future sync stops, the
// copy already on their disk is theirs forever (P6).

import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import {
  OyaButton, OyaCard, OyaModal,
  PEER_SCOPES, formatSafetyNumber, getBuildConfig, type PeerGrant, type PeerScope,
} from "rakotis";
import { usePeersStore } from "../../stores/peers";
import { orderScopes, scopeDescKey, scopeLabelKey, toggleScope } from "./peerScopes";
import PeerBoardPanel from "./PeerBoardPanel.vue";

defineProps<{ darkMode: boolean }>();

const peers = usePeersStore();
const { grants, liveGrants, lastSyncAt } = storeToRefs(peers);

const revokedGrants = computed(() => grants.value.filter((g) => g.revokedAt));

/** Which link's scope editor is open — collapsed by default so the panel reads
 *  as a status list first and a control surface second. */
const editing = ref("");
const revokeTarget = ref<PeerGrant | null>(null);
/** Which link's board is open. The board belongs to the LINK (peer.md P8), so
 *  this is the only place it can be reached from — there is no room to host it. */
const boardTarget = ref<PeerGrant | null>(null);

const peersEnabled = getBuildConfig().peers_enabled;

/** A board surface is worth offering when either direction carries the scope:
 *  they send it, or I do. With neither, the board would be a purely local doc
 *  behind a peer-sync link, which is not what this panel is for. */
function hasBoardScope(g: PeerGrant): boolean {
  return g.myScopes.includes("board") || g.theirScopes.includes("board");
}

async function toggleMyScope(g: PeerGrant, scope: PeerScope) {
  await peers.setMyScopes(g.peerNodeId, toggleScope(g.myScopes, scope));
}

async function confirmRevoke() {
  const g = revokeTarget.value;
  revokeTarget.value = null;
  if (g) await peers.revoke(g.peerNodeId);
}

function shortNode(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

function fmtWhen(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

onMounted(() => { void peers.init(); });
</script>

<template>
  <OyaCard :padded="true" class="space-y-4">
    <div>
      <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
        {{ $t('peers.linksTitle') }}
      </p>
      <p class="mt-1 text-sm opacity-65">{{ $t('peers.linksHint') }}</p>
    </div>

    <p v-if="liveGrants.length === 0" class="py-4 text-center text-sm opacity-60">
      {{ $t('peers.empty') }}
    </p>

    <ul v-else class="space-y-3">
      <li
        v-for="g in liveGrants"
        :key="g.peerNodeId"
        class="space-y-2 rounded-lg border border-accent-2 px-3 py-3 dark:border-accent-1"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold">
              <font-awesome-icon icon="arrows-rotate" class="mr-2 opacity-70" />
              {{ g.peerName || shortNode(g.peerNodeId) }}
            </p>
            <p class="truncate font-mono text-[11px] opacity-50">{{ g.peerNodeId }}</p>
            <p class="text-[11px] opacity-50">{{ $t('peers.linkedSince', { date: fmtWhen(g.createdAt) }) }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <OyaButton
              v-if="peersEnabled && hasBoardScope(g)"
              variant="secondary"
              @click="boardTarget = g"
            >
              <font-awesome-icon icon="table-columns" />{{ $t('peers.boardOpen') }}
            </OyaButton>
            <OyaButton variant="secondary" @click="revokeTarget = g">
              <font-awesome-icon icon="link-slash" />{{ $t('peers.revoke') }}
            </OyaButton>
          </div>
        </div>

        <!-- Per-direction summary: mine on top because it's the one I control -->
        <div class="space-y-1 text-xs">
          <p class="flex flex-wrap items-center gap-1.5">
            <span class="font-semibold opacity-70">{{ $t('peers.youShare') }}:</span>
            <span v-if="g.myScopes.length === 0" class="opacity-60">{{ $t('peers.nothing') }}</span>
            <span
              v-for="s in orderScopes(g.myScopes)"
              :key="s"
              class="rounded-full border border-current/20 px-2 py-0.5"
            >{{ $t(scopeLabelKey(s)) }}</span>
          </p>
          <p class="flex flex-wrap items-center gap-1.5">
            <span class="font-semibold opacity-70">{{ $t('peers.theyShare') }}:</span>
            <span v-if="g.theirScopes.length === 0" class="opacity-60">{{ $t('peers.nothing') }}</span>
            <span
              v-for="s in orderScopes(g.theirScopes)"
              :key="s"
              class="rounded-full border border-current/20 px-2 py-0.5"
            >{{ $t(scopeLabelKey(s)) }}</span>
          </p>
        </div>

        <p class="text-xs opacity-70">
          {{ $t('peers.safetyNumber') }}:
          <span class="font-mono tracking-widest">{{ formatSafetyNumber(g.safetyNumber) }}</span>
        </p>

        <button
          type="button"
          class="text-xs font-semibold underline opacity-70 transition hover:opacity-100"
          @click="editing = editing === g.peerNodeId ? '' : g.peerNodeId"
        >
          {{ $t('peers.changeScopes') }}
        </button>

        <div v-if="editing === g.peerNodeId" class="space-y-2 border-t border-current/10 pt-2">
          <label
            v-for="s in PEER_SCOPES"
            :key="s"
            class="flex cursor-pointer items-start gap-3 text-xs"
          >
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 shrink-0 accent-current"
              :checked="g.myScopes.includes(s)"
              @change="toggleMyScope(g, s)"
            />
            <span class="min-w-0">
              <span class="block font-semibold">{{ $t(scopeLabelKey(s)) }}</span>
              <span class="block opacity-65">{{ $t(scopeDescKey(s)) }}</span>
            </span>
          </label>
          <p class="text-xs opacity-60">{{ $t('peers.changeScopesHint') }}</p>
        </div>
      </li>
    </ul>

    <p v-if="liveGrants.length" class="text-xs opacity-60">
      {{ $t('peers.lastSync') }}:
      {{ lastSyncAt ? fmtWhen(lastSyncAt) : $t('peers.never') }}
    </p>

    <!-- Tombstones: still listed, because the link can never be resumed -->
    <div v-if="revokedGrants.length" class="space-y-2 border-t border-current/10 pt-3">
      <p class="text-xs font-semibold uppercase tracking-wide opacity-50">{{ $t('peers.revokedTitle') }}</p>
      <ul class="space-y-1">
        <li
          v-for="g in revokedGrants"
          :key="g.peerNodeId"
          class="flex items-center gap-2 text-xs opacity-40"
        >
          <font-awesome-icon icon="link-slash" />
          <span class="min-w-0 flex-1 truncate">{{ g.peerName || shortNode(g.peerNodeId) }}</span>
          <span>{{ $t('peers.revokedAt', { date: fmtWhen(g.revokedAt ?? 0) }) }}</span>
        </li>
      </ul>
    </div>

    <!-- The per-link board (peer.md P8): no room slug, no captain, both edit -->
    <OyaModal :open="!!boardTarget" @close="boardTarget = null">
      <PeerBoardPanel
        v-if="boardTarget"
        :grant="boardTarget"
        :dark-mode="darkMode"
        @close="boardTarget = null"
      />
    </OyaModal>

    <!-- Revoke confirm — says exactly what revoking can and cannot do -->
    <OyaModal :open="!!revokeTarget" @close="revokeTarget = null">
      <OyaCard v-if="revokeTarget" :padded="true" class="max-h-[85dvh] overflow-y-auto w-full max-w-md space-y-3 text-sm">
        <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
          {{ $t('peers.revokeTitle', { name: revokeTarget.peerName || shortNode(revokeTarget.peerNodeId) }) }}
        </p>
        <p>{{ $t('peers.revokeStops') }}</p>
        <p class="font-semibold text-warn-dark">{{ $t('peers.revokeKeeps') }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="revokeTarget = null">
            {{ $t('peers.cancel') }}
          </OyaButton>
          <OyaButton @click="confirmRevoke">
            <font-awesome-icon icon="link-slash" />{{ $t('peers.revokeConfirm') }}
          </OyaButton>
        </div>
      </OyaCard>
    </OyaModal>
  </OyaCard>
</template>
