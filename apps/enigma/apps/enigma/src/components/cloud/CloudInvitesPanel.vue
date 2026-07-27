<script setup lang="ts">
// Cloud tab → Invites: leave a sealed room ticket on your own server, addressed
// to the faros accounts you pick (cloud.md).
//
// Two halves:
//  * Waiting for you — invites fetched from MY server mailbox, verified and
//    decrypted locally (Rust drops anything that fails verification); joining
//    stays an explicit press.
//  * Invite people to a room — pick usernames, then either CREATE a room (Tor
//    channel when the profile is in Tor mode, direct iroh room otherwise) or
//    pick one you already have. The ticket is HPKE-sealed per recipient device;
//    the server brokers ciphertext it cannot open.
//
// Picking is mandatory for both submits — there is no "open to all" affordance,
// and Rust rejects an empty recipient list too. What the picked list is NOT is
// enforcement: MLS auto-admits whoever holds the ticket, so the notices below
// say plainly that this decides who receives a copy, nothing more.
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  OyaCard,
  OyaButton,
  OyaBadge,
  listContacts,
  getUseTor,
  isTauri,
  invoke,
  type ContactEntry,
  type P2pRoomEntry,
} from "rakotis";
import { useChatStore } from "../../stores/chat";
import { useCloudStore } from "../../stores/cloud";
import { useRecipientPicker } from "./useRecipientPicker";
import CloudRecipientPicker from "./CloudRecipientPicker.vue";

defineProps<{ darkMode?: boolean }>();

const router = useRouter();
const { t } = useI18n({ useScope: "global" });
const chatStore = useChatStore();
const cloud = useCloudStore();

const contacts = ref<ContactEntry[]>([]);
const myNodeId = ref("");
const torMode = ref(false);

// ── Pending invites (collected, verified and decrypted locally) ───────────────
interface ServerInvite {
  id: number;
  from_node_id: string;
  room_name: string;
  ticket: string;
  expires_at: number;
}
const serverInvites = ref<ServerInvite[]>([]);
const serverInvitesBusy = ref(false);

/** Name a sender by their saved contact, else show the raw NodeId — an invite
 *  from an unknown key should look unknown. */
function inviteSenderName(nodeId: string): string {
  return contacts.value.find((c) => c.nodeId === nodeId)?.name ?? nodeId.slice(0, 12) + "…";
}

async function refreshServerInvites() {
  if (!cloud.enabled || !cloud.loggedIn || serverInvitesBusy.value) return;
  serverInvitesBusy.value = true;
  try {
    serverInvites.value = await invoke<ServerInvite[]>("rdv_invite_fetch", {
      serverUrl: cloud.serverUrl,
    });
  } catch {
    /* no server / logged out / offline — the ticket path is unaffected */
  } finally {
    serverInvitesBusy.value = false;
  }
}

async function acceptServerInvite(inv: ServerInvite) {
  await chatStore.p2p.joinByTicket(inv.ticket);
  await dismissServerInvite(inv);
  void router.push("/chat");
}

async function dismissServerInvite(inv: ServerInvite) {
  serverInvites.value = serverInvites.value.filter((i) => i.id !== inv.id);
  try {
    await invoke("rdv_invite_ack", { serverUrl: cloud.serverUrl, id: inv.id });
  } catch {
    /* it expires on the server anyway */
  }
}

// ── Leave an invite: pick usernames → create a room, or use an existing one ───
const picker = useRecipientPicker({
  serverUrl: () => cloud.serverUrl,
  myNodeId: () => myNodeId.value,
  canResolve: () => cloud.enabled && cloud.loggedIn,
});

/** Every saved room we can actually seal: a ticket is the whole payload, and
 *  the mailbox reaches an offline peer, so direct rooms belong here too. */
const invitableRooms = computed<P2pRoomEntry[]>(() =>
  chatStore.p2p.p2pRooms.value.filter((r) => !!r.ticket),
);

interface InviteReport {
  username: string;
  outcome: "ok" | "partial" | "unknown" | "self_only" | "quota" | "full" | "skipped" | "error";
  devices: number;
  delivered: number;
  error: string;
}

const newRoomName = ref("");
const pickedRoom = ref("");
const busy = ref(false);
const sendError = ref("");
const results = ref<InviteReport[]>([]);
const createdRoomName = ref("");

const okCount = computed(() => results.value.filter((r) => r.outcome === "ok").length);
/** Retry targets: only people where NOTHING landed. A `partial` already has a
 *  working invite on at least one device — re-sending would post a second copy
 *  to the device that succeeded (the report carries counts, not which NodeIds),
 *  burning two mailbox slots to fix nothing. */
const failedUsernames = computed(() =>
  results.value.filter((r) => r.delivered === 0 && r.outcome !== "ok").map((r) => r.username),
);

const OUTCOME_KEY: Record<InviteReport["outcome"], string> = {
  ok: "cloud.outcomeOk",
  partial: "cloud.outcomePartial",
  unknown: "cloud.outcomeUnknown",
  self_only: "cloud.outcomeSelfOnly",
  quota: "cloud.outcomeQuota",
  full: "cloud.outcomeFull",
  skipped: "cloud.outcomeSkipped",
  error: "cloud.outcomeError",
};

