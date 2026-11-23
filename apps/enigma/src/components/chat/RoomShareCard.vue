<script setup lang="ts">
// The two ways to let somebody into a room, in one place.
//
// Used by BOTH "New chat" and "Room info" — they are the same "share this room"
// surface at two moments, and two copies of a selector is how two copies start
// disagreeing.
//
// There used to be a third: the permanent room ticket, which never expired, could
// not be withdrawn, and admitted anyone who photographed it. It is gone, and every
// room is invite-only, so both remaining modes are bounded credentials the issuer
// can revoke.
//
// ── what the two modes actually are ────────────────────────────────────────
//
// • A friend      one person · expires · revocable · one-use.
//                 Picked from Friends (stores/friends.ts) and sealed to their
//                 device key, so nobody else who photographs it can read it, and
//                 no decryption key travels with it. The one to reach for.
//
// • Share a code  anyone holding it · expires · revocable.
//                 A bearer credential in CLEARTEXT. There is no recipient to
//                 seal it to, so pretending it is secret would be theatre. It is
//                 the most exposing thing this card can do, and says so.
//
// The minted QR appears in this same card, directly under the controls that made it —
// there is no second screen to go and find it on.
//
// ── the constraint this card has to state ──────────────────────────────────
//
// An invitation is redeemed by connecting to the inviter, so it works only while
// the inviter is online AND has this room open — admission runs an MLS add whose
// commit has to reach the existing members over this room's transport. People
// will not guess that, so the card says it rather than leaving it to be
// discovered as a timeout.

import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { invoke, isTauri } from "rakotis";
import { OyaAvatar, OyaCopyField, OyaQrCode } from "petalite/primitives";
import { friends, loadFriends } from "../../stores/friends";

const props = defineProps<{
  roomSlug: string;
  roomName: string;
}>();

const { t } = useI18n({ useScope: "global" });

type ShareMode = "personal" | "general";
// Private first: it is the narrower credential, and the one to reach for.
const mode = ref<ShareMode>("personal");

// ── invitation form ─────────────────────────────────────────────────────────

const friendId = ref(""); // the chosen friend's device id
const router = useRouter();

/** Deadline presets, in seconds. "Never" is deliberately absent: an invitation
 *  that never expires is the permanent ticket again under a new name. */
const PRESETS = [
  { key: "invite.ttl1h", secs: 3600 },
  { key: "invite.ttl24h", secs: 86_400 },
  { key: "invite.ttl7d", secs: 7 * 86_400 },
];
const ttlSecs = ref(86_400);
const customHours = ref(12);
const useCustom = ref(false);
const effectiveTtl = computed(() =>
  useCustom.value ? Math.max(1, Math.round(customHours.value)) * 3600 : ttlSecs.value,
);

const busy = ref(false);
const error = ref("");
const minted = ref<{ ticket: string; expiresAt: number; kind: string } | null>(null);

const chosenRecipient = computed(() => friendId.value);

const canCreate = computed(
  () => !busy.value && (mode.value === "general" || !!chosenRecipient.value),
);

// ── this room's invitations ─────────────────────────────────────────────────

interface InviteRow {
  id: string;
  kind: string;
  state: string;
  roomSlug: string;
  expiresAt: number;
  recipient: string | null;
}
const rows = ref<InviteRow[]>([]);

async function refreshRows() {
  if (!isTauri()) return;
  const all = await invoke<InviteRow[]>("invite_list").catch(() => [] as InviteRow[]);
  rows.value = all.filter((r) => r.roomSlug === props.roomSlug);
}

onMounted(async () => {
  await Promise.all([refreshRows(), loadFriends()]);
});

// Switching mode drops a minted code: it belongs to the mode that made it, and
// leaving it on screen under a different heading would misdescribe it.
watch(mode, () => {
  minted.value = null;
  error.value = "";
});

async function createInvite() {
  if (!canCreate.value) return;
  const kind = mode.value;
  busy.value = true;
  error.value = "";
  try {
    const res = await invoke<{ ticket: string; expiresAt: number; kind: string }>("invite_create", {
      roomSlug: props.roomSlug,
      roomName: props.roomName,
      kind,
      recipient: kind === "personal" ? chosenRecipient.value : null,
      ttlSecs: effectiveTtl.value,
    });
    minted.value = res;
    await refreshRows();
  } catch (e) {
    error.value = typeof e === "string" ? e : ((e as Error).message ?? "");
  } finally {
    busy.value = false;
  }
}

