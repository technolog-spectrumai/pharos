<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useChatStore } from "../stores/chat";
import type { ChatChannel } from "rakotis";

import { OyaButton } from "euclid";
import ChatBubble from "./ChatBubble.vue";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const props = defineProps<{ darkMode: boolean; channel: ChatChannel }>();

const router = useRouter();
const store = useChatStore();

// The channel's refs are stable for this panel's lifetime — destructure for the
// template (auto-unwrap). Actions are called via `channel.*`.
const channel = props.channel;
const {
  kind,
  rooms, currentRoom, messages, participants,
  wsStatus, loadingRooms, error, isConnected,
  mlsStatus, mlsError, isEncrypted, isParticipant, p2pRooms,
} = channel;

const isRelay = kind === "relay";

function forceResetMls() { return channel.forceResetMls(); }
function onJoinP2p(ticket: string) { void store.acceptP2pInvite(ticket); }
function onJoinP2pAuto(name: string) { void store.acceptP2pAutoJoin(name); }

const draft = ref("");
const messagesEl = ref<HTMLElement | null>(null);
const sidebarOpen = ref(false);
const emojiPickerOpen = ref(false);
const emojiTab = ref(0);

const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  { label: "😊", emojis: ["😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥸","🤩","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🫣","🤭","🫡","🤫","🤥","😶","😐","😑","😬","🫠","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🥴","🤢","🤮","🤧","😷","🤒","🤕"] },
  { label: "👍", emojis: ["👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","🫵","👍","👎","✊","👊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾","🦿","🦵","🦶","👂","🦻","👃","🫀","🫁","🧠","🦷","🦴","👀","👁️","👅","👄","🫦"] },
  { label: "❤️", emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️‍🔥","❤️‍🩹","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☯️","🕊️","🌈","⭐","🌟","💫","✨","🔥","🎉","🎊","🎈","🎁","🏆","🥇","🎯","💯","✅","❌","⚠️","💬","💭","🗯️"] },
  { label: "🐶", emojis: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🪱","🐛","🦋","🐌","🐞","🐜","🪲","🦟","🦗","🪳","🕷️","🦂","🐢","🐍","🦎","🦖","🐙","🦑","🦐","🦞","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🦭","🐅","🐆","🦓","🦍","🦧","🐘","🦛","🦏","🐪","🐫","🦒","🦘","🦬","🐃","🐂","🐄","🐎","🐖","🐏","🐑","🦙","🐐","🦌","🐕","🐩","🦮","🐈","🐓","🦃","🦤","🦚","🦜","🦢","🕊️","🐇","🦝","🦨","🦡","🦦","🦥","🐁","🐀","🐿️","🦔"] },
  { label: "🍎", emojis: ["🍎","🍊","🍋","🍇","🍓","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🫐","🫒","🌽","🥕","🧄","🧅","🥦","🥬","🫑","🌶️","🥒","🥗","🥘","🫕","🍲","🍜","🍝","🍛","🍣","🍱","🍤","🍙","🍚","🍘","🧆","🍢","🍡","🍧","🍦","🍰","🎂","🧁","🍮","🍭","🍬","🍫","🍿","🍩","🍪","☕","🫖","🧋","🥤","🧃","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🧉","🍾"] },
  { label: "🚀", emojis: ["🚀","✈️","🚁","🚂","🚃","🚄","🚅","🚆","🚇","🚈","🚉","🚊","🚝","🚞","🚋","🚌","🚍","🚎","🏎️","🚐","🚑","🚒","🚓","🚔","🚕","🚖","🚗","🚘","🚙","🛻","🚚","🚛","🚜","🏍️","🛵","🚲","🛴","🛹","🛼","🚏","🛣️","🏖️","🏝️","🏔️","🗻","🏕️","🏜️","🏟️","🏛️","🏗️","🏘️","🏙️","🏚️","🏠","🏡","🏢","🏣","🏤","🏥","🏦","🏨","🏩","🏪","🏫","🏬","🏭","🏯","🏰","💒","🗼","🗽","⛪","🕌","🛕","🕍","⛩️","🌍","🌎","🌏","🌐","🗺️"] },
];

function insertEmoji(emoji: string) {
  draft.value += emoji;
  emojiPickerOpen.value = false;
}
const joiningOrLeaving = ref(false);
const imageFileInput = ref<HTMLInputElement | null>(null);
const uploadingImage = ref(false);
const uploadProgress = ref(0);

// ── Staged attachment (image/voice) — sent only on Send ───────────────────────
interface PendingAttachment { kind: "image" | "voice"; data: File | Blob; url: string; label: string }
const pending = ref<PendingAttachment | null>(null);

function clearPending() {
  if (pending.value) { URL.revokeObjectURL(pending.value.url); pending.value = null; }
}
onUnmounted(() => { clearPending(); void stopP2pScan(); });

function stagePending(k: "image" | "voice", data: File | Blob, label: string) {
  clearPending();
  pending.value = { kind: k, data, url: URL.createObjectURL(data), label };
}

// ── Voice recording ───────────────────────────────────────────────────────────
const isRecording = ref(false);
const recordingSeconds = ref(0);
let mediaRecorder: MediaRecorder | null = null;
let recordingChunks: Blob[] = [];
let recordingInterval: ReturnType<typeof setInterval> | null = null;

function pickAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}
function stopTimer() {
  if (recordingInterval) { clearInterval(recordingInterval); recordingInterval = null; }
}

