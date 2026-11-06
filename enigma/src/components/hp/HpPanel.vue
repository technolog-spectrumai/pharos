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
  formatDate,
} from "rakotis";
import { explainFor, hpBalances, hpEntries, hpExposure, hpLoaded, labelFor } from "./useHp";
import HpHistoryChart from "./HpHistoryChart.vue";

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const { t } = useI18n({ useScope: "global" });
const policy = getHpPolicy();

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
const SUBTAB_KEY = "enigma:hp:subtab";

// Below the meters the panel answers two different questions, and mixing them
// made both harder to read: "what does this cost?" (the rules, which are fixed
// and worth browsing) and "what did I spend?" (my own decisions, which are a
// running log). Two sub-tabs, so neither is scrolled past to reach the other.
type SubTab = "rules" | "decisions";

function loadSubTab(): SubTab {
  try {
    return localStorage.getItem(SUBTAB_KEY) === "decisions" ? "decisions" : "rules";
  } catch {
    return "rules";
  }
}

const subTab = ref<SubTab>(loadSubTab());

function selectSubTab(next: SubTab) {
  subTab.value = next;
  try {
    localStorage.setItem(SUBTAB_KEY, next);
  } catch {
    /* a remembered tab is a convenience; forgetting it costs one click */
  }
}

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
// ── every hour ───────────────────────────────────────────────────────────────
// What comes back and what goes out per hour right now, so the meter's direction
// is not a guess: regeneration, minus the stable address and the standing rooms
// (billed by the minute in Rust, tor.stable.hold / tor.persistent.hold).
const perHour = (id: string) => (findAction(getHpPolicy(), id)?.perMinuteCenti ?? 0) * 60;
const hourly = computed(() => {
  const e = hpExposure.value;
  const lines: { key: string; label: string; centi: number }[] = [];
  if (e.stable) lines.push({ key: "stable", label: t("hp.hourlyStable"), centi: -perHour("tor.stable.hold") });
  if (e.rooms.length > 0) {
    lines.push({
      key: "rooms",
      label: t("hp.hourlyRooms", { n: e.rooms.length }, e.rooms.length),
      centi: -perHour("tor.persistent.hold") * e.rooms.length,
    });
  }
  const regen = hpBalances.value.daily.regenPerHourCenti;
  return { regen, lines, net: regen + lines.reduce((s, l) => s + l.centi, 0) };
});
const signed = (c: number) => (c > 0 ? "+" : c < 0 ? "−" : "") + formatHp(Math.abs(c));

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
    ids: ["tor.stable.hold"],
  },
  // Every room, invitation and message in Enigma goes over Tor: only the Tor
  // variants are listed (the clearnet ones remain in the price table, unused;
  // Pharos decision PD9 settles the table).
  {
    key: "rooms",
    ids: ["ticket.export.tor", "room.create.tor", "room.join.tor"],
  },
  {
    key: "invites",
    ids: ["invite.general.create.tor", "invite.personal.create.tor"],
  },
  {
    key: "messages",
    ids: ["msg.tor.plain", "msg.tor.mls"],
  },
  {
    key: "local",
    ids: [
      "local.autolock.off",
      "local.pin.enroll",
      "local.panic_code.clear",
      "local.lock_on_hide.off",
    ],
  },
];

