<script setup lang="ts">
// The three ways to let somebody into a room, in one place.
//
// Used by BOTH "New chat" and "Room info" — they are the same "share this room"
// surface at two moments, and two copies of a three-way selector is how two
// copies start disagreeing.
//
// ── what the three modes actually are ──────────────────────────────────────
//
// • Room ticket   permanent · anyone who sees it · cannot be revoked.
//                 The original mechanism. Carries the plaintext room name and
//                 the creator's address (technology.md §8). Charged on COPY,
//                 because the ticket already exists and sharing it is the act.
//
// • Private QR    one person · expires · revocable · one-use.
//                 Sealed to a contact's public key, so nobody else who
//                 photographs it can read it — and no decryption key travels
//                 with it. The cheap option, and the one to reach for.
//
// • Shareable QR  anyone holding it · expires · revocable.
//                 A bearer credential in CLEARTEXT. There is no recipient to
//                 seal it to, so pretending it is secret would be theatre. It
//                 is priced level with a room ticket and always confirms.
//
// The two invitation modes are charged at CREATION rather than on copy: minting
// is what brings the credential into existence, and copying it again exposes
// nothing further.
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
import {
  OyaCopyField,
  OyaHpPrice,
  OyaQrCode,
  OyaTextField,
  formatHp,
  getBuildConfig,
  invoke,
  isTauri,
  isTorTicket,
  listContacts,
  ticketActionId,
  inviteActionId,
  type ContactEntry,
} from "rakotis";
import { chargeHp, confirmHp, creditFor, explainFor, priceFor, recoverHp } from "../hp/useHp";

const props = defineProps<{
  roomSlug: string;
  roomName: string;
  /** The room ticket — the existing, permanent share mechanism. */
  ticket: string;
  /** DHT room code, when this room has one. */
  code?: string;
  /** Whether the room runs over Tor. Decides which price variant applies. */
  tor?: boolean;
  /** Invite-only: gossip key packages are refused, so the room ticket puts
   *  someone on the topic but never into the group. The ticket mode is withdrawn
   *  rather than left on offer — handing out something that silently does not
   *  work reads as a bug, not as a policy. */
  inviteOnly?: boolean;
}>();

const { t } = useI18n({ useScope: "global" });

type ShareMode = "ticket" | "personal" | "general";
// A closed room has no ticket to open on, and the flag can be flipped while this
// card is on screen — so the mode follows it rather than being chosen once.
const mode = ref<ShareMode>(props.inviteOnly ? "personal" : "ticket");

// ── invitation form ─────────────────────────────────────────────────────────

const contacts = ref<ContactEntry[]>([]);
const recipient = ref(""); // NodeId
const pasted = ref("");
const usePaste = ref(false);

/** Deadline presets, in seconds. "Never" is deliberately absent — the unbounded
 *  credential already exists and is called a room ticket. */
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

/** Contacts can be compiled out, and a fresh profile has none. Neither may be a
 *  dead end, so the paste field is always reachable. */
const contactsEnabled = getBuildConfig().contacts_enabled;
const chosenRecipient = computed(() => (usePaste.value ? pasted.value.trim() : recipient.value));

const priceCenti = computed(() =>
  mode.value === "ticket"
    ? priceFor(ticketActionId(isTorTicket(props.ticket)))
    : priceFor(inviteActionId(mode.value === "personal" ? "personal" : "general", !!props.tor)),
);
const priceExplain = computed(() =>
  mode.value === "ticket"
    ? explainFor(ticketActionId(isTorTicket(props.ticket)))
    : explainFor(inviteActionId(mode.value === "personal" ? "personal" : "general", !!props.tor)),
);

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
  if (contactsEnabled) contacts.value = await listContacts().catch(() => []);
  usePaste.value = !contactsEnabled || contacts.value.length === 0;
  await refreshRows();
});

// Switching mode drops a minted code: it belongs to the mode that made it, and
// leaving it on screen under a different heading would misdescribe it.
watch(mode, () => {
  minted.value = null;
  error.value = "";
});

// The captain can close the room while this card is open. Leaving the user on a
// ticket that no longer admits anyone would be the exact failure this stage
// exists to prevent.
watch(
  () => props.inviteOnly,
  (closed) => {
    if (closed && mode.value === "ticket") mode.value = "personal";
  },
);

async function createInvite() {
  if (!canCreate.value) return;
  const kind = mode.value === "personal" ? "personal" : "general";
  const action = inviteActionId(kind, !!props.tor);
  // Confirmed BEFORE minting. A bearer invite is ≥10 HP, so this always asks and
  // carries the warning; a private one never interrupts.
  if (!(await confirmHp(action))) return;

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
    // Charged only once the credential actually exists.
    await chargeHp(action);
    await refreshRows();
  } catch (e) {
    error.value = typeof e === "string" ? e : ((e as Error).message ?? "");
  } finally {
    busy.value = false;
  }
}