async function toggleVoiceRecording() {
  if (isRecording.value) {
    if (_isTauri()) {
      stopTimer();
      isRecording.value = false;
      try {
        const bytes: number[] = await _invoke("audio_stop_recording");
        if (bytes.length > 0 && currentRoom.value) {
          const blob = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
          stagePending("voice", blob, `Voice message · ${recordingLabel()}`);
        }
      } catch (e) { console.error("[voice] stop failed:", e); }
    } else {
      mediaRecorder?.stop();
    }
    return;
  }
  if (!currentRoom.value) return;
  try {
    recordingSeconds.value = 0;
    if (_isTauri()) {
      await _invoke("audio_start_recording");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunks = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) recordingChunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        stopTimer();
        isRecording.value = false;
        if (recordingChunks.length === 0 || !currentRoom.value) return;
        const blob = new Blob(recordingChunks, { type: mr.mimeType || mimeType || "audio/webm" });
        stagePending("voice", blob, `Voice message · ${recordingLabel()}`);
      };
      mr.start();
      mediaRecorder = mr;
    }
    isRecording.value = true;
    recordingInterval = setInterval(() => { recordingSeconds.value++; }, 1000);
  } catch (e) {
    console.error("[voice] recording failed:", e);
  }
}

function recordingLabel() {
  const m = Math.floor(recordingSeconds.value / 60);
  const s = recordingSeconds.value % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

onMounted(() => {
  if (isRelay) {
    if (!rooms.value.length) channel.fetchRooms();
  } else {
    channel.loadP2pRooms();
  }
});

// ── P2P rooms (iroh) ──────────────────────────────────────────────────────────
const p2pName = ref("");
const p2pTicket = ref("");
const createdTicket = ref("");
const ticketCopied = ref(false);

async function createP2pRoom() {
  const name = p2pName.value.trim();
  if (!name) return;
  const ticket = await channel.createRoom(name);
  if (ticket) { createdTicket.value = ticket; p2pName.value = ""; }
}
async function joinP2pRoom() {
  const ticket = p2pTicket.value.trim();
  if (!ticket) return;
  await channel.joinByTicket(ticket);
  p2pTicket.value = "";
}
async function copyTicket(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    ticketCopied.value = true;
    setTimeout(() => (ticketCopied.value = false), 1500);
  } catch { /* clipboard unavailable */ }
}

// QR of the created ticket
const qrDataUrl = ref("");
watch(createdTicket, async (ticket) => {
  if (!ticket) { qrDataUrl.value = ""; return; }
  try {
    const { toDataURL } = await import("qrcode");
    qrDataUrl.value = await toDataURL(ticket, { errorCorrectionLevel: "L", margin: 1, width: 240 });
  } catch { qrDataUrl.value = ""; }
});

// Join by scanning a QR (camera)
const scanningP2p = ref(false);
const scanP2pError = ref(""); // i18n key
let p2pScanner: any = null;

async function startP2pScan() {
  scanP2pError.value = "";
  scanningP2p.value = true;
  await nextTick();
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    p2pScanner = new Html5Qrcode("p2p-qr-region");
    await p2pScanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 220, height: 220 } },
      (decoded: string) => { p2pTicket.value = decoded.trim(); void stopP2pScan(); void joinP2pRoom(); },
      () => {},
    );
  } catch {
    scanP2pError.value = "chat.cameraDenied";
    scanningP2p.value = false;
    p2pScanner = null;
  }
}
async function stopP2pScan() {
  if (p2pScanner) { try { await p2pScanner.stop(); } catch { /* ignore */ } p2pScanner = null; }
  scanningP2p.value = false;
}

