<script setup lang="ts">
// Cloud tab → Invites: the sealed server-mailbox invite flow (rdv.md), moved
// here from the Contacts view so every server interaction lives in one place.
//
// Two halves:
//  * Waiting for you — invites fetched from MY server mailbox, verified and
//    decrypted locally (Rust drops anything that fails verification); joining
//    stays an explicit press.
//  * Leave an invite — pick a saved contact, then a Tor room: the ticket is
//    HPKE-SEALED to the contact's NodeId and left in their mailbox. The server
//    brokers ciphertext it cannot open. Tor rooms only: iroh rooms are invited
//    directly from Contacts (the live handshake), which Tor mode can't carry.
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  OyaCard,
  OyaButton,
  listContacts,
  invoke,
  type ContactEntry,
  type P2pRoomEntry,
} from "rakotis";
import { useChatStore } from "../../stores/chat";
import { useCloudStore } from "../../stores/cloud";

defineProps<{ darkMode?: boolean }>();

const router = useRouter();
const chatStore = useChatStore();
const cloud = useCloudStore();

const contacts = ref<ContactEntry[]>([]);
const torRooms = computed<P2pRoomEntry[]>(() =>
  chatStore.p2p.p2pRooms.value.filter((r) => r.tor),
);

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

// ── Leave an invite: contact → Tor room → sealed drop ─────────────────────────
const inviteTargetId = ref("");
const inviteTarget = computed(
  () => contacts.value.find((c) => c.nodeId === inviteTargetId.value) ?? null,
);
const serverInviteState = ref<"idle" | "sending" | "sent" | "error">("idle");
const serverInviteError = ref("");

function pickTarget(nodeId: string) {
  inviteTargetId.value = nodeId;
  serverInviteState.value = "idle";
  serverInviteError.value = "";
}

async function sendServerInvite(room: P2pRoomEntry) {
  const target = inviteTarget.value;
  if (!target || serverInviteState.value === "sending") return;
  serverInviteState.value = "sending";
  serverInviteError.value = "";
  try {
    // Sending opens the room first — a live member must exist for MLS admission.
    await chatStore.p2p.openP2pRoom(room);
    const ticket = room.ticket ?? "";
    if (!ticket) throw new Error("This room has no shareable ticket yet.");
    await invoke("rdv_invite_send", {
      serverUrl: cloud.serverUrl,
      toNodeId: target.nodeId,
      roomName: room.name,
      ticket,
    });
    serverInviteState.value = "sent";
  } catch (e) {
    serverInviteState.value = "error";
    serverInviteError.value = typeof e === "string" ? e : ((e as Error).message ?? "");
  }
}

onMounted(async () => {
  contacts.value = await listContacts();
  await chatStore.p2p.loadP2pRooms();
  await cloud.init();
  if (cloud.enabled && cloud.loggedIn) {
    // Make this device addressable so peers can seal invites to it — works
    // even in Tor mode, where iroh (and the relay publisher) are down. This is
    // mailbox registration, NOT the relay-address publishing toggle (Settings).
    void invoke("rdv_register", { serverUrl: cloud.serverUrl }).catch(() => {});
    void refreshServerInvites();
  }
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
    <!-- Needs a session first -->
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

      <!-- Leave an invite -->
      <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-3" data-testid="leave-invite">
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('cloud.sendInviteTitle') }}
        </p>
        <p class="text-xs opacity-60">{{ $t('cloud.sendInviteHint') }}</p>

        <p v-if="contacts.length === 0" class="text-sm opacity-60">{{ $t('cloud.noContacts') }}</p>
        <template v-else>
          <select
            v-model="inviteTargetId"
            class="w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            data-testid="invite-contact-select"
            @change="pickTarget(inviteTargetId)"
          >
            <option value="" disabled>{{ $t('cloud.pickContact') }}</option>
            <option v-for="c in contacts" :key="c.nodeId" :value="c.nodeId">{{ c.name }}</option>
          </select>

          <template v-if="inviteTarget">
            <p v-if="torRooms.length === 0" class="text-sm opacity-60">{{ $t('cloud.noTorRooms') }}</p>
            <template v-else-if="serverInviteState === 'idle'">
              <ul class="divide-y divide-current/10">
                <li v-for="room in torRooms" :key="room.room">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 py-2.5 text-left text-sm transition hover:opacity-70"
                    :data-testid="`server-invite-${room.room}`"
                    @click="sendServerInvite(room)"
                  >
                    <font-awesome-icon icon="shield-halved" class="opacity-60" />
                    <span class="min-w-0 flex-1 truncate">{{ room.name }}</span>
                    <font-awesome-icon icon="chevron-right" class="text-xs opacity-40" />
                  </button>
                </li>
              </ul>
            </template>
            <p v-else-if="serverInviteState === 'sending'" class="flex items-center gap-2 text-sm opacity-70">
              <font-awesome-icon icon="spinner" spin /> {{ $t('cloud.inviteSending') }}
            </p>
            <p v-else-if="serverInviteState === 'sent'" class="flex items-center gap-2 text-sm font-semibold text-success-dark">
              <font-awesome-icon icon="check" />
              {{ $t('cloud.inviteLeftOnServer', { name: inviteTarget?.name ?? '' }) }}
            </p>
            <p v-else class="text-sm text-warn-dark">{{ serverInviteError }}</p>
          </template>
        </template>
      </OyaCard>
    </template>
  </div>
</template>