async function revoke(id: string) {
  await invoke<boolean>("invite_revoke", { inviteId: id }).catch(() => false);
  if (minted.value && rows.value.find((r) => r.id === id)) minted.value = null;
  await refreshRows();
}

function remaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return t("invite.expired");
  const h = Math.floor(ms / 3_600_000);
  // The count is passed POSITIONALLY, which is what selects a plural form; passing
  // it as { n } interpolates the number but always picks the first form, so English
  // read "1 days" and Polish could never reach its third form at all.
  if (h >= 24) return t("invite.inDays", Math.floor(h / 24));
  if (h >= 1) return t("invite.inHours", h);
  return t("invite.inMinutes", Math.max(1, Math.floor(ms / 60_000)));
}

const MODES: { id: ShareMode; label: string; icon: string }[] = [
  { id: "personal", label: "invite.modePersonal", icon: "user-lock" },
  { id: "general", label: "invite.modeGeneral", icon: "share-nodes" },
];
</script>

<template>
  <div class="space-y-3" data-testid="room-share">
    <!-- Segmented pills, the EnigmaFilesView idiom; two fit a phone with labels. -->
    <div class="flex gap-1 overflow-x-auto rounded-xl border border-current/20 p-1 text-xs font-semibold">
      <button
        v-for="m in MODES"
        :key="m.id"
        type="button"
        :class="mode === m.id
          ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
          : 'opacity-60 hover:opacity-100'"
        class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 transition"
        :data-testid="`share-mode-${m.id}`"
        @click="mode = m.id"
      >
        <font-awesome-icon :icon="m.icon" /><span class="truncate">{{ $t(m.label) }}</span>
      </button>
    </div>

    <!-- One line on what this mode actually means, before the tap. -->
    <p class="text-[11px] leading-relaxed opacity-70" data-testid="share-consequence">
      {{ $t(`invite.consequence.${mode}`) }}
    </p>

    <p
      v-if="mode === 'general'"
      class="rounded-lg border border-warn-light/50 bg-warn-light/10 p-2.5 text-[11px] leading-relaxed dark:border-warn-dark/50 dark:bg-warn-dark/10"
      data-testid="share-bearer-warning"
    >
      <font-awesome-icon icon="triangle-exclamation" class="mr-1" />{{ $t("invite.bearerWarning") }}
    </p>

    <!-- ── mint, and then show what was minted, right here ──────────────── -->
    <template v-if="!minted">
        <!-- Recipient, private mode only. A bearer invite binds to nobody —
             that IS the difference — so it has no picker at all. -->
        <template v-if="mode === 'personal'">
          <label class="block text-[10px] uppercase tracking-wide opacity-50">
            {{ $t("invite.pickFriend") }}
          </label>
          <div v-if="friends.length" class="max-h-48 space-y-1 overflow-y-auto" data-testid="invite-friends">
            <button
              v-for="f in friends"
              :key="f.id"
              type="button"
              :class="friendId === f.id ? 'border-accent-light bg-accent-light/10 dark:border-accent-dark dark:bg-accent-dark/10' : 'border-current/15 hover:bg-current/5'"
              class="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm"
              :data-testid="`invite-friend-${f.id.slice(0, 8)}`"
              @click="friendId = f.id"
            >
              <OyaAvatar :name="f.name" size="sm" />
              <span class="min-w-0 flex-1 truncate">{{ f.name }}</span>
              <font-awesome-icon v-if="friendId === f.id" icon="check" />
            </button>
          </div>
          <div v-else class="space-y-2 rounded-lg border border-dashed border-current/20 p-3 text-xs" data-testid="invite-no-friends">
            <p class="opacity-70">{{ $t("invite.noFriends") }}</p>
            <button type="button" class="font-semibold underline" @click="router.push('/friends')">{{ $t("invite.goPair") }}</button>
          </div>
        </template>

        <!-- Deadline. Every invitation has one — that is the whole difference
             between this and the permanent ticket it replaced. -->
        <label class="block text-[10px] uppercase tracking-wide opacity-50">
          {{ $t("invite.expiresIn") }}
        </label>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="p in PRESETS"
            :key="p.secs"
            type="button"
            :class="!useCustom && ttlSecs === p.secs
              ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
              : 'border border-current/25 opacity-70 hover:opacity-100'"
            class="rounded-lg px-2.5 py-1 text-xs font-semibold transition"
            :data-testid="`invite-ttl-${p.secs}`"
            @click="useCustom = false; ttlSecs = p.secs"
          >
            {{ $t(p.key) }}
          </button>
          <button
            type="button"
            :class="useCustom
              ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
              : 'border border-current/25 opacity-70 hover:opacity-100'"
            class="rounded-lg px-2.5 py-1 text-xs font-semibold transition"
            data-testid="invite-ttl-custom"
            @click="useCustom = true"
          >
            {{ $t("invite.ttlCustom") }}
          </button>
          <input
            v-if="useCustom"
            v-model.number="customHours"
            type="number"
            min="1"
            max="720"
            class="w-20 rounded-lg border border-current/25 bg-transparent px-2 py-1 text-right text-xs"
            :aria-label="$t('invite.ttlCustomHours')"
            data-testid="invite-ttl-hours"
          />
        </div>

        <p class="text-[11px] leading-relaxed opacity-60" data-testid="invite-room-open">
          <font-awesome-icon icon="circle-info" class="mr-1" />{{ $t("invite.keepRoomOpen") }}
        </p>

        <button
          type="button"
          :disabled="!canCreate"
          class="flex w-full items-center justify-center gap-2 rounded-lg border border-current/25 px-3 py-2 text-sm font-semibold transition hover:opacity-100 disabled:opacity-40"
          data-testid="invite-create"
          @click="createInvite()"
        >
          <font-awesome-icon :icon="busy ? 'spinner' : 'qrcode'" :spin="busy" />
          {{ $t("invite.create") }}
        </button>
        <p v-if="error" class="text-xs text-warn-dark" data-testid="invite-error">{{ error }}</p>
      </template>

      <!-- The minted code -->
      <template v-else>
        <OyaQrCode :value="minted.ticket" :size="176" :alt="$t('chat.a11yInviteQr')" />
        <p class="text-center text-[10px] opacity-50" data-testid="invite-countdown">
          {{ $t("invite.validFor", { t: remaining(minted.expiresAt) }) }}
        </p>
        <OyaCopyField :value="minted.ticket" mono :copy-label="$t('chat.copy')" />
        <button
          type="button"
          class="text-[11px] underline opacity-70 transition hover:opacity-100"
          data-testid="invite-another"
          @click="minted = null"
        >
          {{ $t("invite.another") }}
        </button>
      </template>

      <!-- This room's invitations, so a live bearer code is never invisible. -->
      <template v-if="rows.length">
        <p class="border-t border-current/10 pt-2 text-[10px] uppercase tracking-wide opacity-50">
          {{ $t("invite.listTitle") }}
        </p>
        <ul class="flex flex-col divide-y divide-current/10" data-testid="invite-list">
          <li
            v-for="r in rows"
            :key="r.id"
            class="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs"
          >
            <span class="flex min-w-0 flex-col">
              <span class="truncate font-semibold">
                {{ $t(r.kind === "personal" ? "invite.modePersonal" : "invite.modeGeneral") }}
              </span>
              <span class="opacity-60">
                {{ $t(`invite.state.${r.state}`) }}
                <template v-if="r.state === 'active'"> · {{ remaining(r.expiresAt) }}</template>
              </span>
            </span>
            <button
              v-if="r.state === 'active' || r.state === 'inflight'"
              type="button"
              class="shrink-0 rounded-lg border border-warn-dark/50 px-2 py-1 font-semibold text-warn-dark transition hover:bg-warn-dark/10"
              :data-testid="`invite-revoke-${r.id}`"
              @click="revoke(r.id)"
            >
              {{ $t("invite.revoke") }}
            </button>
          </li>
        </ul>
      </template>
  </div>
</template>
