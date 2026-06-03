<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api, type EnigmaEvent, type EventInvite } from "../services/api";

defineProps<{ darkMode: boolean }>();

// ── Data ───────────────────────────────────────────────────────────────────────
const events = ref<EnigmaEvent[]>([]);
const upcoming = ref<EnigmaEvent[]>([]);
const total = ref(0);
const upcomingCount = ref(0);
const pastCount = ref(0);
const invites = ref<EventInvite[]>([]);
const pendingCount = ref(0);

const loading = ref(false);
const invitesLoading = ref(false);
const error = ref<string | null>(null);

// ── Tabs ───────────────────────────────────────────────────────────────────────
type Tab = "calendar" | "invites";
const tab = ref<Tab>("calendar");

// ── Calendar state ─────────────────────────────────────────────────────────────
const today = new Date();
const calYear = ref(today.getFullYear());
const calMonth = ref(today.getMonth()); // 0-based

function prevMonth() {
  if (calMonth.value === 0) { calMonth.value = 11; calYear.value--; }
  else calMonth.value--;
}
function nextMonth() {
  if (calMonth.value === 11) { calMonth.value = 0; calYear.value++; }
  else calMonth.value++;
}
function goToday() {
  calYear.value = today.getFullYear();
  calMonth.value = today.getMonth();
}

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// Build a 6-row × 7-col grid for the current month view
const calGrid = computed(() => {
  const year = calYear.value;
  const month = calMonth.value;
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const cells: { date: Date; isCurrentMonth: boolean }[] = [];
  // fill leading days from prev month
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month - 1, daysInPrev - i), isCurrentMonth: false });
  }
  // current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), isCurrentMonth: true });
  }
  // trailing days
  while (cells.length % 7 !== 0) {
    const next = cells.length - firstDay - daysInMonth + 1;
    cells.push({ date: new Date(year, month + 1, next), isCurrentMonth: false });
  }

  // chunk into weeks
  const weeks: { date: Date; isCurrentMonth: boolean }[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
});

function eventsForDay(date: Date): EnigmaEvent[] {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  return events.value.filter(e => {
    const s = new Date(e.start_time);
    return s.getFullYear() === y && s.getMonth() === m && s.getDate() === d;
  });
}

function isToday(date: Date) {
  return date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
}

// ── Event detail modal ─────────────────────────────────────────────────────────
const selectedEvent = ref<EnigmaEvent | null>(null);

async function openEvent(e: EnigmaEvent) {
  selectedEvent.value = e;
  try {
    selectedEvent.value = await api.getEvent(e.id);
  } catch { /* keep basic data */ }
}
function closeEvent() { selectedEvent.value = null; }

// ── Invites ────────────────────────────────────────────────────────────────────
const respondingId = ref<string | null>(null);

async function respond(invite: EventInvite, action: "accept" | "decline") {
  respondingId.value = invite.id;
  try {
    await api.respondInvite(invite.id, action);
    await loadInvites();
  } catch { /* ignore */ }
  finally { respondingId.value = null; }
}

// ── Load ───────────────────────────────────────────────────────────────────────
async function loadEvents() {
  loading.value = true; error.value = null;
  try {
    const res = await api.getEvents();
    events.value = res.events;
    upcoming.value = res.upcoming;
    total.value = res.total;
    upcomingCount.value = res.upcoming_count;
    pastCount.value = res.past_count;
  } catch (e: any) { error.value = e.message; }
  finally { loading.value = false; }
}

async function loadInvites() {
  invitesLoading.value = true;
  try {
    const res = await api.getMyInvites();
    invites.value = res.invites;
    pendingCount.value = res.pending_count;
  } catch { invites.value = []; }
  finally { invitesLoading.value = false; }
}