// Join by uploading a QR image
const p2pFileInput = ref<HTMLInputElement | null>(null);
async function scanP2pFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (p2pFileInput.value) p2pFileInput.value.value = "";
  if (!file) return;
  scanP2pError.value = "";
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    const reader = new Html5Qrcode("p2p-qr-file-region");
    const decoded: string = await reader.scanFile(file, false);
    try { await reader.clear(); } catch { /* ignore */ }
    p2pTicket.value = decoded.trim();
    await joinP2pRoom();
  } catch {
    scanP2pError.value = "chat.qrNotFound";
  }
}

watch(currentRoom, () => { sidebarOpen.value = false; });

function scrollToBottom() {
  nextTick(() => { if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight; });
}
watch(messages, scrollToBottom, { deep: true });

const canSend = computed(
  () => !!currentRoom.value && isConnected.value && isParticipant.value && mlsStatus.value === "ready" && (!!draft.value.trim() || !!pending.value),
);

async function send() {
  if (!canSend.value) return;
  const text = draft.value.trim();
  const att = pending.value;
  if (att) {
    pending.value = null;
    try {
      if (att.kind === "image") {
        uploadingImage.value = true; uploadProgress.value = 0;
        await channel.sendImage(att.data as File, (pct) => { uploadProgress.value = pct; });
      } else {
        await channel.sendAudio(att.data as Blob);
      }
    } finally {
      uploadingImage.value = false; uploadProgress.value = 0;
      URL.revokeObjectURL(att.url);
    }
  }
  if (text) { channel.sendMessage(text); draft.value = ""; }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
}

function handleImageFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (imageFileInput.value) imageFileInput.value.value = "";
  if (!file) return;
  stagePending("image", file, file.name);
}

async function handleJoin() {
  joiningOrLeaving.value = true;
  try { await channel.joinParticipant(); } finally { joiningOrLeaving.value = false; }
}
async function handleLeave() {
  joiningOrLeaving.value = true;
  try { await channel.leaveParticipant(); } finally { joiningOrLeaving.value = false; }
}

// ── status chips ──────────────────────────────────────────────────────────────
const wsLabel = computed(() => ({ connected: "Connected", connecting: "Connecting…", disconnected: "Offline", error: "Error" })[wsStatus.value] ?? wsStatus.value);
const wsChipClass = computed(() => {
  if (wsStatus.value === "connected") return "bg-success-dark text-primary-bg-dark border-success-dark";
  if (wsStatus.value === "connecting") return "border-current/20 animate-pulse";
  if (wsStatus.value === "error") return "bg-warn-dark text-primary-bg-dark border-warn-dark";
  return "border-current/20 opacity-60";
});
const mlsLabel = computed(() => ({ idle: "Not encrypted", initializing: "Initializing…", key_exchange: "Key exchange…", ready: "Encrypted", error: "Enc. error" })[mlsStatus.value] ?? mlsStatus.value);
const mlsChipClass = computed(() => {
  if (mlsStatus.value === "ready") return "bg-success-dark text-primary-bg-dark border-success-dark";
  if (mlsStatus.value === "initializing" || mlsStatus.value === "key_exchange") return "border-current/20 animate-pulse";
  if (mlsStatus.value === "error") return "bg-warn-dark text-primary-bg-dark border-warn-dark";
  return "border-current/20 opacity-50";
});
</script>

