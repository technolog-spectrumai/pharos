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
  getUseTor,
  getDhtPresencePollSecs,
  getDhtNickPublish,
  setDhtNickPublish,
  getDhtNickname,
  setDhtNickname,
  DHT_NICKNAME_MAX_LEN,
  getBuildConfig,
  invoke,
  type ContactEntry,
  type P2pRoomEntry,
  type NickClaim,
} from "rakotis";
import { useChatStore } from "../stores/chat";
import { useCloudStore } from "../stores/cloud";
import { usePeersStore } from "../stores/peers";
import PeerLinksPanel from "../components/peers/PeerLinksPanel.vue";
import PeerRequestForm from "../components/peers/PeerRequestForm.vue";

defineProps<{ darkMode: boolean }>();

const router = useRouter();
const chatStore = useChatStore();
// Non-null: the /contacts route is build-gated (pland.md), so this view only
// ever mounts in an edition where the composable exists.
const invites = chatStore.invites!;
// Peer sync is its own build gate (peer.md P4 — Pro only): in a flag-off build
// the store is never touched and nothing below renders.
const peersEnabled = getBuildConfig().peers_enabled;
const peers = peersEnabled ? usePeersStore() : null;
// The DHT is its own build gate (Pro only — pland.md). When it is off there is
// no Settings→Connections DHT card, so the surfaces below HIDE rather than
// showing an "enable DHT discovery in Settings" hint that points nowhere.
const dhtAllowed =
  getBuildConfig().p2p_allow_hosted_relays && getBuildConfig().dht_enabled;

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
// Tor mode tears down iroh, and with it every DHT function (Rust gates it at
// the source in p2p_dht). Over Tor the server directory below is the discovery
// path, so the DHT surfaces disable with the reason rather than lying.
const useTor = ref(false);
const dhtUsable = computed(() => dhtOn.value && !useTor.value);
const online = ref<Record<string, boolean>>({});