onMounted(async () => {
  await loadEvents();
  loadInvites();
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_COLOR: Record<string, string> = {
  pending: "text-yellow-400",
  accepted: "text-emerald-400",
  declined: "text-red-400",
};
</script>

<template>
  <div class="flex w-full flex-col gap-3 overflow-hidden" style="min-height:calc(100vh - 9rem)">

    <!-- ── Tab bar ──────────────────────────────────────────────────────────── -->
    <div class="flex gap-1 shrink-0">
      <button
        v-for="[key, icon, label, badge] in [['calendar','calendar','Calendar',null],['invites','envelope','My Invites', pendingCount || null]] as any"
        :key="key"
        @click="tab = key"
        :class="[
          'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border transition',
          tab === key
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : 'border-current/20 opacity-60 hover:opacity-100'
        ]"
      >
        <font-awesome-icon :icon="icon" />{{ label }}
        <span v-if="badge" class="rounded-full bg-red-500 text-white px-1.5 py-0.5 text-[10px] font-bold leading-none">{{ badge }}</span>
      </button>
    </div>

    <div v-if="error" class="shrink-0 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-400">{{ error }}</div>

    <div v-if="loading" class="flex flex-1 items-center justify-center opacity-40">
      <font-awesome-icon icon="spinner" spin class="text-2xl" />
    </div>

    <!-- ═══════════════════════ CALENDAR TAB ════════════════════════════════ -->
    <div v-else-if="tab === 'calendar'" class="flex gap-4 flex-1 overflow-hidden min-h-0">

      <!-- Left sidebar -->
      <div class="w-56 shrink-0 flex flex-col gap-3 overflow-y-auto">
        <!-- Stats -->
        <div class="grid grid-cols-2 gap-2">
          <div v-for="[label, val] in [['Total', total], ['Upcoming', upcomingCount]]" :key="label"
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border p-3 shadow-sm">
            <p class="text-2xl font-bold">{{ val }}</p>
            <p class="text-xs opacity-50 mt-0.5">{{ label }}</p>
          </div>
        </div>
        <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border p-3 shadow-sm">
          <p class="text-2xl font-bold">{{ pastCount }}</p>
          <p class="text-xs opacity-50 mt-0.5">Past</p>
        </div>

        <!-- Upcoming list -->
        <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border shadow-md overflow-hidden">
          <div class="border-b border-current/10 px-3 py-2">
            <p class="text-xs font-bold uppercase tracking-wide opacity-50">Upcoming</p>
          </div>
          <div v-if="!upcoming.length" class="px-3 py-4 text-xs opacity-30 text-center">No upcoming events</div>
          <div v-for="e in upcoming" :key="e.id"
            :class="darkMode ? 'border-accent-1 hover:bg-primary-bg-dark' : 'border-accent-2 hover:bg-primary-bg-light'"
            class="border-b last:border-0 px-3 py-2.5 cursor-pointer transition"
            @click="openEvent(e)"
          >
            <p class="text-xs font-semibold leading-snug truncate">{{ e.title }}</p>
            <p class="text-xs opacity-40 mt-0.5">{{ fmtDate(e.start_time) }} · {{ fmtTime(e.start_time) }}</p>
          </div>
        </div>
      </div>

      <!-- Calendar -->
      <div :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
        class="flex-1 rounded-xl border shadow-md overflow-hidden flex flex-col min-h-0">

        <!-- Calendar header -->
        <div class="shrink-0 flex items-center gap-2 border-b border-current/10 px-4 py-2.5">
          <button @click="prevMonth"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="rounded-lg border px-2 py-1 text-xs opacity-60 hover:opacity-100 transition">‹</button>
          <button @click="nextMonth"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="rounded-lg border px-2 py-1 text-xs opacity-60 hover:opacity-100 transition">›</button>
          <button @click="goToday"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="rounded-lg border px-2 py-1 text-xs opacity-60 hover:opacity-100 transition">today</button>
          <h2 class="ml-2 text-base font-bold">{{ MONTHS[calMonth] }} {{ calYear }}</h2>
        </div>

        <!-- Day-of-week header -->
        <div class="shrink-0 grid grid-cols-7 border-b border-current/10">
          <div v-for="d in DOW" :key="d"
            class="py-1.5 text-center text-xs font-semibold uppercase tracking-wide opacity-40">{{ d }}</div>
        </div>

        <!-- Grid -->
        <div class="flex-1 overflow-y-auto">
          <div class="grid grid-cols-7 h-full" style="grid-auto-rows: minmax(80px, 1fr)">
            <div
              v-for="(cell, ci) in calGrid.flat()" :key="ci"
              :class="[
                'border-b border-r border-current/10 p-1 overflow-hidden',
                !cell.isCurrentMonth ? 'opacity-30' : '',
                isToday(cell.date) ? (darkMode ? 'bg-accent-dark/10' : 'bg-accent-light/10') : '',
              ]"
            >
              <!-- Day number -->
              <div class="flex items-center justify-end mb-0.5">
                <span
                  :class="[
                    'text-xs font-semibold rounded-full w-5 h-5 flex items-center justify-center',
                    isToday(cell.date)
                      ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
                      : 'opacity-60'
                  ]"
                >{{ cell.date.getDate() }}</span>
              </div>

              <!-- Events in cell -->
              <div class="space-y-0.5">
                <div
                  v-for="e in eventsForDay(cell.date).slice(0, 3)" :key="e.id"
                  :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                  class="flex items-center gap-1 cursor-pointer hover:opacity-70 transition"
                  @click="openEvent(e)"
                >
                  <span class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="darkMode ? 'bg-accent-dark' : 'bg-accent-light'"></span>
                  <span class="text-[10px] truncate leading-tight">
                    {{ fmtTime(e.start_time) }} {{ e.title }}
                  </span>
                </div>
                <div v-if="eventsForDay(cell.date).length > 3" class="text-[10px] opacity-40 pl-2.5">
                  +{{ eventsForDay(cell.date).length - 3 }} more
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════ INVITES TAB ══════════════════════════════════ -->
    <div v-else-if="tab === 'invites'" class="flex-1 overflow-y-auto">
      <div v-if="invitesLoading" class="flex items-center justify-center py-12 opacity-40">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>
      <div v-else-if="!invites.length" class="flex items-center justify-center py-12 opacity-30 text-sm">
        No invites
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="inv in invites" :key="inv.id"
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border p-4 shadow-sm"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold truncate">{{ inv.event_title }}</p>
              <p class="text-xs opacity-50 mt-0.5">
                {{ fmtDate(inv.event_start) }} · {{ fmtTime(inv.event_start) }} – {{ fmtTime(inv.event_end) }}
              </p>
              <p v-if="inv.event_category" class="text-xs opacity-40 mt-0.5">{{ inv.event_category }}</p>
            </div>
            <span class="shrink-0 text-xs font-semibold" :class="STATUS_COLOR[inv.status]">
              {{ inv.status }}
            </span>
          </div>

          <div v-if="inv.status === 'pending'" class="flex gap-2 mt-3">
            <button
              @click="respond(inv, 'accept')"
              :disabled="respondingId === inv.id"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50"
            >Accept</button>
            <button
              @click="respond(inv, 'decline')"
              :disabled="respondingId === inv.id"
              class="rounded-lg border border-current/20 px-3 py-1.5 text-xs transition hover:opacity-80 disabled:opacity-50"
            >Decline</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════ EVENT DETAIL MODAL ════════════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="selectedEvent"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        :class="darkMode ? 'bg-black/60' : 'bg-black/30'"
        @click.self="closeEvent"
      >
        <div
          :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
          class="w-full max-w-md rounded-xl border shadow-2xl overflow-hidden"
        >
          <div class="flex items-center justify-between border-b border-current/10 px-5 py-3">
            <h3 class="text-sm font-bold flex items-center gap-2">
              <font-awesome-icon icon="calendar" class="opacity-60" />
              Event Details
            </h3>
            <button @click="closeEvent" class="opacity-50 hover:opacity-100 transition">
              <font-awesome-icon icon="xmark" />
            </button>
          </div>

          <div class="p-5 space-y-3">
            <h2 class="text-base font-bold">{{ selectedEvent.title }}</h2>
            <p v-if="selectedEvent.description" class="text-sm opacity-60">{{ selectedEvent.description }}</p>

            <div class="grid grid-cols-2 gap-3 text-xs">
              <div :class="darkMode ? 'bg-bubble-bg-dark' : 'bg-bubble-bg-light'" class="rounded-lg p-3">
                <p class="opacity-40 uppercase tracking-wide mb-1">Start</p>
                <p class="font-semibold">{{ fmtDate(selectedEvent.start_time) }}</p>
                <p class="opacity-60">{{ fmtTime(selectedEvent.start_time) }}</p>
              </div>
              <div :class="darkMode ? 'bg-bubble-bg-dark' : 'bg-bubble-bg-light'" class="rounded-lg p-3">
                <p class="opacity-40 uppercase tracking-wide mb-1">End</p>
                <p class="font-semibold">{{ fmtDate(selectedEvent.end_time) }}</p>
                <p class="opacity-60">{{ fmtTime(selectedEvent.end_time) }}</p>
              </div>
            </div>

            <div class="text-xs space-y-1.5">
              <div v-if="selectedEvent.category" class="flex items-center gap-2">
                <font-awesome-icon icon="tag" class="opacity-40 w-3" />
                <span>{{ selectedEvent.category }}</span>
              </div>
              <div v-if="selectedEvent.owner" class="flex items-center gap-2">
                <font-awesome-icon icon="user" class="opacity-40 w-3" />
                <span>{{ selectedEvent.owner }}</span>
              </div>
              <div v-if="selectedEvent.address" class="flex items-center gap-2">
                <font-awesome-icon icon="location-dot" class="opacity-40 w-3" />
                <span>{{ selectedEvent.address }}</span>
              </div>
              <div v-if="selectedEvent.capacity" class="flex items-center gap-2">
                <font-awesome-icon icon="users" class="opacity-40 w-3" />
                <span>Capacity: {{ selectedEvent.capacity }}</span>
              </div>
              <div v-if="selectedEvent.accepted_count != null" class="flex items-center gap-2">
                <font-awesome-icon icon="check" class="opacity-40 w-3" />
                <span>{{ selectedEvent.accepted_count }} / {{ selectedEvent.invite_count }} accepted</span>
              </div>
            </div>

            <div v-if="selectedEvent.organizers?.length" class="text-xs">
              <p class="opacity-40 uppercase tracking-wide mb-1.5">Organizers</p>
              <div class="flex flex-wrap gap-1">
                <span v-for="o in selectedEvent.organizers" :key="o"
                  :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                  class="rounded-full border px-2 py-0.5">{{ o }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>
