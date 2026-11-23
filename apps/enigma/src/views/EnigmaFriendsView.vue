<script setup lang="ts">
// Friends: pair with someone once, by scanning each other's code, and invite
// them to rooms with one tap afterwards (an invitation only their phone can open).
// The model and the pairing/check codes are in stores/friends.ts.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { formatDate } from "rakotis";
import { OyaAvatar, OyaButton, OyaCard, OyaCopyField, OyaModal, OyaQrCode, OyaTextField } from "petalite/primitives";
import QrScannerModal from "../components/chat/QrScannerModal.vue";
import { useChatStore } from "../stores/chat";
import {
  addFriend, checkCode, decodePairing, encodePairing, friends, loadFriends, removeFriend, type Friend,
} from "../stores/friends";

defineProps<{ darkMode?: boolean }>();
const { t } = useI18n();
const chat = useChatStore();

const myId = ref("");
const myName = computed(() => chat.p2p.currentUserName.value || "");
const myCode = computed(() => (myId.value ? encodePairing(myId.value, myName.value) : ""));

onMounted(async () => {
  myId.value = (await chat.p2p.deviceId()) ?? "";
  await loadFriends();
});

// ── adding a friend: scan or paste, then confirm ─────────────────────────────
const scanning = ref(false);
const pasted = ref("");
const addError = ref("");
const pending = ref<{ id: string; name: string; check: string } | null>(null);

async function consider(text: string) {
  addError.value = "";
  const got = decodePairing(text);
  if (!got) {
    addError.value = t("friends.notACode");
    return;
  }
  if (got.id === myId.value) {
    addError.value = t("friends.thatIsYou");
    return;
  }
  const known = friends.value.find((f) => f.id === got.id);
  pending.value = {
    id: got.id,
    name: got.name || known?.name || "",
    check: myId.value ? await checkCode(myId.value, got.id) : "",
  };
}

function onScanned(text: string) {
  scanning.value = false;
  void consider(text);
}

async function confirmAdd() {
  if (!pending.value) return;
  await addFriend(pending.value.id, pending.value.name);
  pending.value = null;
  pasted.value = "";
}

// ── the list ──────────────────────────────────────────────────────────────────
const openId = ref<string | null>(null);
const openCheck = ref("");
async function toggle(f: Friend) {
  if (openId.value === f.id) {
    openId.value = null;
    return;
  }
  openId.value = f.id;
  openCheck.value = myId.value ? await checkCode(myId.value, f.id) : "";
}
const removing = ref<Friend | null>(null);
async function confirmRemove() {
  if (removing.value) await removeFriend(removing.value.id);
  removing.value = null;
  openId.value = null;
}

function added(f: Friend): string {
  return formatDate(f.addedAt);
}
</script>

