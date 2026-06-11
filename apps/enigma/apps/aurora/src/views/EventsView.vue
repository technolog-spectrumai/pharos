<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api, type EnigmaEvent, type EventInvite, type EventFormData } from "../services/api";
import * as yStore from "../services/yStore";

// Events are a P2P-synced domain: persisted in the y_store "events" doc.
const EVENTS_DOC = "events";

const props = defineProps<{ darkMode: boolean }>();

// ── Data ──────────────────────────────────────────────────────────────────────
const events    = ref<EnigmaEvent[]>([]);
const upcoming  = ref<EnigmaEvent[]>([]);
const total     = ref(0);
const upcomingCount = ref(0);
const pastCount = ref(0);
const invites   = ref<EventInvite[]>([]);
const pendingCount = ref(0);
const formData  = ref<EventFormData>({ categories: [], addresses: [], people: [] });

const loading        = ref(false);
const invitesLoading = ref(false);
const error          = ref<string | null>(null);

// ── Tabs ──────────────────────────────────────────────────────────────────────
type Tab = "calendar" | "invites";
const tab = ref<Tab>("calendar");

// ── Mobile sidebar ────────────────────────────────────────────────────────────
const sidebarOpen = ref(false);

// ── Calendar state ────────────────────────────────────────────────────────────
const today    = new Date();
const calYear  = ref(today.getFullYear());
const calMonth = ref(today.getMonth());