<template>
  <div
    class="grid h-full min-h-0 w-full gap-4 overflow-hidden lg:grid-cols-[16rem_minmax(0,1fr)_16rem]"
  >
    <!-- ── ROOMS sidebar desktop ───────────────────────────────────────────── -->
    <aside
      :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
      class="hidden min-h-0 flex-col overflow-hidden rounded-lg border shadow-md lg:flex"
    >
      <div class="flex items-center justify-between border-b border-current/10 p-4">
        <h2 class="text-sm font-bold">
          <font-awesome-icon icon="comments" class="mr-2" />Rooms
        </h2>
        <button class="text-xs underline opacity-70 hover:opacity-100" @click="router.push('/')">← Back</button>
      </div>

      <!-- P2P rooms (iroh) — P2P tab only -->
      <div v-if="!isRelay" class="space-y-2.5 border-b border-current/10 p-4">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-60">
          <font-awesome-icon icon="circle-nodes" class="mr-1" />{{ $t('chat.p2p') }}
        </p>

        <div class="flex gap-2">
          <input
            v-model="p2pName" type="text" :placeholder="$t('chat.newRoomName')"
            :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'"
            class="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none"
            @keyup.enter="createP2pRoom"
          />
          <button class="shrink-0 rounded-lg border border-current/20 px-2 py-1.5 text-xs font-semibold transition hover:opacity-80" @click="createP2pRoom">
            {{ $t('chat.create') }}
          </button>
        </div>

        <div v-if="createdTicket" class="space-y-1.5">
          <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t('chat.shareTicket') }}</p>
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="Room QR code" class="mx-auto h-44 w-44 rounded-lg bg-white p-2" />
          <p class="text-center text-[10px] opacity-50">{{ $t('chat.scanToJoin') }}</p>
          <div class="flex gap-2">
            <input :value="createdTicket" readonly class="min-w-0 flex-1 rounded-lg border border-current/15 bg-transparent px-2 py-1 font-mono text-[10px]" />
            <button class="shrink-0 rounded-lg border border-current/20 px-2 py-1 text-xs transition hover:opacity-80" @click="copyTicket(createdTicket)">
              {{ ticketCopied ? "✓" : $t('chat.copy') }}
            </button>
          </div>
        </div>

        <div class="flex gap-2">
          <input
            v-model="p2pTicket" type="text" :placeholder="$t('chat.pasteTicket')"
            :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'"
            class="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none"
            @keyup.enter="joinP2pRoom"
          />
          <button class="shrink-0 rounded-lg border border-current/20 px-2 py-1.5 text-xs font-semibold transition hover:opacity-80" @click="joinP2pRoom">
            {{ $t('chat.join') }}
          </button>
          <button class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs transition hover:opacity-80" :title="$t('chat.scanQr')" @click="scanningP2p ? stopP2pScan() : startP2pScan()">
            <font-awesome-icon :icon="scanningP2p ? 'xmark' : 'camera'" />
          </button>
          <button class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs transition hover:opacity-80" :title="$t('chat.uploadQr')" @click="p2pFileInput?.click()">
            <font-awesome-icon icon="image" />
          </button>
          <input ref="p2pFileInput" type="file" accept="image/*" class="hidden" @change="scanP2pFile" />
        </div>

        <div v-if="scanningP2p" class="space-y-1">
          <div id="p2p-qr-region" class="overflow-hidden rounded-lg border border-current/15"></div>
          <button class="text-xs underline opacity-70 hover:opacity-100" @click="stopP2pScan">{{ $t('common.cancel') }}</button>
        </div>
        <p v-if="scanP2pError" class="text-[10px] text-red-400">{{ $t(scanP2pError) }}</p>
        <div id="p2p-qr-file-region" class="hidden"></div>

        <div v-if="p2pRooms.length" class="space-y-1 pt-1">
          <button
            v-for="r in p2pRooms" :key="r.room"
            :class="currentRoom?.slug === r.room ? (darkMode ? 'bg-primary-bg-dark border-accent-dark' : 'bg-primary-bg-light border-accent-light') : 'border-current/15 hover:opacity-80'"
            class="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition"
            @click="channel.openP2pRoom(r)"
          >
            <font-awesome-icon icon="circle-nodes" class="shrink-0 opacity-60" />
            <span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
          </button>
        </div>
      </div>

      <div v-if="isRelay && loadingRooms" class="p-4 text-xs opacity-50">Loading…</div>
      <nav v-else-if="isRelay" class="flex-1 space-y-2 overflow-y-auto p-4 pr-3">
        <button
          v-for="room in rooms" :key="room.slug"
          :class="currentRoom?.slug === room.slug ? (darkMode ? 'bg-primary-bg-dark border-accent-dark' : 'bg-primary-bg-light border-accent-light') : (darkMode ? 'border-accent-1 hover:bg-primary-bg-dark' : 'border-accent-2 hover:bg-primary-bg-light')"
          class="w-full rounded-lg border px-3 py-3 text-left transition"
          @click="channel.joinRoom(room.slug)"
        >
          <span class="block truncate text-sm font-semibold">{{ room.name }}</span>
          <span class="mt-1 block text-xs opacity-60">{{ room.participant_count }} participant{{ room.participant_count === 1 ? "" : "s" }}</span>
        </button>
        <p v-if="!rooms.length" class="text-xs opacity-50">No rooms found.</p>
      </nav>
    </aside>

    <!-- ── CHATBOX ─────────────────────────────────────────────────────────── -->
    <section
      :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
      class="grid min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border shadow-md"
    >
      <header class="flex flex-col gap-3 border-b border-current/10 p-4">
        <div class="flex items-start gap-3">
          <button
            type="button" :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border lg:hidden"
            aria-label="Open rooms" @click="sidebarOpen = true"
          >
            <font-awesome-icon icon="bars" />
          </button>
          <div class="min-w-0 flex-1">
            <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
              {{ currentRoom ? "Active room" : "No room selected" }}
            </p>
            <h2 class="mt-1 break-words text-xl font-bold leading-tight sm:text-2xl">{{ currentRoom?.name ?? "Select a room" }}</h2>
            <div v-if="currentRoom" class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs opacity-70">
              <span>{{ currentRoom.participant_count }} participant{{ currentRoom.participant_count === 1 ? "" : "s" }}</span>
              <span>{{ isParticipant ? "Joined" : "Observer" }}</span>
            </div>
          </div>
        </div>

        <div v-if="currentRoom" class="hidden flex-wrap items-center gap-2 sm:flex">
          <template v-if="isParticipant">
            <!-- Fixed switch: jump to the other chat (Forum ⇄ P2P) -->
            <button
              v-if="isRelay"
              type="button"
              :class="darkMode ? 'border-accent-1 hover:opacity-100' : 'border-accent-2 hover:opacity-100'"
              class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold opacity-80 shadow-sm transition"
              :title="$t('chat.switchToP2pHint')"
              @click="store.switchToP2p()"
            >
              <font-awesome-icon icon="circle-nodes" />{{ $t('chat.switchToP2p') }}
            </button>
            <button
              v-else
              type="button"
              :class="darkMode ? 'border-accent-1 hover:opacity-100' : 'border-accent-2 hover:opacity-100'"
              class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold opacity-80 shadow-sm transition"
              :title="$t('chat.switchToRelayHint')"
              @click="store.switchToRelay()"
            >
              <font-awesome-icon icon="satellite-dish" />{{ $t('chat.switchToRelay') }}
            </button>

            <span :class="mlsChipClass" :title="mlsError ?? undefined" class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold shadow-sm transition">
              <font-awesome-icon :icon="isEncrypted ? 'lock' : 'lock-open'" />{{ mlsLabel }}
            </span>
            <span :class="wsChipClass" class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold shadow-sm transition">
              <font-awesome-icon :icon="wsStatus === 'connected' ? 'check' : 'xmark'" />{{ wsLabel }}
            </span>
            <button
              type="button"
              :class="(mlsStatus === 'key_exchange' || mlsStatus === 'error') ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20' : (darkMode ? 'border-accent-1 opacity-60 hover:opacity-100' : 'border-accent-2 opacity-60 hover:opacity-100')"
              class="inline-flex h-9 w-9 items-center justify-center rounded-lg border text-xs shadow-sm transition"
              title="Reset encryption session — clears history and renegotiates keys"
              @click="forceResetMls()"
            >
              <font-awesome-icon icon="rotate-right" />
            </button>
            <OyaButton :dark-mode="darkMode" variant="secondary" :class="{ 'opacity-60 pointer-events-none': joiningOrLeaving }" class="inline-flex" @click="handleLeave">
              <font-awesome-icon icon="right-from-bracket" />Leave
            </OyaButton>
          </template>

          <OyaButton v-else :dark-mode="darkMode" :class="{ 'opacity-60 pointer-events-none': joiningOrLeaving }" class="inline-flex" @click="handleJoin">
            <font-awesome-icon icon="right-to-bracket" />Join
          </OyaButton>
        </div>
      </header>

      <div v-if="currentRoom && !isParticipant" :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'" class="border-b px-4 py-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-sm opacity-75">You are observing. Join this room to send encrypted messages.</p>
          <OyaButton :dark-mode="darkMode" :class="{ 'opacity-60 pointer-events-none': joiningOrLeaving }" class="shrink-0" @click="handleJoin">
            <font-awesome-icon icon="right-to-bracket" />Join Room
          </OyaButton>
        </div>
      </div>

      <!-- Mobile status strip -->
      <div v-if="currentRoom && isParticipant" :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'" class="flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:hidden">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs font-bold transition hover:opacity-100"
          @click="isRelay ? store.switchToP2p() : store.switchToRelay()"
        >
          <font-awesome-icon :icon="isRelay ? 'circle-nodes' : 'satellite-dish'" />{{ isRelay ? $t('chat.switchToP2p') : $t('chat.switchToRelay') }}
        </button>
        <span :class="mlsChipClass" :title="mlsError ?? undefined" class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition">
          <font-awesome-icon :icon="isEncrypted ? 'lock' : 'lock-open'" />{{ mlsLabel }}
        </span>
        <span :class="wsChipClass" class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition">
          <font-awesome-icon :icon="wsStatus === 'connected' ? 'check' : 'xmark'" />{{ wsLabel }}
        </span>
        <button @click="forceResetMls()" :class="(mlsStatus === 'key_exchange' || mlsStatus === 'error') ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400' : 'border-current/20 opacity-60'" class="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition hover:opacity-100">
          <font-awesome-icon icon="rotate-right" />Reset
        </button>
        <button :class="{ 'opacity-60 pointer-events-none': joiningOrLeaving }" class="ml-auto text-xs underline opacity-70 hover:opacity-100" @click="handleLeave">Leave</button>
      </div>

      <div v-if="error" class="border-b border-warn-dark/30 bg-warn-dark/10 px-4 py-2 text-xs text-warn-dark">
        <font-awesome-icon icon="triangle-exclamation" class="mr-1" />{{ error }}
      </div>

      <!-- Messages -->
      <div ref="messagesEl" :class="darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light'" class="min-h-0 space-y-4 overflow-y-auto p-4">
        <div v-if="!currentRoom" class="flex h-full flex-col items-center justify-center gap-3 opacity-40">
          <font-awesome-icon icon="comments" class="text-4xl" />
          <p class="text-sm">Pick a room from the sidebar to start chatting.</p>
          <OyaButton :dark-mode="darkMode" class="mt-2 lg:hidden" @click="sidebarOpen = true">Select a room</OyaButton>
        </div>
        <ChatBubble
          v-for="msg in messages"
          :key="msg.id"
          :dark-mode="darkMode"
          :message="msg"
          @join-p2p="onJoinP2p"
          @join-p2p-auto="onJoinP2pAuto"
        />
      </div>

      <!-- Composer -->
      <div :class="darkMode ? 'bg-bubble-bg-dark' : 'bg-bubble-bg-light'" class="border-t border-current/10 p-4">
        <div v-if="pending" :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'" class="mb-2 flex items-center gap-3 rounded-lg border px-3 py-2">
          <img v-if="pending.kind === 'image'" :src="pending.url" alt="" class="h-12 w-12 shrink-0 rounded object-cover" />
          <audio v-else :src="pending.url" controls class="h-9 min-w-0 max-w-[220px]" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-semibold">{{ pending.kind === 'image' ? $t('chat.imageReady') : $t('chat.voiceReady') }}</p>
            <p class="truncate text-[11px] opacity-60">{{ pending.label }}</p>
          </div>
          <button type="button" class="shrink-0 rounded-lg border border-current/20 px-2.5 py-1.5 text-xs font-semibold transition hover:opacity-80" @click="clearPending">
            <font-awesome-icon icon="xmark" class="mr-1" />{{ $t('common.cancel') }}
          </button>
        </div>

        <div v-if="uploadingImage" class="mb-2 flex items-center gap-2 text-xs opacity-60">
          <span>Uploading…</span>
          <div class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-current/20">
            <div class="absolute left-0 top-0 h-full rounded-full bg-current transition-all duration-100" :style="{ width: uploadProgress + '%' }"></div>
          </div>
          <span>{{ uploadProgress }}%</span>
        </div>

        <div class="flex gap-3">
          <input ref="imageFileInput" type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden" @change="handleImageFile" />
          <button
            type="button" :disabled="!currentRoom || !isConnected || !isParticipant || uploadingImage"
            :class="[darkMode ? 'border-accent-1 text-text-main-dark' : 'border-accent-2 text-text-main-light', (!currentRoom || !isConnected || !isParticipant) ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80']"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition" title="Send image" @click="imageFileInput?.click()"
          >
            <font-awesome-icon :icon="uploadingImage ? 'spinner' : 'image'" :spin="uploadingImage" />
          </button>
          <button
            :disabled="!currentRoom || !isParticipant"
            :class="[isRecording ? 'border-red-500 text-red-500 animate-pulse' : (darkMode ? 'border-accent-1 text-text-main-dark' : 'border-accent-2 text-text-main-light'), (!currentRoom || !isParticipant) ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80']"
            class="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 transition"
            :title="isRecording ? 'Stop recording' : 'Record voice message'" @click="toggleVoiceRecording"
          >
            <font-awesome-icon :icon="isRecording ? 'stop' : 'microphone'" class="text-sm" />
            <span v-if="isRecording" class="text-xs font-mono">{{ recordingLabel() }}</span>
          </button>

          <div class="relative shrink-0">
            <button
              type="button" :disabled="!currentRoom || !isParticipant"
              :class="[darkMode ? 'border-accent-1 text-text-main-dark' : 'border-accent-2 text-text-main-light', (!currentRoom || !isParticipant) ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80', emojiPickerOpen ? (darkMode ? 'bg-primary-bg-dark' : 'bg-primary-bg-light') : '']"
              class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition text-lg" title="Emoji" @click="emojiPickerOpen = !emojiPickerOpen"
            >😊</button>
            <div v-if="emojiPickerOpen" class="fixed inset-0 z-40" @click="emojiPickerOpen = false" />
            <div v-if="emojiPickerOpen" :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'" class="absolute bottom-full mb-2 left-0 z-50 w-72 rounded-xl border shadow-xl overflow-hidden">
              <div :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'" class="flex border-b overflow-x-auto">
                <button v-for="(cat, i) in EMOJI_CATEGORIES" :key="i" @click="emojiTab = i" class="flex-shrink-0 px-3 py-2 text-base transition hover:opacity-80 border-b-2" :class="emojiTab === i ? (darkMode ? 'border-accent-dark' : 'border-accent-light') : 'border-transparent opacity-50'">{{ cat.label }}</button>
              </div>
              <div class="grid grid-cols-8 gap-0.5 p-2 h-44 overflow-y-auto">
                <button v-for="e in EMOJI_CATEGORIES[emojiTab].emojis" :key="e" @click="insertEmoji(e)" class="flex items-center justify-center rounded p-1 text-lg hover:opacity-80 transition leading-none" :class="darkMode ? 'hover:bg-white/10' : 'hover:bg-black/5'">{{ e }}</button>
              </div>
            </div>
          </div>

          <textarea
            v-model="draft" rows="1"
            :placeholder="!currentRoom ? 'Select a room to start chatting' : !isParticipant ? 'Join this room to send messages' : mlsStatus !== 'ready' ? 'Establishing secure session…' : isEncrypted ? 'Message (encrypted)…' : 'Message…'"
            :disabled="!currentRoom || !isConnected || !isParticipant || mlsStatus !== 'ready'"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30 disabled:opacity-30' : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30 disabled:opacity-30'"
            class="max-h-32 min-h-[3rem] flex-1 resize-none rounded-lg border px-3 py-2.5 text-sm outline-none transition" @keydown="onKeydown"
          />
          <OyaButton :dark-mode="darkMode" :type="'button'" :disabled="!canSend" :class="{ 'opacity-40 cursor-not-allowed': !canSend }" @click="send">
            <font-awesome-icon icon="paper-plane" />Send
          </OyaButton>
        </div>
      </div>
    </section>

    <!-- ── PARTICIPANTS sidebar desktop ────────────────────────────────────── -->
    <aside :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'" class="hidden min-h-0 flex-col overflow-hidden rounded-lg border shadow-md lg:flex">
      <div class="border-b border-current/10 p-4">
        <h2 :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-lg font-bold">
          <font-awesome-icon icon="user" class="mr-2" />Participants
        </h2>
      </div>
      <div class="flex-1 space-y-3 overflow-y-auto p-4 pr-3">
        <div v-for="p in participants" :key="p.id ?? p.name" class="flex items-center gap-3">
          <div :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-bold">
            <img v-if="p.avatar_url" :src="p.avatar_url" :alt="p.name" class="h-full w-full object-cover" />
            <span v-else>{{ p.name.slice(0, 2).toUpperCase() }}</span>
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ p.name }}</p>
            <p class="text-xs opacity-60">Human</p>
          </div>
          <span :class="darkMode ? 'bg-success-dark text-primary-bg-dark' : 'bg-success-light text-primary-bg-light'" class="rounded-full px-2 py-0.5 text-xs font-bold">On</span>
        </div>
        <p v-if="!participants.length" class="text-xs opacity-40">No participants yet.</p>
      </div>
    </aside>

    <!-- ── Mobile sidebar overlay ───────────────────────────────────────────── -->
    <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition-opacity duration-200" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <div v-if="sidebarOpen" class="fixed inset-0 z-40 bg-black/40 lg:hidden" @click="sidebarOpen = false" />
    </Transition>
    <Transition enter-active-class="transition-transform duration-200" enter-from-class="-translate-x-full" enter-to-class="translate-x-0" leave-active-class="transition-transform duration-200" leave-from-class="translate-x-0" leave-to-class="-translate-x-full">
      <aside v-if="sidebarOpen" :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'" class="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r p-4 shadow-xl lg:hidden">
        <div class="flex items-center justify-between border-b border-current/10 pb-3">
          <span class="text-sm font-bold">Rooms</span>
          <button type="button" :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="flex h-9 w-9 items-center justify-center rounded-lg border" aria-label="Close rooms" @click="sidebarOpen = false">
            <font-awesome-icon icon="xmark" />
          </button>
        </div>

        <!-- P2P controls (mobile, P2P tab) -->
        <div v-if="!isRelay" class="mt-4 space-y-2">
          <div class="flex gap-2">
            <input v-model="p2pName" type="text" :placeholder="$t('chat.newRoomName')" :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'" class="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none" @keyup.enter="createP2pRoom" />
            <button class="shrink-0 rounded-lg border border-current/20 px-2 py-1.5 text-xs font-semibold" @click="createP2pRoom">{{ $t('chat.create') }}</button>
          </div>
          <div class="flex gap-2">
            <input v-model="p2pTicket" type="text" :placeholder="$t('chat.pasteTicket')" :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'" class="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none" @keyup.enter="joinP2pRoom" />
            <button class="shrink-0 rounded-lg border border-current/20 px-2 py-1.5 text-xs font-semibold" @click="joinP2pRoom">{{ $t('chat.join') }}</button>
          </div>
          <button
            v-for="r in p2pRooms" :key="r.room"
            :class="currentRoom?.slug === r.room ? (darkMode ? 'bg-primary-bg-dark border-accent-dark' : 'bg-primary-bg-light border-accent-light') : 'border-current/15'"
            class="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm"
            @click="channel.openP2pRoom(r)"
          >
            <font-awesome-icon icon="circle-nodes" class="shrink-0 opacity-60" /><span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
          </button>
        </div>

        <template v-else>
          <div v-if="loadingRooms" class="mt-4 text-xs opacity-50">Loading…</div>
          <nav v-else class="mt-4 flex-1 space-y-2 overflow-y-auto">
            <button
              v-for="room in rooms" :key="room.slug"
              :class="currentRoom?.slug === room.slug ? (darkMode ? 'bg-primary-bg-dark border-accent-dark' : 'bg-primary-bg-light border-accent-light') : (darkMode ? 'border-accent-1 hover:bg-primary-bg-dark' : 'border-accent-2 hover:bg-primary-bg-light')"
              class="w-full rounded-lg border px-3 py-3 text-left transition" @click="channel.joinRoom(room.slug)"
            >
              <span class="block truncate text-sm font-semibold">{{ room.name }}</span>
              <span class="mt-1 block text-xs opacity-60">{{ room.participant_count }} participant{{ room.participant_count === 1 ? "" : "s" }}</span>
            </button>
            <p v-if="!rooms.length" class="text-xs opacity-50">No rooms found.</p>
          </nav>
        </template>

        <div class="mt-4 border-t border-current/10 pt-4">
          <div class="flex items-center justify-between">
            <span class="text-sm font-bold">Participants</span>
            <span class="text-xs opacity-60">{{ participants.length }}</span>
          </div>
          <div class="mt-3 space-y-3">
            <div v-for="p in participants" :key="p.id ?? p.name" class="flex items-center gap-3">
              <div :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-bold">
                <img v-if="p.avatar_url" :src="p.avatar_url" :alt="p.name" class="h-full w-full object-cover" />
                <span v-else>{{ p.name.slice(0, 2).toUpperCase() }}</span>
              </div>
              <p class="min-w-0 flex-1 truncate text-sm font-semibold">{{ p.name }}</p>
            </div>
            <p v-if="!participants.length" class="text-sm opacity-60">No participants.</p>
          </div>
        </div>

        <div v-if="currentRoom" class="mt-4 border-t border-current/10 pt-4">
          <OyaButton v-if="!isParticipant" :dark-mode="darkMode" :class="{ 'opacity-60 pointer-events-none': joiningOrLeaving }" class="w-full" @click="handleJoin">
            <font-awesome-icon icon="right-to-bracket" />Join Room
          </OyaButton>
          <OyaButton v-else :dark-mode="darkMode" variant="secondary" :class="{ 'opacity-60 pointer-events-none': joiningOrLeaving }" class="w-full" @click="handleLeave">
            <font-awesome-icon icon="right-from-bracket" />Leave Room
          </OyaButton>
        </div>
      </aside>
    </Transition>

  </div>
</template>