<template>
  <div class="mx-auto w-full max-w-xl space-y-4" data-testid="friends-view">
    <div>
      <h1 class="text-2xl font-bold">{{ $t("friends.title") }}</h1>
      <p class="mt-1 text-sm opacity-70">{{ $t("friends.intro") }}</p>
    </div>

    <!-- My code: what a friend scans. -->
    <OyaCard :padded="true" class="space-y-3" data-testid="my-pairing-code">
      <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
        {{ $t("friends.myCode") }}
      </p>
      <p class="text-sm opacity-70">{{ $t("friends.myCodeHint") }}</p>
      <template v-if="myCode">
        <OyaQrCode :value="myCode" :size="200" :alt="$t('friends.myCode')" />
        <p class="text-center text-sm font-semibold">{{ myName }}</p>
        <OyaCopyField :value="myCode" mono :copy-label="$t('chat.copy')" />
      </template>
      <p v-else class="text-sm opacity-60">…</p>
    </OyaCard>

    <!-- Add a friend -->
    <OyaCard :padded="true" class="space-y-3">
      <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
        {{ $t("friends.add") }}
      </p>
      <OyaButton class="w-full justify-center" data-testid="scan-friend" @click="scanning = true">
        <font-awesome-icon icon="camera" />{{ $t("friends.scan") }}
      </OyaButton>
      <div class="flex gap-2">
        <OyaTextField v-model="pasted" class="flex-1" mono :placeholder="$t('friends.paste')" data-testid="paste-friend" @enter="consider(pasted)" />
        <OyaButton variant="secondary" :disabled="!pasted.trim()" @click="consider(pasted)">{{ $t("friends.addButton") }}</OyaButton>
      </div>
      <p v-if="addError" class="text-xs text-warn-dark" data-testid="friend-error">{{ addError }}</p>
    </OyaCard>

    <!-- The list -->
    <div class="space-y-2" data-testid="friend-list">
      <p class="px-1 text-xs font-semibold uppercase tracking-wide opacity-60">
        {{ $t("friends.listTitle", { n: friends.length }) }}
      </p>
      <p v-if="!friends.length" class="rounded-xl border border-dashed border-current/20 p-4 text-center text-sm opacity-60">
        {{ $t("friends.none") }}
      </p>
      <div v-for="f in friends" :key="f.id" class="overflow-hidden rounded-xl border border-current/15">
        <button type="button" class="flex w-full items-center gap-3 p-3 text-left hover:bg-current/5" @click="toggle(f)">
          <OyaAvatar :name="f.name" size="sm" />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-semibold">{{ f.name }}</span>
            <span class="block truncate font-mono text-[11px] opacity-50">{{ f.id.slice(0, 16) }}…</span>
          </span>
          <font-awesome-icon :icon="openId === f.id ? 'chevron-up' : 'chevron-down'" class="opacity-50" />
        </button>
        <div v-if="openId === f.id" class="space-y-2 border-t border-current/10 p-3 text-sm">
          <p class="opacity-70">{{ $t("friends.pairedOn", { d: added(f) }) }}</p>
          <p class="opacity-70">{{ $t("friends.checkCodeIs") }}</p>
          <p class="font-mono text-xl tracking-widest" data-testid="friend-check">{{ openCheck }}</p>
          <button type="button" class="text-xs text-warn-dark underline" @click="removing = f">{{ $t("friends.remove") }}</button>
        </div>
      </div>
    </div>

    <QrScannerModal :open="scanning" @update:open="scanning = $event" @decoded="onScanned" />

    <!-- Confirm a new friend: name them, compare the check code. -->
    <OyaModal :open="!!pending" @close="pending = null">
      <div v-if="pending" class="w-full max-w-sm space-y-4 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark" data-testid="friend-confirm">
        <p class="text-lg font-bold">{{ $t("friends.confirmTitle") }}</p>
        <label class="block text-xs uppercase tracking-wide opacity-60">{{ $t("friends.name") }}</label>
        <OyaTextField v-model="pending.name" :placeholder="$t('friends.namePlaceholder')" />
        <div class="space-y-1 rounded-xl bg-current/5 p-3 text-center">
          <p class="text-xs opacity-70">{{ $t("friends.compare") }}</p>
          <p class="font-mono text-2xl tracking-widest" data-testid="pending-check">{{ pending.check }}</p>
        </div>
        <p class="text-xs opacity-60">{{ $t("friends.scanBack") }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="pending = null">{{ $t("chat.cancel") }}</OyaButton>
          <OyaButton :disabled="!pending.name.trim()" data-testid="friend-save" @click="confirmAdd">{{ $t("friends.save") }}</OyaButton>
        </div>
      </div>
    </OyaModal>

    <OyaModal :open="!!removing" @close="removing = null">
      <div v-if="removing" class="w-full max-w-sm space-y-4 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="font-semibold">{{ $t("friends.removeConfirm", { name: removing.name }) }}</p>
        <div class="flex justify-end gap-2">
          <OyaButton variant="secondary" @click="removing = null">{{ $t("chat.cancel") }}</OyaButton>
          <OyaButton @click="confirmRemove">{{ $t("friends.remove") }}</OyaButton>
        </div>
      </div>
    </OyaModal>
  </div>
</template>
