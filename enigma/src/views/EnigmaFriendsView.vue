<script setup lang="ts">
// Friends: Pharos 1:1 messaging. A list of friends, one conversation, a short
// text composer, and pairing by QR or text (D1).
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaEmptyState, OyaModal, OyaQrCode, OyaTextArea, OyaTextField, OyaCopyField } from "petalite/primitives";
import { formatTime } from "rakotis";
import QrScannerModal from "../components/chat/QrScannerModal.vue";
import FriendImage from "../components/friends/FriendImage.vue";
import { shrink, toBase64, type Fitted } from "../friends/shrink";
import * as api from "../friends/api";
import { policy } from "../config/app";

const { t } = useI18n();
const MAX = policy.maxMessageChars;

const me = ref<api.Me | null>(null);
const list = ref<api.Friend[]>([]);
const current = ref<string | null>(null);
const msgs = ref<api.Msg[]>([]);
const draft = ref("");
const error = ref("");
const starting = ref(true);
// Phones show the list or one conversation, not both (md and up show both).
const showList = ref(true);
let stop: (() => void) | null = null;

const friend = computed(() => list.value.find((f) => f.id === current.value) ?? null);
const length = computed(() => [...draft.value.trim()].length);
const canSend = computed(() => !!current.value && length.value > 0 && length.value <= MAX);

function fail(e: unknown) {
  error.value = String(e);
}

async function refreshFriends() {
  list.value = await api.friends();
  if (!current.value && list.value.length) await open(list.value[0].id, false);
}

async function open(id: string, tapped = true) {
  current.value = id;
  if (tapped) showList.value = false;
  msgs.value = await api.messages(id);
  await scrollDown();
}

const scroller = ref<HTMLElement | null>(null);
async function scrollDown() {
  await nextTick();
  scroller.value?.scrollTo?.({ top: scroller.value.scrollHeight });
}

// ── pictures ────────────────────────────────────────────────────────────────
// A picture (a screenshot) goes whole, in one message: it is made small enough
// first (friends/shrink.ts), shown for a yes, then sent. Over Tor it takes a few seconds.
const picture = ref<(Fitted & { url: string }) | null>(null);
const shrinking = ref(false);
const pictureError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

async function takePicture(file: Blob | null | undefined) {
  if (!file || !current.value) return;
  pictureError.value = "";
  shrinking.value = true;
  try {
    const f = await shrink(file);
    picture.value = { ...f, url: URL.createObjectURL(f.blob) };
  } catch {
    pictureError.value = t("friends.imageTooBig");
  } finally {
    shrinking.value = false;
  }
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  takePicture(input.files?.[0]);
  input.value = "";
}

/** A screenshot pasted into the message box becomes a picture to send. */
function onPaste(e: ClipboardEvent) {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  takePicture(item.getAsFile());
}

function dropPicture() {
  if (picture.value) URL.revokeObjectURL(picture.value.url);
  picture.value = null;
}

async function sendPicture() {
  const p = picture.value;
  if (!p || !current.value) return;
  try {
    await api.sendImage(current.value, p.mime, await toBase64(p.blob));
    dropPicture();
  } catch (e) {
    pictureError.value = String(e);
  }
}

async function sendDraft() {
  if (!canSend.value || !current.value) return;
  const text = draft.value.trim();
  draft.value = "";
  try {
    await api.send(current.value, text);
  } catch (e) {
    draft.value = text;
    fail(e);
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendDraft();
  }
}

onMounted(async () => {
  try {
    me.value = await api.start();
    stop = await api.onEvents({
      message: (m) => {
        if (m.friend === current.value && !msgs.value.some((x) => x.id === m.id)) {
          msgs.value.push(m);
          scrollDown();
        }
      },
      status: (s) => {
        const m = msgs.value.find((x) => x.id === s.id);
        if (m) m.status = s.status;
      },
      friends: () => refreshFriends(),
    });
    await refreshFriends();
  } catch (e) {
    fail(e);
  } finally {
    starting.value = false;
  }
});
onUnmounted(() => stop?.());

const statusIcon: Record<api.Status, string> = {
  Queued: "clock",
  OnRelay: "server",
  Delivered: "check",
  Received: "",
};

// ── pairing ─────────────────────────────────────────────────────────────────
const pairing = ref(false);
const myCard = ref("");
const pasted = ref("");
const replyToShow = ref("");
const scanning = ref(false);
const pairNote = ref("");

async function openPairing() {
  pairing.value = true;
  replyToShow.value = "";
  pasted.value = "";
  pairNote.value = "";
  try {
    myCard.value = await api.card();
  } catch (e) {
    fail(e);
  }
}

