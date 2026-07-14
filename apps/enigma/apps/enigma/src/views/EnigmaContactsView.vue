<script setup lang="ts">
// Contacts — saved peers (stable iroh NodeIds), DHT presence, and DIRECT room
// invites: pick a contact, pick a room, and the contact gets an Accept/Decline
// prompt (file-transfer-style handshake over a dedicated iroh ALPN — see Rust
// p2p_invite.rs). On accept they join through the exact path a scanned QR
// takes, MLS admission included. The passive share-a-code flow lives in the
// chat tab (create/info modals); here inviting is person-first.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  OyaCard,
  OyaButton,
  OyaModal,
  OyaTextField,
  OyaQrCode,
  OyaCopyField,
  listContacts,
  upsertContact,
  renameContact,
  removeContact,
  touchContact,
  dhtPresence,
  dhtFindNick,
  getDhtDiscovery,
  getDhtPresencePollSecs,
  getDhtNickPublish,
  setDhtNickPublish,
  getDhtNickname,
  setDhtNickname,
  DHT_NICKNAME_MAX_LEN,
  invoke,
  type ContactEntry,
  type P2pRoomEntry,
  type NickClaim,
} from "rakotis";
import { useChatStore } from "../stores/chat";

defineProps<{ darkMode: boolean }>();

const router = useRouter();
const chatStore = useChatStore();
const invites = chatStore.invites;

// ── My code (this device's stable NodeId — what a contact saves about ME) ─────
const myNodeId = ref("");
const myNodeLoading = ref(false);
async function loadMyNodeId() {
  myNodeLoading.value = true;
  try {
    myNodeId.value = (await chatStore.p2p.ensureNode()) ?? "";
  } finally {
    myNodeLoading.value = false;
  }
}

// ── Contact list + presence ────────────────────────────────────────────────────
const contacts = ref<ContactEntry[]>([]);
const dhtOn = ref(false);
const online = ref<Record<string, boolean>>({});

async function refreshPresence() {
  if (!dhtOn.value || contacts.value.length === 0) return;
  const seen = await dhtPresence(contacts.value.map((c) => c.nodeId));
  const now = Date.now();
  const map: Record<string, boolean> = {};
  for (const p of seen) {
    map[p.node_id] = p.online;
    if (p.online) void touchContact(p.node_id, now);
  }
  online.value = map;
}

let presenceTimer: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  contacts.value = await listContacts();
  dhtOn.value = await getDhtDiscovery();
  nickPublish.value = await getDhtNickPublish();
  nickname.value = await getDhtNickname();
  void loadMyNodeId();
  await chatStore.p2p.loadP2pRooms();
  if (dhtOn.value) {
    void refreshPresence();
    // Frontend-driven poll: suspends with the webview (battery-safe on Android).
    presenceTimer = setInterval(refreshPresence, 1000 * (await getDhtPresencePollSecs()));
  }
});
onUnmounted(() => {
  if (presenceTimer !== null) clearInterval(presenceTimer);
});

function lastSeenLabel(c: ContactEntry): string {
  return c.lastSeen ? new Date(c.lastSeen).toLocaleString() : "";
}

// ── My nickname (opt-in "findable as ‹nick›" claim on the DHT directory) ──────
const nickPublish = ref(false);
const nickname = ref("");
const nickSaved = ref(false);
async function saveNickSettings() {
  nickname.value = await setDhtNickname(nickname.value);
  await setDhtNickPublish(nickPublish.value && !!nickname.value);
  nickPublish.value = nickPublish.value && !!nickname.value;
  // Rebind the node so the claim publishes (or stops) immediately instead of
  // waiting for the next announce round — same UX as the DHT toggle.
  await invoke("dht_apply").catch(() => {});
  nickSaved.value = true;
  setTimeout(() => { nickSaved.value = false; }, 1500);
}
async function toggleNickPublish() {
  nickPublish.value = !nickPublish.value;
  await saveNickSettings();
}

// ── Find people (nickname search — results are CLAIMS, not identities) ────────
const searchNick = ref("");
const searching = ref(false);
const searched = ref(false); // a search completed → "no results" is meaningful
const searchResults = ref<NickClaim[]>([]);
async function findPeople() {
  const nick = searchNick.value.trim();
  if (!nick || searching.value || !dhtOn.value) return;
  searching.value = true;
  searched.value = false;
  try {
    searchResults.value = await dhtFindNick(nick);
    searched.value = true;
  } finally {
    searching.value = false;
  }
}
const contactIds = computed(() => new Set(contacts.value.map((c) => c.nodeId)));
async function addFromSearch(claim: NickClaim) {
  contacts.value = await upsertContact({
    nodeId: claim.node_id,
    name: claim.name || claim.node_id.slice(0, 8),
    addedAt: Date.now(),
  });
  void refreshPresence();
}