/** Only the actions this BUILD actually has. A build compiled without Vox has
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

// One `now` for the chart, recomputed when the ledger changes rather than on every
// render: a chart whose last point crept forward mid-frame would redraw constantly
// and say nothing new.
const chartNow = computed(() => {
  void hpEntries.value.length;
  return Date.now();
});

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
  return formatDate(ts, "dateTime");
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
    </div>

    <!-- Every hour: what comes back, what is being charged, and the net. -->
    <section
      v-if="hpLoaded"
      class="rounded-xl border border-current/15 p-3 text-sm"
      data-testid="hp-hourly"
    >
      <h3 class="mb-2 text-[10px] uppercase tracking-wide opacity-50">{{ $t("hp.hourlyTitle") }}</h3>
      <dl class="space-y-1">
        <div class="flex justify-between gap-3">
          <dt>{{ $t("hp.hourlyRegen") }}</dt>
          <dd class="tabular-nums text-success-light dark:text-success-dark" data-testid="hp-hourly-regen">{{ signed(hourly.regen) }}</dd>
        </div>
        <div v-for="l in hourly.lines" :key="l.key" class="flex justify-between gap-3" :data-testid="`hp-hourly-${l.key}`">
          <dt>{{ l.label }}</dt>
          <dd class="tabular-nums text-error-light dark:text-error-dark">{{ signed(l.centi) }}</dd>
        </div>
        <p v-if="hourly.lines.length === 0" class="text-xs opacity-60">{{ $t("hp.hourlyNothing") }}</p>
        <div class="mt-1 flex justify-between gap-3 border-t border-current/10 pt-1 font-bold">
          <dt>{{ $t("hp.hourlyNet") }}</dt>
          <dd class="tabular-nums" data-testid="hp-hourly-net">{{ signed(hourly.net) }} HP</dd>
        </div>
      </dl>
    </section>

    <!-- Seven days of the same meter, in place of the second bar that used to
         sit beside it. A shape says what a slower number could not. -->
    <HpHistoryChart
      v-if="hpLoaded"
      :policy="policy"
      :entries="hpEntries"
      :max-centi="hpBalances.daily.maxCenti"
      :now="chartNow"
    />

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
      <!-- Two questions, two panes: what things cost, and what I have spent. -->
      <div
        class="flex gap-1 rounded-xl border border-current/20 p-1 text-xs font-semibold"
        role="tablist"
      >
        <button
          v-for="tab in (['rules', 'decisions'] as const)"
          :key="tab"
          type="button"
          role="tab"
          :aria-selected="subTab === tab"
          :class="subTab === tab
            ? 'bg-accent-light text-primary-bg-light dark:bg-accent-dark dark:text-primary-bg-dark'
            : 'opacity-60 hover:opacity-100'"
          class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 transition"
          :data-testid="`hp-subtab-${tab}`"
          @click="selectSubTab(tab)"
        >
          <font-awesome-icon :icon="tab === 'rules' ? 'scale-balanced' : 'clock-rotate-left'" />
          <span class="truncate">{{ $t(`hp.subtab.${tab}`) }}</span>
        </button>
      </div>

      <!-- ── the price list ─────────────────────────────────────────────── -->
      <section v-if="subTab === 'rules'" class="flex flex-col gap-4">
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
      <section v-if="subTab === 'rules'" class="flex flex-col">
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
            window: formatHp(policy.recoveryWindowCapCenti),
          }) }}
        </p>
        </template>
      </section>

      <!-- ── decisions: the ledger ──────────────────────────────────────── -->
      <!-- Formerly "Why did this change?" — the same rows, given their own pane
           and allowed to scroll instead of being truncated behind a "show more".
           A ledger you have to expand to read is a ledger nobody reads. -->
      <section v-if="subTab === 'decisions'" class="flex flex-col gap-2">
        <p class="text-xs leading-relaxed opacity-70">{{ $t("hp.historyHint") }}</p>

        <p v-if="rows.length === 0" class="py-3 text-sm opacity-60" data-testid="hp-history-empty">
          {{ $t("hp.historyEmpty") }}
        </p>

        <!-- Scrolls in its own box: the meters above it must stay on screen, and
             the page itself must not grow without bound as the log does. -->
        <ul
          v-else
          class="flex max-h-[46vh] flex-col divide-y divide-current/10 overflow-y-auto pr-1"
          data-testid="hp-history"
        >
          <li
            v-for="(row, i) in rows"
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

        <!-- What the ledger deliberately does not contain. Worth stating on the
             screen that shows it, not only in the docs. -->
        <p class="text-xs leading-relaxed opacity-60">{{ $t("hp.historyPrivacy") }}</p>
      </section>
    </template>
  </div>
</template>
