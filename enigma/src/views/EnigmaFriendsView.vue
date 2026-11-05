<script setup lang="ts">
// Friends: Pharos 1:1 messaging. A list of friends, one conversation, a short
// text composer, and pairing by QR or text (D1).
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaEmptyState, OyaModal, OyaQrCode, OyaTextArea, OyaTextField, OyaCopyField } from "petalite/primitives";
import { formatTime } from "rakotis";
import QrScannerModal from "../components/chat/QrScannerModal.vue";
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
let stop: (() => void) | null = null;

const friend = computed(() => list.value.find((f) => f.id === current.value) ?? null);
const length = computed(() => [...draft.value.trim()].length);
const canSend = computed(() => !!current.value && length.value > 0 && length.value <= MAX);

function fail(e: unknown) {
  error.value = String(e);
}

async function refreshFriends() {
  list.value = await api.friends();
  if (!current.value && list.value.length) await open(list.value[0].id);
}

async function open(id: string) {
  current.value = id;
  msgs.value = await api.messages(id);
  await scrollDown();
}

const scroller = ref<HTMLElement | null>(null);
async function scrollDown() {
  await nextTick();
  scroller.value?.scrollTo?.({ top: scroller.value.scrollHeight });
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
  OnProteus: "server",
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
        pairNote.value = t("friends.pairedViaProteus", { name: s.name });
      }
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
const nameDraft = ref("");
const proteusDraft = ref("");
function openSettings() {
  nameDraft.value = me.value?.name ?? "";
  proteusDraft.value = me.value?.proteus ?? "";
  settings.value = true;
}
async function saveSettings() {
  try {
    if (nameDraft.value.trim() !== me.value?.name) me.value = await api.setName(nameDraft.value);
    const p = proteusDraft.value.trim() || null;
    if (p !== (me.value?.proteus ?? null)) me.value = await api.setProteus(p);
    settings.value = false;
  } catch (e) {
    fail(e);
  }
}

async function removeCurrent() {
  if (!current.value || !confirm(t("friends.removeConfirm", { name: friend.value?.name ?? "" }))) return;
  await api.remove(current.value);
  current.value = null;
  msgs.value = [];
  await refreshFriends();
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col md:flex-row" data-testid="friends-view">
    <!-- friends -->
    <aside class="flex flex-col border-current/10 md:w-72 md:border-r">
      <div class="flex items-center gap-2 border-b border-current/10 p-3">
        <div class="min-w-0 flex-1">
          <div class="truncate font-bold" data-testid="me-name">{{ me?.name ?? "…" }}</div>
          <div class="truncate font-mono text-[10px] opacity-60" :title="$t('friends.yourFingerprint')">{{ me?.fingerprint }}</div>
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
            class="w-full px-4 py-2 text-left hover:bg-current/5"
            :class="{ 'bg-current/10 font-bold': f.id === current }"
            :data-testid="`friend-${f.name}`"
            @click="open(f.id)"
          >
            <div class="truncate">{{ f.name }}</div>
            <div class="truncate text-[10px] opacity-50">
              {{ f.proteus ? $t('friends.hasProteus') : $t('friends.directOnly') }}
            </div>
          </button>
        </li>
      </ul>
      <p v-if="!starting && !list.length" class="p-4 text-sm opacity-60">{{ $t('friends.none') }}</p>
    </aside>

    <!-- conversation -->
    <section class="flex min-h-0 flex-1 flex-col">
      <p v-if="error" class="m-3 rounded border border-error-light/40 p-2 text-sm text-error-light dark:text-error-dark" role="alert">
        {{ error }} <button type="button" class="underline" @click="error = ''">{{ $t('friends.dismiss') }}</button>
      </p>
      <template v-if="friend">
        <header class="flex items-center gap-2 border-b border-current/10 px-4 py-2">
          <div class="min-w-0 flex-1">
            <div class="font-bold">{{ friend.name }}</div>
            <div class="font-mono text-[10px] opacity-60">{{ friend.fingerprint }}</div>
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
              {{ m.text }}
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
          <div class="mb-1 text-right text-[11px] tabular-nums" :class="length > MAX ? 'font-bold text-error-light' : 'opacity-50'">
            {{ $t('chat.length', { n: length, max: MAX }) }}
          </div>
          <div class="flex gap-2">
            <OyaTextArea v-model="draft" :rows="1" :placeholder="$t('friends.placeholder')" class="flex-1 text-sm" data-testid="compose" @keydown="onKey" />
            <OyaButton type="button" :disabled="!canSend" :class="{ 'cursor-not-allowed opacity-40': !canSend }" data-testid="send" @click="sendDraft">
              <font-awesome-icon icon="paper-plane" />{{ $t('chat.send') }}
            </OyaButton>
          </div>
        </div>
      </template>
      <OyaEmptyState v-else class="flex-1" icon="users" size="lg">{{ starting ? $t('friends.starting') : $t('friends.pick') }}</OyaEmptyState>
    </section>

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

    <!-- me -->
    <OyaModal v-model:open="settings">
      <div class="w-[min(30rem,92vw)] space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <h2 class="text-lg font-bold">{{ $t('friends.settings') }}</h2>
        <label class="block text-sm">{{ $t('friends.yourName') }}
          <OyaTextField v-model="nameDraft" :maxlength="64" />
        </label>
        <label class="block text-sm">{{ $t('friends.proteus') }}
          <OyaTextField v-model="proteusDraft" :placeholder="$t('friends.proteusPlaceholder')" />
        </label>
        <p class="text-xs opacity-60">{{ $t('friends.proteusHelp') }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton type="button" @click="settings = false">{{ $t('friends.cancel') }}</OyaButton>
          <OyaButton type="button" data-testid="save-settings" @click="saveSettings">{{ $t('friends.save') }}</OyaButton>
        </div>
      </div>
    </OyaModal>
  </div>
</template>