function prevMonth() {
  if (calMonth.value === 0) { calMonth.value = 11; calYear.value--; }
  else calMonth.value--;
}
function nextMonth() {
  if (calMonth.value === 11) { calMonth.value = 0; calYear.value++; }
  else calMonth.value++;
}
function goToday() { calYear.value = today.getFullYear(); calMonth.value = today.getMonth(); }

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DOW    = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const calGrid = computed(() => {
  const year = calYear.value, month = calMonth.value;
  const firstDay     = new Date(year, month, 1).getDay();
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const daysInPrev   = new Date(year, month, 0).getDate();
  const cells: { date: Date; cur: boolean }[] = [];
  for (let i = firstDay - 1; i >= 0; i--)
    cells.push({ date: new Date(year, month - 1, daysInPrev - i), cur: false });
  for (let d = 1; d <= daysInMonth; d++)
    cells.push({ date: new Date(year, month, d), cur: true });
  while (cells.length % 7 !== 0)
    cells.push({ date: new Date(year, month + 1, cells.length - firstDay - daysInMonth + 1), cur: false });
  const weeks: { date: Date; cur: boolean }[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
});

function eventsForDay(date: Date) {
  const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
  return events.value.filter(e => {
    const s = new Date(e.start_time);
    return s.getFullYear() === y && s.getMonth() === m && s.getDate() === d;
  });
}
function isToday(date: Date) {
  return date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

// ── Event detail modal ────────────────────────────────────────────────────────
const selectedEvent = ref<EnigmaEvent | null>(null);

async function openEvent(e: EnigmaEvent) {
  selectedEvent.value = e;
  sidebarOpen.value = false;
  try { selectedEvent.value = await api.getEvent(e.id); } catch { /* keep basic */ }
}
function closeEvent() { selectedEvent.value = null; inviteSearch.value = ""; inviteError.value = null; }

// ── Invite people (from event detail) ────────────────────────────────────────
const inviteSearch  = ref("");
const inviteError   = ref<string | null>(null);
const inviteSending = ref(false);
const invitedNames  = ref<string[]>([]);

const filteredPeople = computed(() => {
  const q = inviteSearch.value.trim().toLowerCase();
  if (!q) return [];
  return formData.value.people.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
});

async function sendInvite(personId: number, personName: string) {
  if (!selectedEvent.value) return;
  inviteSending.value = true; inviteError.value = null;
  try {
    await api.sendInvite(selectedEvent.value.id, personId);
    invitedNames.value.push(personName);
    inviteSearch.value = "";
    // refresh counts
    selectedEvent.value = await api.getEvent(selectedEvent.value.id);
  } catch (e: any) {
    inviteError.value = e.message;
  } finally { inviteSending.value = false; }
}

// ── Create event modal ────────────────────────────────────────────────────────
const createOpen = ref(false);
const creating   = ref(false);
const createError = ref<string | null>(null);
const form = ref({
  title: "", description: "",
  start_date: "", start_time: "",
  end_date: "",   end_time: "",
  category_id: null as number | null,
  address_id:  null as number | null,
  capacity: "" as string | number,
  requires_registration: false,
  public: true,
});

function openCreate() {
  const d = today.toISOString().slice(0, 10);
  form.value = {
    title: "", description: "",
    start_date: d, start_time: "09:00",
    end_date: d,   end_time: "10:00",
    category_id: null, address_id: null,
    capacity: "", requires_registration: false, public: true,
  };
  createError.value = null;
  createOpen.value = true;
}

async function submitCreate() {
  if (!form.value.title.trim()) { createError.value = "Title is required."; return; }
  if (!form.value.start_date || !form.value.start_time) { createError.value = "Start date/time required."; return; }
  if (!form.value.end_date   || !form.value.end_time)   { createError.value = "End date/time required."; return; }
  creating.value = true; createError.value = null;
  try {
    const e = await api.createEvent({
      title:       form.value.title.trim(),
      description: form.value.description,
      start_time:  `${form.value.start_date}T${form.value.start_time}`,
      end_time:    `${form.value.end_date}T${form.value.end_time}`,
      category_id: form.value.category_id,
      address_id:  form.value.address_id,
      capacity:    form.value.capacity ? Number(form.value.capacity) : null,
      requires_registration: form.value.requires_registration,
      public:      form.value.public,
    });
    events.value.push(e);
    // re-sort by start
    events.value.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    total.value++;
    if (new Date(e.start_time) >= today) { upcomingCount.value++; upcoming.value.unshift(e); }
    else pastCount.value++;
    createOpen.value = false;
  } catch (e: any) { createError.value = e.message; }
  finally { creating.value = false; }
}

// ── Invites tab ───────────────────────────────────────────────────────────────
const respondingId = ref<string | null>(null);

async function respond(invite: EventInvite, action: "accept" | "decline") {
  respondingId.value = invite.id;
  try { await api.respondInvite(invite.id, action); await loadInvites(); }
  catch { /* ignore */ } finally { respondingId.value = null; }
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadEvents() {
  loading.value = true; error.value = null;
  try {
    const res = await api.getEvents();
    events.value = await yStore.persist<EnigmaEvent>(EVENTS_DOC, "events", res.events);
    upcoming.value = res.upcoming;
    total.value = res.total; upcomingCount.value = res.upcoming_count; pastCount.value = res.past_count;
  } catch (e: any) {
    // Offline: serve the cached events and derive upcoming/counts client-side.
    const cached = await yStore.cached<EnigmaEvent>(EVENTS_DOC, "events");
    if (cached) {
      const now = Date.now();
      const up = cached.filter((e) => new Date(e.start_time).getTime() >= now);
      events.value = cached; upcoming.value = up;
      total.value = cached.length; upcomingCount.value = up.length; pastCount.value = cached.length - up.length;
    } else { error.value = e.message; }
  } finally { loading.value = false; }
}
async function loadInvites() {
  invitesLoading.value = true;
  try { const r = await api.getMyInvites(); invites.value = r.invites; pendingCount.value = r.pending_count; }
  catch { invites.value = []; } finally { invitesLoading.value = false; }
}

onMounted(async () => {
  await loadEvents();
  loadInvites();
  api.getEventFormData().then(d => { formData.value = d; }).catch(() => {});
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_COLOR: Record<string, string> = {
  pending: "text-yellow-400", accepted: "text-emerald-400", declined: "text-red-400",
};

function panelCls() {
  return props.darkMode
    ? "bg-bubble-bg-dark border-accent-1 text-text-main-dark"
    : "bg-bubble-bg-light border-accent-2 text-text-main-light";
}
</script>

<template>
  <div class="flex w-full flex-col gap-3 overflow-hidden" style="min-height:calc(100vh - 9rem)">

    <!-- ── Top bar: tabs + new event button ──────────────────────────────────── -->
    <div class="flex items-center justify-between gap-2 shrink-0 flex-wrap">
      <div class="flex gap-1">
        <button
          v-for="[key, icon, label, badge] in [['calendar','calendar','Calendar',null],['invites','envelope','My Invites',pendingCount||null]] as any"
          :key="key" @click="tab = key"
          :class="[
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border transition',
            tab === key
              ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
              : 'border-current/20 opacity-60 hover:opacity-100',
          ]"
        >
          <font-awesome-icon :icon="icon" />{{ label }}
          <span v-if="badge" class="rounded-full bg-red-500 text-white px-1.5 py-0.5 text-[10px] font-bold leading-none">{{ badge }}</span>
        </button>
      </div>

      <button @click="openCreate"
        :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
        class="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90"
      >
        <font-awesome-icon icon="plus" /> New Event
      </button>
    </div>

    <div v-if="error" class="shrink-0 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-400">{{ error }}</div>
    <div v-if="loading" class="flex flex-1 items-center justify-center opacity-40">
      <font-awesome-icon icon="spinner" spin class="text-2xl" />
    </div>

    <!-- ═══════════════════════ CALENDAR TAB ════════════════════════════════ -->
    <div v-else-if="tab === 'calendar'" class="relative flex gap-4 flex-1 overflow-hidden min-h-0">

      <!-- Mobile backdrop -->
      <Transition name="fade">
        <div v-if="sidebarOpen"
          class="lg:hidden absolute inset-0 z-[40] bg-black/50 rounded-xl"
          @click="sidebarOpen = false"
        />
      </Transition>

      <!-- ── Sidebar (stats + upcoming) ────────────────────────────────────── -->
      <div :class="[
        panelCls(),
        'flex flex-col overflow-hidden w-56 shrink-0 rounded-xl border shadow-md',
        // mobile: slide in from left
        'absolute inset-y-0 left-0 z-[50] transition-transform duration-300 ease-in-out',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        // desktop: static
        'lg:static lg:inset-auto lg:z-auto lg:translate-x-0 lg:transition-none',
      ]">
        <!-- Sidebar header (mobile close) -->
        <div class="flex items-center justify-between px-3 py-2.5 border-b border-current/10 lg:hidden">
          <span class="text-xs font-bold uppercase tracking-wide opacity-50">Events</span>
          <button @click="sidebarOpen = false" class="opacity-50 hover:opacity-100 transition p-1">
            <font-awesome-icon icon="xmark" />
          </button>
        </div>

        <!-- Stats -->
        <div class="p-3 border-b border-current/10 space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <div v-for="[label, val] in [['Total', total], ['Upcoming', upcomingCount]]" :key="label"
              :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
              class="rounded-xl border p-3">
              <p class="text-2xl font-bold">{{ val }}</p>
              <p class="text-xs opacity-50 mt-0.5">{{ label }}</p>
            </div>
          </div>
          <div :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
            class="rounded-xl border p-3">
            <p class="text-2xl font-bold">{{ pastCount }}</p>
            <p class="text-xs opacity-50 mt-0.5">Past</p>
          </div>
        </div>

        <!-- Upcoming list -->
        <div class="flex-1 overflow-y-auto">
          <p class="px-3 pt-2.5 pb-1 text-xs font-bold uppercase tracking-wide opacity-50">Upcoming</p>
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

      <!-- ── Calendar panel ─────────────────────────────────────────────────── -->
      <div :class="panelCls()"
        class="flex-1 rounded-xl border shadow-md overflow-hidden flex flex-col min-h-0 relative z-[1]">

        <!-- Calendar toolbar -->
        <div class="shrink-0 flex items-center gap-2 border-b border-current/10 px-3 py-2.5 flex-wrap">
          <!-- Mobile: open sidebar -->
          <button @click="sidebarOpen = true"
            :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="lg:hidden rounded-lg border px-2 py-1 text-xs opacity-60 hover:opacity-100 transition">
            <font-awesome-icon icon="layer-group" /> Stats
          </button>
          <button @click="prevMonth" :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="rounded-lg border px-2 py-1 text-xs opacity-60 hover:opacity-100 transition">‹</button>
          <button @click="nextMonth" :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="rounded-lg border px-2 py-1 text-xs opacity-60 hover:opacity-100 transition">›</button>
          <button @click="goToday" :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
            class="rounded-lg border px-2 py-1 text-xs opacity-60 hover:opacity-100 transition">today</button>
          <h2 class="ml-1 text-sm font-bold">{{ MONTHS[calMonth] }} {{ calYear }}</h2>
        </div>

        <!-- Day-of-week header -->
        <div class="shrink-0 grid grid-cols-7 border-b border-current/10">
          <div v-for="d in DOW" :key="d"
            class="py-1.5 text-center text-xs font-semibold uppercase tracking-wide opacity-40">{{ d }}</div>
        </div>

        <!-- Grid -->
        <div class="flex-1 overflow-y-auto">
          <div class="grid grid-cols-7" style="grid-auto-rows: minmax(72px, 1fr)">
            <div v-for="(cell, ci) in calGrid.flat()" :key="ci"
              :class="[
                'border-b border-r border-current/10 p-1 overflow-hidden',
                !cell.cur ? 'opacity-30' : '',
                isToday(cell.date) ? (darkMode ? 'bg-accent-dark/10' : 'bg-accent-light/10') : '',
              ]"
            >
              <div class="flex justify-end mb-0.5">
                <span :class="[
                  'text-xs font-semibold rounded-full w-5 h-5 flex items-center justify-center',
                  isToday(cell.date)
                    ? (darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light')
                    : 'opacity-60',
                ]">{{ cell.date.getDate() }}</span>
              </div>
              <div class="space-y-0.5">
                <div v-for="e in eventsForDay(cell.date).slice(0, 3)" :key="e.id"
                  :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
                  class="flex items-center gap-1 cursor-pointer hover:opacity-70 transition"
                  @click="openEvent(e)"
                >
                  <span class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="darkMode ? 'bg-accent-dark' : 'bg-accent-light'"></span>
                  <span class="text-[10px] truncate leading-tight">{{ fmtTime(e.start_time) }} {{ e.title }}</span>
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
      <div v-else-if="!invites.length" class="flex items-center justify-center py-12 opacity-30 text-sm">No invites</div>
      <div v-else class="space-y-2">
        <div v-for="inv in invites" :key="inv.id"
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border p-4 shadow-sm"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold truncate">{{ inv.event_title }}</p>
              <p class="text-xs opacity-50 mt-0.5">{{ fmtDate(inv.event_start) }} · {{ fmtTime(inv.event_start) }} – {{ fmtTime(inv.event_end) }}</p>
              <p v-if="inv.event_category" class="text-xs opacity-40 mt-0.5">{{ inv.event_category }}</p>
            </div>
            <span class="shrink-0 text-xs font-semibold" :class="STATUS_COLOR[inv.status]">{{ inv.status }}</span>
          </div>
          <div v-if="inv.status === 'pending'" class="flex gap-2 mt-3">
            <button @click="respond(inv, 'accept')" :disabled="respondingId === inv.id"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50">Accept</button>
            <button @click="respond(inv, 'decline')" :disabled="respondingId === inv.id"
              class="rounded-lg border border-current/20 px-3 py-1.5 text-xs transition hover:opacity-80 disabled:opacity-50">Decline</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════ EVENT DETAIL MODAL ════════════════════════════ -->
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
      <div v-if="selectedEvent" class="fixed inset-0 z-50 flex items-center justify-center p-4"
        :class="darkMode ? 'bg-black/60' : 'bg-black/30'" @click.self="closeEvent">
        <div :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark' : 'bg-primary-bg-light border-accent-2 text-text-main-light'"
          class="w-full max-w-md rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

          <!-- Header -->
          <div class="flex items-center justify-between border-b border-current/10 px-5 py-3 shrink-0">
            <h3 class="text-sm font-bold flex items-center gap-2">
              <font-awesome-icon icon="calendar" class="opacity-60" /> Event Details
            </h3>
            <button @click="closeEvent" class="opacity-50 hover:opacity-100 transition">
              <font-awesome-icon icon="xmark" />
            </button>
          </div>

          <div class="p-5 space-y-4 overflow-y-auto">
            <h2 class="text-base font-bold">{{ selectedEvent.title }}</h2>
            <p v-if="selectedEvent.description" class="text-sm opacity-60">{{ selectedEvent.description }}</p>

            <!-- Times -->
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

            <!-- Meta -->
            <div class="text-xs space-y-1.5">
              <div v-if="selectedEvent.category" class="flex items-center gap-2">
                <font-awesome-icon icon="tag" class="opacity-40 w-3" /><span>{{ selectedEvent.category }}</span>
              </div>
              <div v-if="selectedEvent.owner" class="flex items-center gap-2">
                <font-awesome-icon icon="user" class="opacity-40 w-3" /><span>{{ selectedEvent.owner }}</span>
              </div>
              <div v-if="selectedEvent.address" class="flex items-center gap-2">
                <font-awesome-icon icon="location-dot" class="opacity-40 w-3" /><span>{{ selectedEvent.address }}</span>
              </div>
              <div v-if="selectedEvent.capacity" class="flex items-center gap-2">
                <font-awesome-icon icon="users" class="opacity-40 w-3" /><span>Capacity: {{ selectedEvent.capacity }}</span>
              </div>
              <div v-if="selectedEvent.accepted_count != null" class="flex items-center gap-2">
                <font-awesome-icon icon="check" class="opacity-40 w-3" />
                <span>{{ selectedEvent.accepted_count }} / {{ selectedEvent.invite_count }} accepted</span>
              </div>
            </div>

            <!-- Organizers -->
            <div v-if="selectedEvent.organizers?.length" class="text-xs">
              <p class="opacity-40 uppercase tracking-wide mb-1.5">Organizers</p>
              <div class="flex flex-wrap gap-1">
                <span v-for="o in selectedEvent.organizers" :key="o"
                  :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
                  class="rounded-full border px-2 py-0.5">{{ o }}</span>
              </div>
            </div>

            <!-- ── Invite people ─────────────────────────────────────────── -->
            <div class="border-t border-current/10 pt-4">
              <p class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">
                <font-awesome-icon icon="paper-plane" class="mr-1" /> Invite people
              </p>
              <div class="relative">
                <font-awesome-icon icon="magnifying-glass"
                  class="absolute left-3 top-1/2 -translate-y-1/2 text-xs opacity-40 pointer-events-none" />
                <input v-model="inviteSearch" type="text" placeholder="Search by name…"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border pl-8 pr-3 py-2 text-xs outline-none" />
              </div>

              <div v-if="filteredPeople.length" class="mt-1.5 space-y-1">
                <div v-for="p in filteredPeople" :key="p.id"
                  :class="darkMode ? 'border-accent-1 hover:bg-white/5' : 'border-accent-2 hover:bg-black/5'"
                  class="flex items-center justify-between rounded-lg border px-3 py-2 text-xs transition">
                  <span>{{ p.name }}</span>
                  <button @click="sendInvite(p.id, p.name)" :disabled="inviteSending || invitedNames.includes(p.name)"
                    :class="invitedNames.includes(p.name)
                      ? 'text-emerald-400 cursor-default'
                      : (darkMode ? 'text-accent-dark hover:opacity-80' : 'text-accent-light hover:opacity-80')"
                    class="font-bold transition disabled:opacity-50">
                    <font-awesome-icon :icon="invitedNames.includes(p.name) ? 'check' : 'plus'" />
                  </button>
                </div>
              </div>

              <p v-if="inviteError" class="mt-2 text-xs text-red-400">{{ inviteError }}</p>
              <p v-if="invitedNames.length" class="mt-2 text-xs text-emerald-400">
                <font-awesome-icon icon="check" /> Invited: {{ invitedNames.join(", ") }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ═══════════════════════ CREATE EVENT MODAL ════════════════════════════ -->
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
      <div v-if="createOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4"
        :class="darkMode ? 'bg-black/60' : 'bg-black/30'" @click.self="createOpen = false">
        <div :class="darkMode ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark [color-scheme:dark]' : 'bg-primary-bg-light border-accent-2 text-text-main-light [color-scheme:light]'"
          class="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

          <!-- Header -->
          <div class="flex items-center justify-between border-b border-current/10 px-5 py-3 shrink-0">
            <h3 class="text-sm font-bold flex items-center gap-2">
              <font-awesome-icon icon="calendar-plus" class="opacity-60" /> New Event
            </h3>
            <button @click="createOpen = false" class="opacity-50 hover:opacity-100 transition">
              <font-awesome-icon icon="xmark" />
            </button>
          </div>

          <!-- Body -->
          <div class="p-5 space-y-4 overflow-y-auto">
            <!-- Title -->
            <div>
              <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Title *</label>
              <input v-model="form.title" type="text" placeholder="Event title"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none" />
            </div>

            <!-- Description -->
            <div>
              <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Description</label>
              <textarea v-model="form.description" rows="2" placeholder="Describe the event…"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none" />
            </div>

            <!-- Start / End -->
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Start *</label>
                <input v-model="form.start_date" type="date"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none mb-1.5" />
                <input v-model="form.start_time" type="time"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">End *</label>
                <input v-model="form.end_date" type="date"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none mb-1.5" />
                <input v-model="form.end_time" type="time"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <!-- Category + Address -->
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Category</label>
                <select v-model="form.category_id"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none appearance-none">
                  <option :value="null">— None —</option>
                  <option v-for="c in formData.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </div>
              <div>
                <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Capacity</label>
                <input v-model="form.capacity" type="number" min="1" placeholder="Unlimited"
                  :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <!-- Address -->
            <div>
              <label class="text-xs opacity-50 uppercase tracking-wide block mb-1">Address</label>
              <select v-model="form.address_id"
                :class="darkMode ? 'bg-bubble-bg-dark border-accent-1 text-text-main-dark' : 'bg-bubble-bg-light border-accent-2 text-text-main-light'"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none appearance-none">
                <option :value="null">— None —</option>
                <option v-for="a in formData.addresses" :key="a.id" :value="a.id">{{ a.display }}</option>
              </select>
            </div>

            <!-- Toggles -->
            <div class="flex gap-6 text-xs">
              <label class="flex items-center gap-2 cursor-pointer select-none">
                <input v-model="form.public" type="checkbox" class="h-4 w-4 rounded" />
                <span>Public event</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer select-none">
                <input v-model="form.requires_registration" type="checkbox" class="h-4 w-4 rounded" />
                <span>Requires registration</span>
              </label>
            </div>

            <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
          </div>

          <!-- Footer -->
          <div class="flex items-center justify-end gap-2 border-t border-current/10 px-5 py-3 shrink-0">
            <button @click="createOpen = false"
              class="rounded-lg border border-current/20 px-4 py-1.5 text-xs transition hover:opacity-80">Cancel</button>
            <button @click="submitCreate" :disabled="creating"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="rounded-lg px-5 py-1.5 text-xs font-bold transition disabled:opacity-50">
              {{ creating ? "Saving…" : "Create Event" }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