async function fanOut(roomName: string, ticket: string) {
  try {
    results.value = await invoke<InviteReport[]>("rdv_invite_broadcast", {
      serverUrl: cloud.serverUrl,
      usernames: picker.ready.value.map((r) => r.username),
      roomName,
      ticket,
      // ttlSeconds omitted on purpose — Rust's default is faros' own 24 h cap.
    });
  } catch (e) {
    sendError.value = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
  }
}

async function createAndInvite() {
  const name = newRoomName.value.trim();
  if (!name || !picker.canSend.value || busy.value) return;
  busy.value = true;
  results.value = [];
  sendError.value = "";
  createdRoomName.value = "";
  try {
    // createRoom also enters the room and makes us host, so the live member MLS
    // admission needs already exists by the time the seals go out.
    const ticket = await chatStore.p2p.createRoom(name);
    if (!ticket) {
      sendError.value = chatStore.p2p.error?.value || t("cloud.roomCreateFailed");
      return;
    }
    createdRoomName.value = name;
    newRoomName.value = "";
    await fanOut(name, ticket);
  } finally {
    busy.value = false;
  }
}

async function inviteToExisting() {
  const room = invitableRooms.value.find((r) => r.room === pickedRoom.value);
  if (!room?.ticket || !picker.canSend.value || busy.value) return;
  busy.value = true;
  results.value = [];
  sendError.value = "";
  createdRoomName.value = "";
  try {
    await chatStore.p2p.openP2pRoom(room); // no-op when already current
    await fanOut(room.name, room.ticket);
  } finally {
    busy.value = false;
  }
}

/** Re-send only to the people who received nothing at all — see
 *  `failedUsernames` for why a partial delivery is deliberately left alone. */
function retryFailed() {
  picker.keepOnly(failedUsernames.value);
  results.value = [];
  createdRoomName.value = "";
}

async function registerAndFetch() {
  if (!cloud.enabled || !cloud.loggedIn) return;
  try {
    // Registration is what makes this device addressable; it also hands back
    // our NodeId, which works with iroh torn down (unlike ensureNode()).
    myNodeId.value = await invoke<string>("rdv_register", { serverUrl: cloud.serverUrl });
  } catch {
    /* not an aster server — the panel still shows what it has */
  }
  void refreshServerInvites();
}

onMounted(async () => {
  contacts.value = await listContacts();
  await chatStore.p2p.loadP2pRooms();
  if (isTauri()) torMode.value = await getUseTor();
  await cloud.init();
  void registerAndFetch();
});