async function refreshPresence() {
  if (!dhtUsable.value || contacts.value.length === 0) return;
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
  useTor.value = await getUseTor();
  if (rdvBuildAllowed) {
    await cloudStore.init(); // mirror the knob + login state for server search
    // Make this device addressable so peers can seal invites to it — works
    // even in Tor mode, where iroh (and the relay publisher) are down. The
    // invite mailbox UI itself lives in the Cloud tab (cloud.md).
    if (rdvAllowed.value && cloudStore.loggedIn) {
      void invoke("rdv_register", { serverUrl: cloudStore.serverUrl }).catch(() => {});
    }
  }
  nickPublish.value = await getDhtNickPublish();
  nickname.value = await getDhtNickname();
  void loadMyNodeId();
  await chatStore.p2p.loadP2pRooms();
  if (dhtUsable.value) {
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
// Publish is an explicit, awaited action: the spinner runs until the DHT write
// completes, so "name published" is a confirmation — not fire-and-forget.
const publishState = ref<"idle" | "publishing" | "published" | "error">("idle");
const publishError = ref("");

async function saveNickname() {
  nickname.value = await setDhtNickname(nickname.value);
}

async function publishNick() {
  if (publishState.value === "publishing" || !dhtUsable.value) return;
  await saveNickname();
  if (!nickname.value) return;
  // Publishing implies staying findable: the background announcer keeps the
  // claim fresh (records age out of the DHT in ~1–2 h otherwise).
  nickPublish.value = true;
  await setDhtNickPublish(true);
  publishState.value = "publishing";
  publishError.value = "";
  try {
    await invoke("dht_publish_nick");
    publishState.value = "published";
  } catch (e) {
    publishState.value = "error";
    publishError.value = typeof e === "string" ? e : ((e as Error).message ?? "");
  }
}

async function toggleNickPublish() {
  if (!dhtUsable.value) return;
  nickPublish.value = !nickPublish.value;
  if (nickPublish.value) {
    // Turning findability ON = publish now, with feedback.
    await publishNick();
    return;
  }
  await setDhtNickPublish(false);
  publishState.value = "idle";
  // Rebind so the announcer stops immediately; the record then ages out.
  await invoke("dht_apply").catch(() => {});
}

// ── Find people (nickname search — results are CLAIMS, not identities) ────────
const searchNick = ref("");
const searching = ref(false);
const searched = ref(false); // a search completed → "no results" is meaningful
const searchResults = ref<NickClaim[]>([]);
async function findPeople() {
  const nick = searchNick.value.trim();
  if (!nick || searching.value || !dhtUsable.value) return;
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
// Adding ALWAYS goes through the code-validated add flow — a search result just
// prefills the modal with the claimant's code + claimed name; the user confirms.
function openAddFromClaim(claim: NickClaim) {
  openAdd();
  addNodeId.value = claim.node_id;
  addName.value = claim.name;
}

// ── Find on my server (cloud rendezvous, rdv.md) — resolve a faros username to
// its registered NodeIds. Optional: only when the build has cloud + hosted
// relays AND the user is logged in to their server. Same input, same result
// shape, same prefill-the-add-modal flow as the DHT search.
const cloudStore = useCloudStore();
// Build-time half (does the edition have the cloud client at all) — used for
// the "this lives in the Cloud tab" pointer, which must render even while the
// runtime knob is off. Mirrors aster::build_allowed(): hosted relays are
// irrelevant now that the directory only maps username → NodeId and carries
// sealed invites, never an address (rdv.md D2).
const rdvBuildAllowed = getBuildConfig().cloud_allow_connections;
// Full gate: also requires the Cloud tab's runtime master switch (cloud.md) —
// with it off, Rust refuses aster calls, so the search hides rather than lies.
const rdvAllowed = computed(() => rdvBuildAllowed && cloudStore.enabled);
const serverResults = ref<NickClaim[]>([]);
const serverSearching = ref(false);
const serverSearched = ref(false);
const serverError = ref("");
async function findOnServer() {
  const username = searchNick.value.trim();
  if (!username || serverSearching.value || !cloudStore.loggedIn) return;
  serverSearching.value = true;
  serverSearched.value = false;
  serverError.value = "";
  try {
    const ids = await invoke<string[]>("aster_resolve", {
      serverUrl: cloudStore.serverUrl,
      username,
    });
    // ts = now: the server only returns addresses fresher than its TTL.
    serverResults.value = ids.map((node_id) => ({ node_id, name: username, ts: Date.now() }));
    serverSearched.value = true;
  } catch (e) {
    serverError.value = typeof e === "string" ? e : ((e as Error).message ?? "");
  } finally {
    serverSearching.value = false;
  }
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

// Calls are their own build gate (pland.md) — Contacts can ship without them,
// so the ring button is hidden and this is a no-op in a calls-off edition.
const callsEnabled = chatStore.callsEnabled;

// Ring a saved contact by their stable NodeId and jump to the Vox tab.
async function callContact(contact: ContactEntry) {
  if (!chatStore.vox) return;
  await chatStore.vox.callNode(contact.nodeId, contact.name);
  void router.push("/vox");
}

function closeInvite() {
  inviteOpen.value = false;
  invites.resetOutgoing();
}

// Tor rooms can't ride the direct P2P invite (different transport). Their
// sealed server-mailbox flow moved to the Cloud tab (cloud.md) — kept here only
// to render the pointer and the honest empty state in the invite modal.
const torRooms = computed<P2pRoomEntry[]>(() =>
  chatStore.p2p.p2pRooms.value.filter((r) => r.tor),
);

async function pickInviteRoom(room: P2pRoomEntry) {
  const target = inviteTarget.value;
  if (!target) return;
  await invites.sendInvite(target.nodeId, room);
}

// ── Peer sync (scoped person-to-person link — peer.md) ────────────────────────
// Person-first like the direct invite above: pick the contact, then pick what
// each side shares. Nothing leaves this device until they accept.
const syncOpen = ref(false);
const syncTarget = ref<ContactEntry | null>(null);

function openSyncFor(contact: ContactEntry) {
  syncTarget.value = contact;
  syncOpen.value = true;
}

function closeSync() {
  syncOpen.value = false;
  peers?.resetOutgoing();
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

    <!-- Incoming invite — file-share-style: nothing happens until Accept.
         (Sealed server-mailbox invites moved to the Cloud tab — cloud.md.) -->
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
      <div v-if="dhtAllowed && !useTor" class="space-y-3 border-t border-current/10 pt-4">
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
        <div v-if="dhtUsable" class="flex items-center gap-2">
          <input
            v-model="nickname"
            type="text"
            :maxlength="DHT_NICKNAME_MAX_LEN"
            :placeholder="$t('contacts.nickPlaceholder')"
            class="min-w-0 flex-1 rounded-lg border border-current/15 bg-transparent px-3 py-1.5 text-sm"
            @input="publishState = 'idle'"
            @change="saveNickname"
            @keyup.enter="publishNick"
          />
          <OyaButton
            :dark-mode="darkMode"
            variant="secondary"
            :class="{ 'pointer-events-none opacity-50': publishState === 'publishing' || !nickname.trim() }"
            @click="publishNick"
          >
            <font-awesome-icon
              :icon="publishState === 'publishing' ? 'spinner' : 'arrow-up'"
              :spin="publishState === 'publishing'"
            />
            {{ publishState === 'publishing' ? $t('contacts.publishing') : $t('contacts.publish') }}
          </OyaButton>
        </div>
        <p v-if="publishState === 'published'" class="flex items-center gap-2 text-xs text-success-dark">
          <font-awesome-icon icon="check" />{{ $t('contacts.nickPublished') }}
        </p>
        <div v-else-if="publishState === 'error'" class="space-y-1">
          <p class="flex items-center gap-2 text-xs text-warn-dark">
            <font-awesome-icon icon="triangle-exclamation" />{{ $t('contacts.publishFailed') }}
          </p>
          <p v-if="publishError" class="text-xs opacity-60">{{ publishError }}</p>
        </div>
      </div>
    </OyaCard>

    <!-- Find people — two directories behind one search box: the DHT nickname
         directory and the user's own faros server. Each has its own build gate,
         so the card is here only if at least one of them can actually search. -->
    <OyaCard v-if="dhtAllowed || rdvBuildAllowed" :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('contacts.findPeople') }}
        </p>
        <!-- "turn the DHT on" only when there is a toggle to turn on; a build
             without the DHT describes the server directory instead. -->
        <p class="mt-1 text-sm opacity-65">
          {{ dhtUsable ? $t('contacts.findHint') : dhtAllowed ? $t('contacts.findNeedsDht') : $t('contacts.rdvFindHint') }}
        </p>
      </div>
      <div class="flex gap-2">
        <input
          v-model="searchNick"
          type="text"
          :maxlength="DHT_NICKNAME_MAX_LEN"
          :placeholder="$t('contacts.findPlaceholder')"
          :disabled="!dhtUsable && !(rdvAllowed && cloudStore.loggedIn)"
          class="min-w-0 flex-1 rounded-lg border border-current/15 bg-transparent px-3 py-1.5 text-sm disabled:opacity-50"
          @keyup.enter="findPeople"
        />
        <OyaButton
          v-if="dhtUsable"
          :dark-mode="darkMode"
          variant="secondary"
          :class="{ 'pointer-events-none opacity-50': searching || !searchNick.trim() }"
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
          <!-- Adding only works by code: this prefills the code-validated
               add-contact modal — the user confirms there. -->
          <button
            v-else-if="claim.node_id !== myNodeId"
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs font-semibold transition hover:opacity-80"
            @click="openAddFromClaim(claim)"
          >
            <font-awesome-icon icon="plus" /> {{ $t('contacts.useCode') }}
          </button>
        </li>
      </ul>

      <!-- Same search box, second directory: the user's own faros server
           (cloud rendezvous). Hidden while the Cloud master switch is off
           (Rust refuses the call anyway — hide rather than lie, cloud.md);
           with the switch on it stays visible and merely disables with the
           reason when not logged in. -->
      <template v-if="rdvAllowed">
        <div class="flex items-center gap-2 border-t border-current/10 pt-3">
          <OyaButton
            :dark-mode="darkMode"
            variant="secondary"
            data-testid="rdv-find"
            :class="{ 'pointer-events-none opacity-50': !cloudStore.loggedIn || serverSearching || !searchNick.trim() }"
            :title="cloudStore.loggedIn ? $t('contacts.rdvFindHint') : $t('contacts.rdvNeedsLogin')"
            @click="findOnServer"
          >
            <font-awesome-icon :icon="serverSearching ? 'spinner' : 'address-book'" :spin="serverSearching" />
            {{ $t('contacts.rdvFind') }}
          </OyaButton>
          <span v-if="!cloudStore.loggedIn" class="text-xs opacity-60">{{ $t('contacts.rdvNeedsLogin') }}</span>
        </div>
        <p v-if="serverError" class="text-xs text-warn-dark">{{ serverError }}</p>
        <p v-else-if="serverSearched && serverResults.length === 0" class="py-1 text-center text-sm opacity-60">
          {{ $t('contacts.noResults') }}
        </p>
        <ul v-else-if="serverResults.length" class="divide-y divide-current/10" data-testid="rdv-results">
          <li v-for="claim in serverResults" :key="claim.node_id" class="flex items-center gap-3 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">
                {{ claim.name }}
                <span class="ml-1 rounded-full border border-current/20 px-1.5 text-[10px] uppercase opacity-60">{{ $t('contacts.rdvBadge') }}</span>
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
              @click="openAddFromClaim(claim)"
            >
              <font-awesome-icon icon="plus" /> {{ $t('contacts.useCode') }}
            </button>
          </li>
        </ul>
      </template>
    </OyaCard>

    <!-- Saved contacts -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
            {{ $t('contacts.saved') }}
          </p>
          <!-- No hint at all without the DHT: presenceOff tells the user to
               enable a Settings toggle this build does not have. -->
          <p v-if="dhtAllowed" class="mt-1 text-sm opacity-65">
            {{ dhtUsable ? $t('contacts.presenceHint') : $t('contacts.presenceOff') }}
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
            v-if="dhtUsable"
            :class="online[c.nodeId] ? 'bg-success-dark' : 'bg-current opacity-20'"
            class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            :title="online[c.nodeId] ? $t('contacts.recentlyOnline') : $t('contacts.notSeenRecently')"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">
              {{ c.name }}
              <!-- Already peer-linked: the sync button below re-negotiates it -->
              <span
                v-if="peers?.isLinked(c.nodeId)"
                class="ml-1 rounded-full border border-current/20 px-1.5 text-[10px] uppercase text-success-dark"
                :title="$t('peers.linkedBadgeTitle')"
              >
                <font-awesome-icon icon="arrows-rotate" /> {{ $t('peers.linkedBadge') }}
              </span>
            </p>
            <p class="truncate font-mono text-[11px] opacity-50">{{ c.nodeId }}</p>
            <p v-if="c.lastSeen && !online[c.nodeId]" class="text-[11px] opacity-50">
              {{ $t('contacts.lastSeen', { date: lastSeenLabel(c) }) }}
            </p>
          </div>
          <button
            v-if="callsEnabled"
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs transition hover:opacity-80"
            :title="$t('contacts.call')"
            @click="callContact(c)"
          >
            <font-awesome-icon icon="phone" />
          </button>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs transition hover:opacity-80"
            :title="$t('contacts.inviteDirect')"
            @click="openInviteFor(c)"
          >
            <font-awesome-icon icon="paper-plane" />
          </button>
          <button
            v-if="peersEnabled"
            type="button"
            class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs transition hover:opacity-80"
            :title="$t('peers.sync')"
            @click="openSyncFor(c)"
          >
            <font-awesome-icon icon="arrows-rotate" />
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

    <!-- Peer links — what each side of a scoped sync actually shares -->
    <PeerLinksPanel v-if="peersEnabled" :dark-mode="darkMode" />

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
          <p v-if="invitableRooms.length === 0 && torRooms.length === 0" class="text-sm opacity-60">
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

          <!-- Tor rooms: the direct P2P invite can't carry them — their sealed
               server-mailbox flow lives in the Cloud tab (cloud.md). -->
          <template v-if="rdvBuildAllowed && torRooms.length">
            <p class="border-t border-current/10 pt-3 text-xs opacity-60" data-testid="tor-rooms-pointer">
              {{ $t('contacts.torRoomsViaCloud') }}
            </p>
            <RouterLink
              to="/cloud?tab=invites"
              class="inline-flex items-center gap-2 text-sm font-semibold text-accent-light transition hover:opacity-70 dark:text-accent-dark"
              @click="closeInvite"
            >
              <font-awesome-icon icon="cloud" />
              {{ $t('nav.cloud') }}
              <font-awesome-icon icon="chevron-right" class="text-xs opacity-60" />
            </RouterLink>
          </template>
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

    <!-- Peer-sync request: pick per-direction scopes → live handshake → outcome -->
    <OyaModal v-if="peersEnabled" :open="syncOpen" @close="closeSync">
      <PeerRequestForm
        v-if="syncTarget"
        :dark-mode="darkMode"
        :node-id="syncTarget.nodeId"
        :name="syncTarget.name"
      />
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="closeSync"
        >
          {{ $t('chat.close') }}
        </button>
      </template>
    </OyaModal>

  </section>
</template>