async function usePasted(text = pasted.value) {
  pairNote.value = "";
  try {
    const kind = api.kindOf(text);
    if (kind === "card") {
      const s = await api.scan(text);
      await refreshFriends();
      await open(s.friend);
      if (s.reply) {
        replyToShow.value = s.reply;
        pairNote.value = t("friends.showReply", { name: s.name });
      } else {
        pairNote.value = t("friends.pairedViaRelay", { name: s.name });
      }
    } else if (kind === "relay") {
      // A Relay is not a friend: say where its code goes instead of failing.
      pairNote.value = t("friends.relayCodeHint");
    } else if (kind === "reply") {
      const id = await api.accept(text);
      await refreshFriends();
      await open(id);
      pairing.value = false;
    } else {
      pairNote.value = t("friends.notACard");
    }
  } catch (e) {
    pairNote.value = String(e);
  }
}

// ── me ──────────────────────────────────────────────────────────────────────
const settings = ref(false);
const scanningRelay = ref(false);
const nameDraft = ref("");
const relayDraft = ref("");
const settingsError = ref("");
const savingSettings = ref(false);
function openSettings() {
  nameDraft.value = me.value?.name ?? "";
  relayDraft.value = me.value?.relay ?? "";
  settingsError.value = "";
  settings.value = true;
}
async function saveSettings() {
  settingsError.value = "";
  savingSettings.value = true;
  try {
    if (nameDraft.value.trim() !== me.value?.name) me.value = await api.setName(nameDraft.value);
    const p = relayDraft.value.trim() || null;
    // Connecting to a Relay over Tor can take a while; the dialog says so.
    if (p !== (me.value?.relay ?? null)) me.value = await api.setRelay(p);
    settings.value = false;
  } catch (e) {
    // Shown in the dialog, beside what was typed, not behind it.
    settingsError.value = String(e);
  } finally {
    savingSettings.value = false;
  }
}

