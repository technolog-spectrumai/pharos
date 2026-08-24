<script setup lang="ts">
// The Privacy HP surface: both meters, the full price list, and the history.
//
// Deliberately ONE component used in two places — the welcome page (`compact`)
// and Settings → Privacy (everything). The alternative, two views of the same
// numbers, is exactly how two views of the same numbers start disagreeing.
//
// Everything below is read-only. There is no control here that spends or earns
// HP: prices are charged where the risky thing actually happens, and this panel
// only reports. That keeps the "price on the button" rule honest — a price list
// you can act on would become a second, competing place to act.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  OyaHpMeter,
  OyaHpPrice,
  findAction,
  formatHp,
  formatPrice,
  getHpPolicy,
  historyRows,
  severityOf,
} from "rakotis";
import { explainFor, hpBalances, hpEntries, hpLoaded, labelFor } from "./useHp";

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const { t } = useI18n({ useScope: "global" });
const policy = getHpPolicy();
const showAllHistory = ref(false);

// ── folding ─────────────────────────────────────────────────────────────────
// The price table is the honest part of this feature and also the longest: eight
// groups of four-ish rows each, which buries the meters people actually came to
// look at. So every section folds, and they start folded — the headings are a
// contents page, and you open the one you are asking about.
//
// Which ones are open is a per-viewer convenience, so it lives in localStorage
// rather than the encrypted kv: it is not a setting, it says nothing about the
// user, and losing it costs a click. Guarded because storage can throw outright
// in a private window or with site data blocked.
const OPEN_KEY = "enigma:hp:open";