// ── Add contact ────────────────────────────────────────────────────────────────
const addOpen = ref(false);
const addNodeId = ref("");
const addName = ref("");
const addError = ref(""); // i18n key
const scanError = ref(""); // i18n key

// Soft check only (Rust parsing is authoritative when the id is used): iroh
// NodeIds render as 64-char hex; the parser also accepts 52-char z-base-32.
function looksLikeNodeId(s: string): boolean {
  return /^[0-9a-z]{52,64}$/.test(s.trim().toLowerCase());
}

function openAdd() {
  addNodeId.value = "";
  addName.value = "";
  addError.value = "";
  scanError.value = "";
  addOpen.value = true;
}

async function submitAdd() {
  const nodeId = addNodeId.value.trim().toLowerCase();
  const name = addName.value.trim();
  if (!looksLikeNodeId(nodeId)) {
    addError.value = "contacts.invalidNodeId";
    return;
  }
  if (nodeId === myNodeId.value) {
    addError.value = "contacts.cantAddSelf";
    return;
  }
  contacts.value = await upsertContact({ nodeId, name: name || nodeId.slice(0, 8), addedAt: Date.now() });
  addOpen.value = false;
  void refreshPresence();
}

// Add by decoding a QR image file (off-screen region below).
async function scanFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  scanError.value = "";
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    const reader = new Html5Qrcode("contacts-qr-file-region");
    const decoded: string = await reader.scanFile(file, false);
    try {
      await reader.clear();
    } catch {
      /* ignore */
    }
    addNodeId.value = decoded.trim();
  } catch {
    scanError.value = "chat.qrNotFound";
  }
}

// ── Rename / delete ────────────────────────────────────────────────────────────
const editOpen = ref(false);
const editTarget = ref<ContactEntry | null>(null);
const editName = ref("");
function openEdit(c: ContactEntry) {
  editTarget.value = c;
  editName.value = c.name;
  editOpen.value = true;
}
async function submitEdit() {
  const target = editTarget.value;
  const name = editName.value.trim();
  if (!target || !name) return;
  contacts.value = await renameContact(target.nodeId, name);
  editOpen.value = false;
}
async function deleteContact(c: ContactEntry) {
  contacts.value = await removeContact(c.nodeId);
}

// ── Direct room invite (offer → the contact must accept) ──────────────────────
const inviteOpen = ref(false);
const inviteTarget = ref<ContactEntry | null>(null);
// Tor rooms can't be invite-shared (different transport); offer the iroh ones.
const invitableRooms = computed<P2pRoomEntry[]>(() =>
  chatStore.p2p.p2pRooms.value.filter((r) => !r.tor),
);

function openInviteFor(contact: ContactEntry) {
  inviteTarget.value = contact;
  invites.resetOutgoing();
  inviteOpen.value = true;
}

function closeInvite() {
  inviteOpen.value = false;
  invites.resetOutgoing();
}

async function pickInviteRoom(room: P2pRoomEntry) {
  const target = inviteTarget.value;
  if (!target) return;
  await invites.sendInvite(target.nodeId, room);
}

// ── Incoming invite (Accept / Decline) ─────────────────────────────────────────
const incomingFromName = computed(() => {
  const invite = invites.incoming.value;
  if (!invite) return "";
  const known = contacts.value.find((c) => c.nodeId === invite.fromNodeId);
  return known?.name ?? `${invite.fromNodeId.slice(0, 10)}…`;
});

