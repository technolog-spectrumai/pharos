<script setup lang="ts">
// Contacts — saved peers (stable iroh NodeIds) + DHT presence + invite-to-room.
//
// A contact is exchanged once (paste or QR of the NodeId, like a room ticket);
// with the Settings DHT toggle on, each contact row shows "recently online"
// (the freshness of the address record DHT-enabled peers publish — ~1 h
// granularity, honest in the tooltip) and saved rooms can be shared as a
// ticketless join code. See dht.md.
import { computed, onMounted, onUnmounted, ref } from "vue";
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
  dhtRoomCode,
  getDhtDiscovery,
  getDhtPresencePollSecs,
  type ContactEntry,
  type P2pRoomEntry,
} from "rakotis";
import { useChatStore } from "../stores/chat";

defineProps<{ darkMode: boolean }>();

const chatStore = useChatStore();

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

// ── Invite to room (share a saved room as a ticketless join code) ──────────────
const inviteOpen = ref(false);
const inviteCode = ref("");
const inviteRoomName = ref("");
const inviteError = ref(""); // i18n key
// Tor rooms can't be DHT-shared (different transport); offer the iroh ones.
const invitableRooms = computed<P2pRoomEntry[]>(() =>
  chatStore.p2p.p2pRooms.value.filter((r) => !r.tor),
);

function openInvite() {
  inviteCode.value = "";
  inviteRoomName.value = "";
  inviteError.value = "";
  inviteOpen.value = true;
}

async function pickInviteRoom(room: P2pRoomEntry) {
  inviteError.value = "";
  const code = room.code ?? (await dhtRoomCode(room.room, room.name));
  if (code) {
    inviteCode.value = code;
    inviteRoomName.value = room.name;
  } else {
    inviteError.value = "contacts.inviteNeedsDht";
  }
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

    <!-- Invite to a room — share a saved room as a ticketless join code -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
          {{ $t('contacts.invite') }}
        </p>
        <p class="mt-1 text-sm opacity-65">{{ $t('contacts.inviteHint') }}</p>
      </div>
      <OyaButton :dark-mode="darkMode" variant="secondary" @click="openInvite">
        <font-awesome-icon icon="share-nodes" />{{ $t('contacts.invite') }}
      </OyaButton>
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

    <!-- Invite modal: pick a saved room → show its join code as QR + copy -->
    <OyaModal v-model:open="inviteOpen" @close="inviteOpen = false">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="share-nodes" />{{ $t('contacts.invite') }}
        </p>

        <template v-if="!inviteCode">
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
          <p v-if="inviteError" class="text-sm text-warn-dark">{{ $t(inviteError) }}</p>
        </template>

        <template v-else>
          <p class="text-sm font-semibold">{{ inviteRoomName }}</p>
          <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t('chat.shareCode') }}</p>
          <OyaQrCode :value="inviteCode" :size="176" alt="Room code QR" />
          <OyaCopyField :value="inviteCode" mono :copy-label="$t('chat.copy')" />
          <p class="text-xs opacity-60">{{ $t('contacts.inviteCodeHint') }}</p>
        </template>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="inviteOpen = false"
        >
          {{ $t('chat.close') }}
        </button>
      </template>
    </OyaModal>

  </section>
</template>