async function revoke(id: string) {
  // The command answers whether a record really moved from live to revoked —
  // that boolean IS the verified state change the credit is tied to, so
  // revoking something already spent or expired earns nothing.
  const moved = await invoke<boolean>("invite_revoke", { inviteId: id }).catch(() => false);
  if (moved) await recoverHp("invite.revoke");
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

const ALL_MODES: { id: ShareMode; label: string; icon: string }[] = [
  { id: "ticket", label: "invite.modeTicket", icon: "ticket" },
  { id: "personal", label: "invite.modePersonal", icon: "user-lock" },
  { id: "general", label: "invite.modeGeneral", icon: "share-nodes" },
];

/** A closed room offers invitations only. */
const MODES = computed(() =>
  props.inviteOnly ? ALL_MODES.filter((m) => m.id !== "ticket") : ALL_MODES,
);
</script>

<template>
  <div class="space-y-3" data-testid="room-share">
    <!-- Segmented pills, the EnigmaFilesView idiom. Labels drop below `sm` so
         three fit a phone; the icons carry the meaning there. -->
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
        <font-awesome-icon :icon="m.icon" /><span class="hidden truncate sm:inline">{{ $t(m.label) }}</span>
      </button>
    </div>

    <!-- Said before the pills, because it explains why one of them is missing. -->
    <p
      v-if="inviteOnly"
      class="rounded-lg border border-accent-1/40 bg-accent-1/10 p-2.5 text-[11px] leading-relaxed"
      data-testid="share-invite-only"
    >
      <font-awesome-icon icon="lock" class="mr-1" />{{ $t("invite.closedNotice") }}
    </p>

    <!-- One line on what this mode actually means, plus its price. The
         consequence and the cost belong together, before the tap. -->
    <div class="flex flex-wrap items-start justify-between gap-2">
      <p class="min-w-0 flex-1 text-[11px] leading-relaxed opacity-70" data-testid="share-consequence">
        {{ $t(`invite.consequence.${mode}`) }}
      </p>
      <OyaHpPrice :centi="priceCenti" :explain="priceExplain" data-testid="share-price" />
    </div>

    <p
      v-if="mode === 'general'"
      class="rounded-lg border border-warn-light/50 bg-warn-light/10 p-2.5 text-[11px] leading-relaxed dark:border-warn-dark/50 dark:bg-warn-dark/10"
      data-testid="share-bearer-warning"
    >
      <font-awesome-icon icon="triangle-exclamation" class="mr-1" />{{ $t("invite.bearerWarning") }}
    </p>

    <!-- ── the room ticket ──────────────────────────────────────────────── -->
    <template v-if="mode === 'ticket'">
      <OyaQrCode :value="ticket" :size="176" :alt="$t('chat.a11yRoomQr')" />
      <p class="text-center text-[10px] opacity-50">{{ $t("chat.scanToJoin") }}</p>
      <OyaCopyField
        :value="ticket"
        mono
        :copy-label="$t('chat.copy')"
        @copied="chargeHp(ticketActionId(isTorTicket(ticket)))"
      />
      <template v-if="code">
        <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.shareCode") }}</p>
        <OyaCopyField :value="code" mono :copy-label="$t('chat.copy')" />
      </template>
    </template>

    <!-- ── an invitation ────────────────────────────────────────────────── -->
    <template v-else>
      <template v-if="!minted">
        <!-- Recipient, private mode only. A bearer invite binds to nobody —
             that IS the difference — so it has no picker at all. -->
        <template v-if="mode === 'personal'">
          <label class="block text-[10px] uppercase tracking-wide opacity-50">
            {{ $t("invite.recipient") }}
          </label>
          <select
            v-if="!usePaste"
            v-model="recipient"
            class="w-full rounded-lg border border-current/25 bg-transparent px-2 py-2 text-sm"
            data-testid="invite-recipient"
          >
            <option value="" disabled>{{ $t("invite.pickContact") }}</option>
            <option v-for="c in contacts" :key="c.nodeId" :value="c.nodeId">{{ c.name }}</option>
          </select>
          <OyaTextField
            v-else
            v-model="pasted"
            mono
            :placeholder="$t('invite.pasteNodeCode')"
            data-testid="invite-paste"
          />
          <button
            type="button"
            class="text-[11px] underline opacity-70 transition hover:opacity-100"
            data-testid="invite-toggle-paste"
            @click="usePaste = !usePaste"
          >
            {{ usePaste && contactsEnabled && contacts.length ? $t("invite.usePicker") : $t("invite.usePaste") }}
          </button>
        </template>

        <!-- Deadline. Every invitation has one; that is what separates it from
             the ticket above. -->
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
          <span class="tabular-nums opacity-70">{{ formatHp(priceCenti) }} HP</span>
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
              <span class="opacity-70">+{{ formatHp(creditFor("invite.revoke")) }}</span>
            </button>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>