// Signing in after the panel mounted used to leave it empty until a manual
// refresh — pick the session up as soon as it lands.
watch(() => cloud.loggedIn, (on) => { if (on) void registerAndFetch(); });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
    <OyaCard v-if="!cloud.loggedIn" :dark-mode="darkMode" :padded="true">
      <p class="text-sm opacity-70">{{ $t('cloud.needsLogin') }}</p>
    </OyaCard>

    <template v-else>
      <!-- Waiting for you -->
      <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-3" data-testid="server-invites">
        <div class="flex items-center gap-2">
          <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide">
            {{ $t('cloud.pendingInvites') }}
          </p>
          <button
            type="button"
            class="opacity-60 transition hover:opacity-100"
            :title="$t('cloud.checkInvites')"
            data-testid="server-invites-refresh"
            @click="refreshServerInvites"
          >
            <font-awesome-icon :icon="serverInvitesBusy ? 'spinner' : 'rotate-right'" :spin="serverInvitesBusy" />
          </button>
        </div>
        <p v-if="serverInvites.length === 0" class="text-sm opacity-60">{{ $t('cloud.noInvites') }}</p>
        <div v-for="inv in serverInvites" :key="inv.id" class="space-y-2 border-t border-current/10 pt-3 first:border-0 first:pt-0">
          <p class="text-sm">
            {{ $t('contacts.incomingBody', { name: inviteSenderName(inv.from_node_id), room: inv.room_name }) }}
          </p>
          <p class="truncate font-mono text-[11px] opacity-50">{{ inv.from_node_id }}</p>
          <div class="flex gap-2">
            <OyaButton :dark-mode="darkMode" class="flex-1 justify-center" :data-testid="`server-invite-accept-${inv.id}`" @click="acceptServerInvite(inv)">
              <font-awesome-icon icon="check" />{{ $t('contacts.accept') }}
            </OyaButton>
            <OyaButton :dark-mode="darkMode" variant="secondary" class="flex-1 justify-center" @click="dismissServerInvite(inv)">
              {{ $t('contacts.decline') }}
            </OyaButton>
          </div>
        </div>
      </OyaCard>

      <!-- Invite people to a room -->
      <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4" data-testid="leave-invite">
        <div>
          <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
            {{ $t('cloud.sendInviteTitle') }}
          </p>
          <p class="mt-1 text-xs opacity-60">{{ $t('cloud.sendInviteHint') }}</p>
        </div>

        <CloudRecipientPicker :picker="picker" :dark-mode="darkMode" />

        <!-- New room -->
        <div class="space-y-2 border-t border-current/10 pt-3">
          <p class="text-xs font-semibold uppercase tracking-wide opacity-70">{{ $t('cloud.newRoomTitle') }}</p>
          <div class="flex items-center gap-2">
            <input
              v-model="newRoomName"
              type="text"
              :placeholder="$t('cloud.newRoomName')"
              class="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-sm"
              :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
              data-testid="invite-create-name"
              @keyup.enter="createAndInvite"
            />
            <OyaButton
              :dark-mode="darkMode"
              :class="{ 'pointer-events-none opacity-50': !picker.canSend.value || !newRoomName.trim() || busy }"
              data-testid="invite-create-submit"
              @click="createAndInvite"
            >
              <font-awesome-icon :icon="busy ? 'spinner' : 'plus'" :spin="busy" />
              {{ $t('cloud.createAndInvite') }}
            </OyaButton>
          </div>
          <p class="text-xs opacity-50">
            {{ torMode ? $t('cloud.newRoomTorHint') : $t('cloud.newRoomDirectHint') }}
          </p>
        </div>

        <!-- Existing room -->
        <div class="space-y-2 border-t border-current/10 pt-3">
          <p class="text-xs font-semibold uppercase tracking-wide opacity-70">{{ $t('cloud.existingRoomTitle') }}</p>
          <p v-if="invitableRooms.length === 0" class="text-sm opacity-60">{{ $t('cloud.noInvitableRooms') }}</p>
          <div v-else class="flex items-center gap-2">
            <select
              v-model="pickedRoom"
              class="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-sm"
              :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
              data-testid="invite-room-select"
            >
              <option value="" disabled>{{ $t('cloud.pickRoom') }}</option>
              <option v-for="room in invitableRooms" :key="room.room" :value="room.room">
                {{ room.name }} · {{ room.tor ? $t('cloud.roomTagTor') : $t('cloud.roomTagDirect') }}
              </option>
            </select>
            <OyaButton
              :dark-mode="darkMode"
              variant="secondary"
              :class="{ 'pointer-events-none opacity-50': !picker.canSend.value || !pickedRoom || busy }"
              data-testid="invite-existing-submit"
              @click="inviteToExisting"
            >
              <font-awesome-icon :icon="busy ? 'spinner' : 'paper-plane'" :spin="busy" />
              {{ $t('cloud.leaveInvite') }}
            </OyaButton>
          </div>
        </div>

        <!-- Honesty: what the picked list does and does not mean -->
        <div class="space-y-2 border-t border-current/10 pt-3">
          <p class="text-xs opacity-60">{{ $t('cloud.inviteExpiry') }}</p>
          <div
            class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark"
            data-testid="invite-bearer-notice"
          >
            {{ $t('cloud.inviteBearerNotice') }}
          </div>
          <p
            v-if="picker.recipients.value.length"
            class="text-xs opacity-60"
            data-testid="invite-username-notice"
          >
            {{ $t('cloud.inviteUsernameNotice') }}
          </p>
        </div>

        <p v-if="sendError" class="text-sm text-warn-dark">{{ sendError }}</p>
        <!-- Outside the results block on purpose: when the broadcast itself
             fails there are no results, and "the room still exists" is exactly
             what the user needs to read on that screen. -->
        <p v-if="createdRoomName" class="text-xs opacity-60" data-testid="invite-room-created">
          {{ $t('cloud.inviteRoomCreated', { room: createdRoomName }) }}
        </p>

        <!-- Results -->
        <div v-if="results.length" class="space-y-2 border-t border-current/10 pt-3" data-testid="invite-results">
          <p class="text-sm font-semibold">
            {{ okCount === results.length
              ? $t('cloud.inviteAllSent')
              : okCount === 0
                ? $t('cloud.inviteNoneSent')
                : $t('cloud.inviteSomeSent', { ok: okCount, total: results.length }) }}
          </p>
          <div
            v-for="r in results"
            :key="r.username"
            class="flex items-start gap-2 text-xs"
            :data-testid="`invite-result-${r.username}`"
          >
            <OyaBadge :tone="r.outcome === 'ok' ? 'neutral' : 'warn'" :icon="r.outcome === 'ok' ? 'check' : 'triangle-exclamation'">
              {{ r.username }}
            </OyaBadge>
            <span class="min-w-0 flex-1 opacity-70">
              {{ $t(OUTCOME_KEY[r.outcome], { delivered: r.delivered, devices: r.devices, error: r.error }) }}
            </span>
          </div>
          <OyaButton
            v-if="failedUsernames.length"
            :dark-mode="darkMode"
            variant="secondary"
            data-testid="invite-retry-failed"
            @click="retryFailed"
          >
            <font-awesome-icon icon="rotate-right" />{{ $t('cloud.inviteRetryFailed') }}
          </OyaButton>
        </div>
      </OyaCard>
    </template>
  </div>
</template>