function loadOpen(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

const openSections = ref<Set<string>>(loadOpen());

function isOpen(key: string): boolean {
  return openSections.value.has(key);
}

function toggleSection(key: string) {
  const next = new Set(openSections.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openSections.value = next;
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    /* the fold state is a convenience; failing to remember it changes nothing */
  }
}

/** Regeneration line: "+4 HP / hour". */
function regenLabel(centiPerHour: number): string {
  return t("hp.regenRate", { n: formatHp(centiPerHour) });
}

/** Countdown line: "next +1 in 12 min". Minutes only — a second-by-second
 *  countdown to a number that moves once every 15 minutes is noise. */
function nextLabel(ms: number | null): string {
  if (ms === null) return "";
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  return t("hp.regenNext", { n: mins });
}

/** The price list, grouped so the table reads as a threat model rather than an
 *  alphabetical dump. Order is most- to least-exposing within each group. */
const GROUPS: { key: string; ids: string[] }[] = [
  {
    key: "transport",
    ids: ["transport.onion_stable.enable"],
  },
  {
    key: "discovery",
    ids: ["dht.nickname.publish", "dht.presence.enable", "dht.room_code.publish"],
  },
  {
    key: "rooms",
    ids: [
      "ticket.export.clearnet",
      "ticket.export.tor",
      "room.create.clearnet",
      "room.create.tor",
      "room.join.clearnet",
      "room.join.tor",
    ],
  },
  {
    key: "invites",
    ids: [
      "invite.general.create.clearnet",
      "invite.general.create.tor",
      "invite.personal.create.clearnet",
      "invite.personal.create.tor",
    ],
  },
  {
    key: "messages",
    ids: ["msg.clearnet.plain", "msg.tor.plain", "msg.clearnet.mls", "msg.tor.mls"],
  },
  { key: "calendar", ids: ["calendar.share.clearnet", "calendar.share.tor"] },
  { key: "traffic", ids: ["vox.call", "file.send"] },
  {
    key: "local",
    ids: [
      "local.autolock.off",
      "local.pin.enroll",
      "local.panic_code.clear",
      "local.lock_on_hide.off",
      "local.file_integrity.off",
    ],
  },
];

/** Only the actions this BUILD actually has. An edition compiled without Vox has
 *  no vox price to show, and a table listing prices for absent features would be
 *  worse than no table. */
const groups = computed(() =>
  GROUPS.map((g) => ({
    key: g.key,
    rows: g.ids.map((id) => findAction(policy, id)).filter((a) => a !== null),
  })).filter((g) => g.rows.length > 0),
);

/** The metered rate suffix shown after a price: "/msg", "/MiB", "/min". */
function unitFor(id: string): string | undefined {
  const a = findAction(policy, id);
  if (!a || a.kind !== "metered") return undefined;
  if (a.perMinuteCenti > 0) return t("hp.unitMinute");
  return t("hp.unitMessage");
}

/** The second line under a metered price: "+0.05 HP per MiB sent". */
function rateNote(id: string): string {
  const a = findAction(policy, id);
  if (!a) return "";
  if (a.perMibCenti > 0) return t("hp.ratePerMib", { n: formatHp(a.perMibCenti) });
  if (a.perMinuteCenti > 0) return t("hp.ratePerMinute", { n: formatHp(a.perMinuteCenti) });
  return "";
}

const rows = computed(() => historyRows(policy, hpEntries.value, Date.now(), 200));
const visibleRows = computed(() => (showAllHistory.value ? rows.value : rows.value.slice(0, 8)));

/** "47 messages" for a coalesced bucket; nothing for a single activation. */
function countNote(n: number): string {
  return n > 1 ? t("hp.historyCount", { n }) : "";
}

function healNote(healed: number, hp: number, settled: boolean): string {
  if (hp > 0 || healed <= 0) return "";
  if (settled) return t("hp.historySettled");
  return t("hp.historyHealed", { n: formatHp(healed), total: formatHp(Math.abs(hp)) });
}

function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

const recoveries = computed(() => policy.recoveries);
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <!-- ── the two meters ────────────────────────────────────────────────── -->
    <div class="flex flex-col gap-5 sm:flex-row sm:gap-8" data-testid="hp-meters">
      <OyaHpMeter
        class="flex-1"
        :meter="hpBalances.daily"
        :label="$t('hp.daily')"
        :regen-label="regenLabel(hpBalances.daily.regenPerHourCenti)"
        :next-label="nextLabel(hpBalances.daily.msToNextHp)"
      />
      <OyaHpMeter
        class="flex-1"
        :meter="hpBalances.weekly"
        :label="$t('hp.weekly')"
        :regen-label="regenLabel(hpBalances.weekly.regenPerHourCenti)"
        :next-label="nextLabel(hpBalances.weekly.msToNextHp)"
      />
    </div>

    <p v-if="!hpLoaded" class="text-sm opacity-60">{{ $t("hp.loading") }}</p>

    <!-- The one lever the user can pull on the rate itself. Worth saying next to
         the meters rather than burying in the price list: it is the only thing
         here that changes how fast HP comes back. -->
    <p
      class="rounded-lg border p-3 text-xs leading-relaxed"
      :class="hpBalances.daily.torActive
        ? 'border-success-light/40 bg-success-light/10 dark:border-success-dark/40 dark:bg-success-dark/10'
        : 'border-current/15 opacity-70'"
      data-testid="hp-tor-bonus"
    >
      <font-awesome-icon icon="shield-halved" class="mr-1.5 opacity-70" />
      {{ hpBalances.daily.torActive ? $t("hp.torBonusOn") : $t("hp.torBonusOff") }}
    </p>

    <!-- The line that keeps the whole feature honest. Shown wherever the meters
         are, including the compact welcome view. -->
    <p class="text-xs leading-relaxed opacity-60" data-testid="hp-disclaimer">
      {{ $t("hp.regenDisclaimer") }}
    </p>

    <template v-if="!compact">
      <!-- ── the price list ─────────────────────────────────────────────── -->
      <section class="flex flex-col gap-4">
        <h3 class="text-sm font-bold uppercase opacity-70">{{ $t("hp.pricesTitle") }}</h3>
        <p class="text-xs leading-relaxed opacity-70">{{ $t("hp.pricesHint") }}</p>

        <div v-for="g in groups" :key="g.key" class="flex flex-col">
          <!-- The heading IS the control: a whole-width button, so the hit target
               matches what it looks like rather than being a stray chevron. -->
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg py-2 text-left text-xs font-bold uppercase opacity-60 transition hover:opacity-100"
            :aria-expanded="isOpen(g.key)"
            :data-testid="`hp-group-${g.key}`"
            @click="toggleSection(g.key)"
          >
            <font-awesome-icon
              :icon="isOpen(g.key) ? 'chevron-down' : 'chevron-right'"
              class="w-3 shrink-0 opacity-70"
            />
            <span class="min-w-0 flex-1 truncate">{{ $t(`hp.group.${g.key}`) }}</span>
            <!-- A folded heading still says how much is under it. -->
            <span class="shrink-0 tabular-nums opacity-50">{{ g.rows.length }}</span>
          </button>
          <ul
            v-if="isOpen(g.key)"
            class="flex flex-col divide-y divide-current/10 pb-2"
            :data-testid="`hp-group-body-${g.key}`"
          >
            <li
              v-for="a in g.rows"
              :key="a.id"
              class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
              :data-testid="`hp-price-row-${a.id}`"
            >
              <span class="flex min-w-0 flex-col">
                <span class="truncate text-sm font-semibold">{{ labelFor(a.id) }}</span>
                <span v-if="rateNote(a.id)" class="text-[11px] opacity-60">{{ rateNote(a.id) }}</span>
              </span>
              <!-- A zero-cost lane says "Free" rather than "−0 HP": it is a
                   different statement, and it is the one worth making. -->
              <span
                v-if="a.costCenti === 0 && a.perMibCenti === 0 && a.perMinuteCenti === 0"
                class="shrink-0 rounded-md border border-success-light/50 px-2 py-0.5 text-[11px] font-bold text-success-light dark:border-success-dark/50 dark:text-success-dark"
              >
                {{ $t("hp.free") }}
              </span>
              <OyaHpPrice
                v-else
                :centi="-a.costCenti"
                :unit="unitFor(a.id)"
                :explain="explainFor(a.id)"
              />
            </li>
          </ul>
        </div>
      </section>

      <!-- ── what earns HP back ─────────────────────────────────────────── -->
      <section class="flex flex-col">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-lg py-2 text-left text-sm font-bold uppercase opacity-70 transition hover:opacity-100"
          :aria-expanded="isOpen('recovery')"
          data-testid="hp-group-recovery"
          @click="toggleSection('recovery')"
        >
          <font-awesome-icon
            :icon="isOpen('recovery') ? 'chevron-down' : 'chevron-right'"
            class="w-3 shrink-0 opacity-70"
          />
          <span class="min-w-0 flex-1 truncate">{{ $t("hp.recoveryTitle") }}</span>
          <span class="shrink-0 tabular-nums opacity-50">{{ recoveries.length }}</span>
        </button>
        <template v-if="isOpen('recovery')">
        <p class="text-xs leading-relaxed opacity-70">{{ $t("hp.recoveryHint") }}</p>
        <ul class="flex flex-col divide-y divide-current/10">
          <li
            v-for="r in recoveries"
            :key="r.id"
            class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
          >
            <span class="truncate text-sm font-semibold">{{ labelFor(r.id) }}</span>
            <OyaHpPrice :centi="r.creditCenti" :explain="explainFor(r.id)" />
          </li>
        </ul>
        <p class="text-xs leading-relaxed opacity-60">
          {{ $t("hp.recoveryCaps", {
            daily: formatHp(policy.recoveryDailyCapCenti),
            weekly: formatHp(policy.recoveryWeeklyCapCenti),
          }) }}
        </p>
        </template>
      </section>

      <!-- ── why did this change? ───────────────────────────────────────── -->
      <section class="flex flex-col gap-2">
        <h3 class="text-sm font-bold uppercase opacity-70">{{ $t("hp.historyTitle") }}</h3>
        <p class="text-xs leading-relaxed opacity-70">{{ $t("hp.historyHint") }}</p>

        <p v-if="rows.length === 0" class="py-3 text-sm opacity-60" data-testid="hp-history-empty">
          {{ $t("hp.historyEmpty") }}
        </p>

        <ul v-else class="flex flex-col divide-y divide-current/10" data-testid="hp-history">
          <li
            v-for="(row, i) in visibleRows"
            :key="`${row.ts}-${row.code}-${i}`"
            class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
          >
            <span class="flex min-w-0 flex-col">
              <span class="truncate text-sm font-semibold">
                {{ labelFor(row.code) }}
                <span v-if="countNote(row.n)" class="font-normal opacity-60">
                  · {{ countNote(row.n) }}
                </span>
              </span>
              <span class="text-[11px] opacity-50">{{ when(row.ts) }}</span>
              <span
                v-if="healNote(row.healedCenti, row.hp, row.settled)"
                class="text-[11px] opacity-60"
              >
                {{ healNote(row.healedCenti, row.hp, row.settled) }}
              </span>
            </span>
            <span
              class="shrink-0 text-sm font-bold tabular-nums"
              :class="
                row.hp > 0
                  ? 'text-success-light dark:text-success-dark'
                  : severityOf(row.hp) === 'severe' || severityOf(row.hp) === 'high'
                    ? 'text-warn-light dark:text-warn-dark'
                    : 'opacity-80'
              "
            >
              {{ formatPrice(row.hp) }}
            </span>
          </li>
        </ul>

        <button
          v-if="rows.length > 8"
          type="button"
          class="self-start text-xs font-semibold underline opacity-70 transition hover:opacity-100"
          @click="showAllHistory = !showAllHistory"
        >
          {{ showAllHistory ? $t("hp.historyLess") : $t("hp.historyMore", { n: rows.length }) }}
        </button>

        <!-- What the ledger deliberately does not contain. Worth stating on the
             screen that shows it, not only in the docs. -->
        <p class="text-xs leading-relaxed opacity-60">{{ $t("hp.historyPrivacy") }}</p>
      </section>
    </template>
  </div>
</template>