async function removeCurrent() {
  if (!current.value || !confirm(t("friends.removeConfirm", { name: friend.value?.name ?? "" }))) return;
  await api.remove(current.value);
  current.value = null;
  msgs.value = [];
  showList.value = true;
  await refreshFriends();
}
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col md:flex-row" data-testid="friends-view">
    <!-- friends -->
    <aside class="w-full flex-col border-current/10 md:flex md:w-72 md:border-r" :class="showList ? 'flex' : 'hidden'" data-testid="friends-list">
      <div class="flex items-center gap-2 border-b border-current/10 p-3">
        <div class="min-w-0 flex-1">
          <div class="truncate font-bold" data-testid="me-name">{{ me?.name ?? "…" }}</div>
          <div class="truncate font-mono text-[10px] opacity-60" :title="$t('friends.yourFingerprint')">{{ me?.fingerprint }}</div>
          <div class="truncate text-[10px] opacity-60" data-testid="me-relay" :title="me?.relay ?? ''">
            <font-awesome-icon icon="server" />
            {{ me?.relay ? $t('friends.relayOn', { onion: me.relay.slice(0, 12) + '…' }) : $t('friends.relayNone') }}
          </div>
        </div>
        <OyaButton type="button" :aria-label="$t('friends.settings')" @click="openSettings"><font-awesome-icon icon="gear" /></OyaButton>
      </div>
      <div class="p-3">
        <OyaButton type="button" class="w-full" data-testid="add-friend" @click="openPairing">
          <font-awesome-icon icon="user-plus" />{{ $t('friends.add') }}
        </OyaButton>
      </div>
      <ul class="min-h-0 flex-1 overflow-y-auto">
        <li v-for="f in list" :key="f.id">
          <button
            type="button"
            class="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-current/5"
            :class="{ 'bg-current/10 font-bold': f.id === current }"
            :data-testid="`friend-${f.name}`"
            @click="open(f.id)"
          >
            <span aria-hidden="true" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-dark/25 font-bold uppercase">{{ f.name.slice(0, 1) }}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate">{{ f.name }}</span>
              <span class="block truncate text-[11px] opacity-50">
                {{ f.relay ? $t('friends.hasRelay') : $t('friends.directOnly') }}
              </span>
            </span>
          </button>
        </li>
      </ul>
      <p v-if="!starting && !list.length" class="p-4 text-sm opacity-60">{{ $t('friends.none') }}</p>
    </aside>

    <!-- conversation -->
    <section class="min-h-0 flex-1 flex-col md:flex" :class="showList ? 'hidden' : 'flex'" data-testid="conversation">
      <p v-if="error" class="m-3 rounded border border-error-light/40 p-2 text-sm text-error-light dark:text-error-dark" role="alert">
        {{ error }} <button type="button" class="underline" @click="error = ''">{{ $t('friends.dismiss') }}</button>
      </p>
      <template v-if="friend">
        <header class="flex items-center gap-2 border-b border-current/10 px-4 py-2">
          <OyaButton type="button" class="md:hidden" :aria-label="$t('friends.back')" data-testid="back" @click="showList = true">
            <font-awesome-icon icon="arrow-left" />
          </OyaButton>
          <div class="min-w-0 flex-1">
            <div class="truncate font-bold">{{ friend.name }}</div>
            <div class="truncate font-mono text-[10px] opacity-60" :title="friend.fingerprint">{{ friend.fingerprint }}</div>
          </div>
          <OyaButton type="button" :aria-label="$t('friends.checkNow')" @click="api.sync().catch(fail)"><font-awesome-icon icon="rotate" /></OyaButton>
          <OyaButton type="button" :aria-label="$t('friends.remove')" @click="removeCurrent"><font-awesome-icon icon="trash" /></OyaButton>
        </header>
        <div ref="scroller" class="min-h-0 flex-1 space-y-2 overflow-y-auto p-4" data-testid="messages">
          <OyaEmptyState v-if="!msgs.length" icon="comments">{{ $t('friends.empty') }}</OyaEmptyState>
          <div
            v-for="m in msgs"
            :key="m.id"
            class="flex"
            :class="m.status === 'Received' ? 'justify-start' : 'justify-end'"
          >
            <div
              class="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm"
              :class="m.status === 'Received' ? 'bg-bubble-bg-light dark:bg-bubble-bg-dark' : 'border border-accent-dark/40 bg-accent-dark/20'"
            >
              <FriendImage
                v-if="m.image"
                :id="m.id"
                :alt="m.status === 'Received' ? $t('friends.imageFrom', { name: friend.name }) : $t('friends.imageYours')"
              />
              <template v-else>{{ m.text }}</template>
              <div class="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-60">
                {{ formatTime(new Date(m.sent_ms)) }}
                <font-awesome-icon
                  v-if="statusIcon[m.status]"
                  :icon="statusIcon[m.status]"
                  :title="$t(`friends.status.${m.status}`)"
                  :data-testid="`status-${m.status}`"
                />
              </div>
            </div>
          </div>
        </div>
        <div class="border-t border-current/10 p-3">
          <div v-if="length > MAX * 0.8" class="mb-1 text-right text-[11px] tabular-nums" data-testid="length" :class="length > MAX ? 'font-bold text-error-light' : 'opacity-50'">
            {{ $t('chat.length', { n: length, max: MAX }) }}
          </div>
          <p v-if="shrinking" class="mb-1 text-xs opacity-70" role="status">{{ $t('friends.shrinking') }}</p>
          <p v-if="pictureError && !picture" class="mb-1 text-xs text-error-light dark:text-error-dark" role="alert" data-testid="picture-error">{{ pictureError }}</p>
          <div class="flex gap-2">
            <input ref="fileInput" type="file" accept="image/*" class="hidden" data-testid="picture-input" @change="onFile" />
            <OyaButton type="button" :aria-label="$t('friends.addImage')" :title="$t('friends.addImage')" data-testid="add-picture" @click="fileInput?.click()">
              <font-awesome-icon icon="image" />
            </OyaButton>
            <OyaTextArea v-model="draft" :rows="1" :placeholder="$t('friends.placeholder')" class="flex-1 text-sm" data-testid="compose" @keydown="onKey" @paste="onPaste" />
            <OyaButton type="button" :disabled="!canSend" :class="{ 'cursor-not-allowed opacity-40': !canSend }" data-testid="send" @click="sendDraft">
              <font-awesome-icon icon="paper-plane" />{{ $t('chat.send') }}
            </OyaButton>
          </div>
        </div>
      </template>
      <OyaEmptyState v-else class="flex-1" icon="users" size="lg">{{ starting ? $t('friends.starting') : $t('friends.pick') }}</OyaEmptyState>
    </section>

    <!-- a picture, before it goes -->
    <OyaModal :open="!!picture" @close="dropPicture">
      <div v-if="picture" class="w-[min(34rem,92vw)] space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark" data-testid="picture-preview">
        <h2 class="text-lg font-bold">{{ $t('friends.imagePreview', { name: friend?.name ?? '' }) }}</h2>
        <img :src="picture.url" :alt="$t('friends.imageYours')" class="max-h-[55vh] w-full rounded-xl object-contain" />
        <p class="text-xs opacity-70" data-testid="picture-size">
          {{ $t('friends.imageSize', { kb: Math.ceil(picture.blob.size / 1024), w: picture.width, h: picture.height }) }}
        </p>
        <p v-if="pictureError" class="text-xs text-error-light dark:text-error-dark" role="alert">{{ pictureError }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton type="button" @click="dropPicture">{{ $t('friends.cancel') }}</OyaButton>
          <OyaButton type="button" data-testid="send-picture" @click="sendPicture"><font-awesome-icon icon="paper-plane" />{{ $t('friends.sendImage') }}</OyaButton>
        </div>
      </div>
    </OyaModal>

    <!-- pairing -->
    <OyaModal v-model:open="pairing">
      <div class="max-h-[85vh] w-[min(36rem,92vw)] space-y-4 overflow-y-auto rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark" data-testid="pairing">
        <h2 class="text-lg font-bold">{{ $t('friends.add') }}</h2>
        <section v-if="!replyToShow" class="space-y-2">
          <h3 class="font-bold">{{ $t('friends.step1') }}</h3>
          <p class="text-sm opacity-70">{{ $t('friends.step1Help') }}</p>
          <div v-if="myCard" class="flex justify-center"><OyaQrCode :value="myCard" :size="260" :alt="$t('friends.cardQr')" /></div>
          <OyaCopyField v-if="myCard" :value="myCard" mono />
          <p class="text-xs opacity-60">{{ $t('friends.fingerprintCheck', { fp: me?.fingerprint ?? '' }) }}</p>
        </section>
        <section v-else class="space-y-2">
          <h3 class="font-bold">{{ $t('friends.replyTitle') }}</h3>
          <div class="flex justify-center"><OyaQrCode :value="replyToShow" :size="300" :alt="$t('friends.replyQr')" /></div>
          <OyaCopyField :value="replyToShow" mono />
        </section>
        <section class="space-y-2">
          <h3 class="font-bold">{{ $t('friends.step2') }}</h3>
          <p class="text-sm opacity-70">{{ $t('friends.step2Help') }}</p>
          <div class="flex gap-2">
            <OyaTextField v-model="pasted" class="flex-1" :placeholder="$t('friends.pastePlaceholder')" data-testid="paste" />
            <OyaButton type="button" data-testid="use-paste" @click="usePasted()">{{ $t('friends.use') }}</OyaButton>
            <OyaButton type="button" :aria-label="$t('friends.scan')" @click="scanning = true"><font-awesome-icon icon="camera" /></OyaButton>
          </div>
          <p v-if="pairNote" class="text-sm" data-testid="pair-note">{{ pairNote }}</p>
        </section>
        <div class="text-right"><OyaButton type="button" @click="pairing = false">{{ $t('friends.done') }}</OyaButton></div>
      </div>
    </OyaModal>
    <QrScannerModal v-model:open="scanning" @decoded="(s: string) => { scanning = false; usePasted(s); }" />
    <QrScannerModal v-model:open="scanningRelay" @decoded="(s: string) => { scanningRelay = false; relayDraft = s.trim(); }" />

    <!-- me -->
    <OyaModal v-model:open="settings">
      <div class="w-[min(30rem,92vw)] space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <h2 class="text-lg font-bold">{{ $t('friends.settings') }}</h2>
        <label class="block text-sm">{{ $t('friends.yourName') }}
          <OyaTextField v-model="nameDraft" :maxlength="64" />
        </label>
        <label class="block text-sm">{{ $t('friends.relay') }}
          <div class="flex gap-2">
            <OyaTextField v-model="relayDraft" class="flex-1" :placeholder="$t('friends.relayPlaceholder')" data-testid="relay-field" />
            <OyaButton type="button" :aria-label="$t('friends.scanRelay')" data-testid="scan-relay" @click="scanningRelay = true">
              <font-awesome-icon icon="camera" />
            </OyaButton>
          </div>
        </label>
        <p class="text-xs opacity-60">{{ $t('friends.relayHelp') }}</p>
        <p v-if="savingSettings" class="text-xs" role="status">{{ $t('friends.connectingRelay') }}</p>
        <p v-if="settingsError" class="text-xs text-error-light dark:text-error-dark" role="alert" data-testid="settings-error">{{ settingsError }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton type="button" @click="settings = false">{{ $t('friends.cancel') }}</OyaButton>
          <OyaButton type="button" data-testid="save-settings" :disabled="savingSettings" @click="saveSettings">{{ $t('friends.save') }}</OyaButton>
        </div>
      </div>
    </OyaModal>
  </div>
</template>