async function acceptIncoming() {
  await invites.accept();
  // The join entered the room — take the user to it.
  void router.push("/chat");
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">

    <!-- Header -->
    <header>
      <h1 class="flex items-center gap-3 text-3xl font-bold">
        <font-awesome-icon icon="address-book" />
        {{ $t('contacts.title') }}
      </h1>
      <p class="mt-2 text-sm opacity-70">{{ $t('contacts.subtitle') }}</p>
    </header>

    <!-- Incoming invite — file-share-style: nothing happens until Accept -->
    <OyaCard v-if="invites.incoming.value" :dark-mode="darkMode" :padded="true" class="space-y-3">
      <p class="flex items-center gap-2 text-sm font-semibold">
        <span class="h-2 w-2 animate-pulse rounded-full bg-warn-dark" />
        {{ $t('contacts.incomingTitle') }}
      </p>
      <p class="text-sm">
        {{ $t('contacts.incomingBody', { name: incomingFromName, room: invites.incoming.value.roomName }) }}
      </p>
      <p class="truncate font-mono text-[11px] opacity-50">{{ invites.incoming.value.fromNodeId }}</p>
      <div class="flex gap-2">
        <OyaButton :dark-mode="darkMode" class="flex-1 justify-center" @click="acceptIncoming">
          <font-awesome-icon icon="check" />{{ $t('contacts.accept') }}
        </OyaButton>
        <OyaButton :dark-mode="darkMode" variant="secondary" class="flex-1 justify-center" @click="invites.decline">
          <font-awesome-icon icon="xmark" />{{ $t('contacts.decline') }}
        </OyaButton>
      </div>
    </OyaCard>

    <!-- My code — share it once; the peer saves it as a contact -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('contacts.myCode') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('contacts.myCodeHint') }}</p>
      </div>
      <div v-if="myNodeId" class="space-y-3">
        <OyaQrCode :value="myNodeId" :size="176" alt="My contact QR code" />
        <OyaCopyField :value="myNodeId" mono :copy-label="$t('chat.copy')" />
      </div>
      <p v-else-if="myNodeLoading" class="text-sm opacity-60">…</p>
      <OyaButton v-else :dark-mode="darkMode" variant="secondary" @click="loadMyNodeId">
        <font-awesome-icon icon="circle-nodes" />{{ $t('config.showNodeId') }}
      </OyaButton>

      <!-- Findable by nickname: an opt-in claim on the DHT directory -->
      <div class="space-y-3 border-t border-current/10 pt-4">
        <div class="flex items-center gap-3">
          <font-awesome-icon
            icon="magnifying-glass"
            :class="nickPublish ? 'text-accent-dark' : 'opacity-60'"
            class="shrink-0"
          />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold">{{ $t('contacts.nickPublish') }}</p>
            <p class="text-xs opacity-60">
              {{ dhtOn ? $t('contacts.nickPublishHint') : $t('contacts.findNeedsDht') }}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="nickPublish"
            :aria-label="$t('contacts.nickPublish')"
            :class="[
              nickPublish ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2',
              !dhtOn ? 'pointer-events-none opacity-50' : '',
            ]"
            class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
            @click="toggleNickPublish"
          >
            <span
              :class="nickPublish ? 'translate-x-6' : 'translate-x-1'"
              class="inline-block h-4 w-4 transform rounded-full bg-white transition"
            />
          </button>
        </div>
        <div v-if="dhtOn" class="flex items-center gap-2">
          <input
            v-model="nickname"
            type="text"
            :maxlength="DHT_NICKNAME_MAX_LEN"
            :placeholder="$t('contacts.nickPlaceholder')"
            class="min-w-0 flex-1 rounded-lg border border-current/15 bg-transparent px-3 py-1.5 text-sm"
            @change="saveNickSettings"
            @keyup.enter="saveNickSettings"
          />
          <span v-if="nickSaved" class="shrink-0 text-xs text-success-dark">{{ $t('common.saved') }}</span>
        </div>
      </div>
    </OyaCard>

    <!-- Find people — nickname search on the DHT directory -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('contacts.findPeople') }}
        </p>
        <p class="mt-1 text-sm opacity-65">
          {{ dhtOn ? $t('contacts.findHint') : $t('contacts.findNeedsDht') }}
        </p>
      </div>
      <div class="flex gap-2">
        <input
          v-model="searchNick"
          type="text"
          :maxlength="DHT_NICKNAME_MAX_LEN"
          :placeholder="$t('contacts.findPlaceholder')"
          :disabled="!dhtOn"
          class="min-w-0 flex-1 rounded-lg border border-current/15 bg-transparent px-3 py-1.5 text-sm disabled:opacity-50"
          @keyup.enter="findPeople"
        />
        <OyaButton
          :dark-mode="darkMode"
          variant="secondary"
          :class="{ 'pointer-events-none opacity-50': !dhtOn || searching || !searchNick.trim() }"
          @click="findPeople"
        >
          <font-awesome-icon :icon="searching ? 'spinner' : 'magnifying-glass'" :spin="searching" />
          {{ searching ? $t('contacts.searching') : $t('contacts.find') }}
        </OyaButton>
      </div>

      <p v-if="searched && searchResults.length === 0" class="py-2 text-center text-sm opacity-60">
        {{ $t('contacts.noResults') }}
      </p>
      <ul v-else-if="searchResults.length" class="divide-y divide-current/10">
        <li v-for="claim in searchResults" :key="claim.node_id" class="flex items-center gap-3 py-3">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">
              {{ claim.name }}
              <span
                v-if="claim.node_id === myNodeId"
                class="ml-1 rounded-full border border-current/20 px-1.5 text-[10px] uppercase opacity-60"
              >{{ $t('contacts.youBadge') }}</span>
            </p>
            <p class="truncate font-mono text-[11px] opacity-50">{{ claim.node_id }}</p>
          </div>
          <span v-if="contactIds.has(claim.node_id)" class="shrink-0 text-xs text-success-dark">
            <font-awesome-icon icon="check" /> {{ $t('contacts.addedBadge') }}
          </span>
          <button
            v-else-if="claim.node_id !== myNodeId"
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs font-semibold transition hover:opacity-80"
            @click="addFromSearch(claim)"
          >
            <font-awesome-icon icon="plus" /> {{ $t('contacts.add') }}
          </button>
        </li>
      </ul>
    </OyaCard>

    <!-- Saved contacts -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
            {{ $t('contacts.saved') }}
          </p>
          <p class="mt-1 text-sm opacity-65">
            {{ dhtOn ? $t('contacts.presenceHint') : $t('contacts.presenceOff') }}
          </p>
        </div>
        <OyaButton :dark-mode="darkMode" variant="secondary" @click="openAdd">
          <font-awesome-icon icon="plus" />{{ $t('contacts.add') }}
        </OyaButton>
      </div>

      <p v-if="contacts.length === 0" class="py-4 text-center text-sm opacity-60">
        {{ $t('contacts.empty') }}
      </p>

      <ul v-else class="divide-y divide-current/10">
        <li v-for="c in contacts" :key="c.nodeId" class="flex items-center gap-3 py-3">
          <!-- Presence dot: ~1 h granularity, only meaningful with DHT on -->
          <span
            v-if="dhtOn"
            :class="online[c.nodeId] ? 'bg-success-dark' : 'bg-current opacity-20'"
            class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            :title="online[c.nodeId] ? $t('contacts.recentlyOnline') : $t('contacts.notSeenRecently')"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ c.name }}</p>
            <p class="truncate font-mono text-[11px] opacity-50">{{ c.nodeId }}</p>
            <p v-if="c.lastSeen && !online[c.nodeId]" class="text-[11px] opacity-50">
              {{ $t('contacts.lastSeen', { date: lastSeenLabel(c) }) }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs transition hover:opacity-80"
            :title="$t('contacts.inviteDirect')"
            @click="openInviteFor(c)"
          >
            <font-awesome-icon icon="paper-plane" />
          </button>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs transition hover:opacity-80"
            :title="$t('contacts.rename')"
            @click="openEdit(c)"
          >
            <font-awesome-icon icon="pencil" />
          </button>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs text-warn-dark transition hover:opacity-80"
            :title="$t('contacts.delete')"
            @click="deleteContact(c)"
          >
            <font-awesome-icon icon="trash" />
          </button>
        </li>
      </ul>
    </OyaCard>

    <!-- Off-screen QR decode region (html5-qrcode needs a mounted element) -->
    <div id="contacts-qr-file-region" class="hidden" />

    <!-- Add-contact modal -->
    <OyaModal v-model:open="addOpen" @close="addOpen = false">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="address-book" />{{ $t('contacts.addTitle') }}
        </p>
        <OyaTextField v-model="addNodeId" :placeholder="$t('contacts.nodeIdPlaceholder')" @enter="submitAdd" />
        <label class="block cursor-pointer text-xs underline opacity-70 hover:opacity-100">
          {{ $t('chat.uploadQr') }}
          <input type="file" accept="image/*" class="hidden" @change="scanFile" />
        </label>
        <OyaTextField v-model="addName" :placeholder="$t('contacts.namePlaceholder')" @enter="submitAdd" />
        <p v-if="addError" class="text-sm text-warn-dark">{{ $t(addError) }}</p>
        <p v-if="scanError" class="text-sm text-warn-dark">{{ $t(scanError) }}</p>
        <button
          type="button"
          class="w-full rounded-lg bg-accent-dark px-4 py-2 text-sm font-semibold text-primary-bg-dark transition hover:opacity-90"
          @click="submitAdd"
        >
          {{ $t('contacts.add') }}
        </button>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="addOpen = false"
        >
          {{ $t('chat.close') }}
        </button>
      </template>
    </OyaModal>

    <!-- Rename modal -->
    <OyaModal v-model:open="editOpen" @close="editOpen = false">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="text-lg font-bold">{{ $t('contacts.rename') }}</p>
        <OyaTextField v-model="editName" :placeholder="$t('contacts.namePlaceholder')" @enter="submitEdit" />
        <button
          type="button"
          class="w-full rounded-lg bg-accent-dark px-4 py-2 text-sm font-semibold text-primary-bg-dark transition hover:opacity-90"
          @click="submitEdit"
        >
          {{ $t('common.save') }}
        </button>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="editOpen = false"
        >
          {{ $t('chat.close') }}
        </button>
      </template>
    </OyaModal>

    <!-- Direct-invite modal: pick a room → live handshake → outcome -->
    <OyaModal :open="inviteOpen" @close="closeInvite">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="paper-plane" />
          {{ $t('contacts.invitePickTitle', { name: inviteTarget?.name ?? '' }) }}
        </p>

        <!-- Room picker -->
        <template v-if="invites.outgoing.value === 'idle'">
          <p v-if="invitableRooms.length === 0" class="text-sm opacity-60">
            {{ $t('contacts.noRooms') }}
          </p>
          <ul v-else class="divide-y divide-current/10">
            <li v-for="room in invitableRooms" :key="room.room">
              <button
                type="button"
                class="flex w-full items-center gap-2 py-2.5 text-left text-sm transition hover:opacity-70"
                @click="pickInviteRoom(room)"
              >
                <font-awesome-icon icon="circle-nodes" class="opacity-60" />
                <span class="min-w-0 flex-1 truncate">{{ room.name }}</span>
                <font-awesome-icon icon="chevron-right" class="text-xs opacity-40" />
              </button>
            </li>
          </ul>
        </template>

        <!-- Waiting for the contact's answer -->
        <div v-else-if="invites.outgoing.value === 'waiting'" class="flex flex-col items-center gap-3 py-6 text-center">
          <font-awesome-icon icon="spinner" spin class="text-3xl text-accent-dark" />
          <p class="text-sm opacity-70">
            {{ $t('contacts.inviteWaiting', { name: inviteTarget?.name ?? '' }) }}
          </p>
        </div>

        <!-- Outcome -->
        <p v-else-if="invites.outgoing.value === 'accepted'" class="flex items-center gap-2 text-sm font-semibold text-success-dark">
          <font-awesome-icon icon="check" />
          {{ $t('contacts.inviteAccepted', { name: inviteTarget?.name ?? '' }) }}
        </p>
        <p v-else-if="invites.outgoing.value === 'declined'" class="flex items-center gap-2 text-sm text-warn-dark">
          <font-awesome-icon icon="xmark" />
          {{ $t('contacts.inviteDeclined', { name: inviteTarget?.name ?? '' }) }}
        </p>
        <div v-else-if="invites.outgoing.value === 'error'" class="space-y-2">
          <p class="flex items-center gap-2 text-sm text-warn-dark">
            <font-awesome-icon icon="triangle-exclamation" />
            {{ $t('contacts.inviteUnreachable', { name: inviteTarget?.name ?? '' }) }}
          </p>
          <p v-if="invites.outgoingError.value && invites.outgoingError.value !== 'contacts.inviteUnavailable'" class="text-xs opacity-60">
            {{ invites.outgoingError.value }}
          </p>
          <p v-else-if="invites.outgoingError.value === 'contacts.inviteUnavailable'" class="text-xs opacity-60">
            {{ $t('contacts.inviteUnavailable') }}
          </p>
          <button
            type="button"
            class="w-full rounded-lg border border-current/20 px-4 py-2 text-sm font-semibold transition hover:opacity-80"
            @click="invites.resetOutgoing"
          >
            {{ $t('chat.retry') }}
          </button>
        </div>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="closeInvite"
        >
          {{ $t('chat.close') }}
        </button>
      </template>
    </OyaModal>

  </section>
</template>
