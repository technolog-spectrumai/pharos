<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useWalletStore } from "../stores/wallet";
import { api } from "../services/api";
import type { Obligation, Movement } from "../services/api";

const props = defineProps<{ darkMode: boolean }>();

const store = useWalletStore();
const { summary, loading, error, lastRefreshed } = storeToRefs(store);

// ── Obligations ───────────────────────────────────────────────────────────────
const obligations = ref<Obligation[]>([]);
const obligationsLoading = ref(false);
const obligationsError = ref<string | null>(null);

// ── Movements ─────────────────────────────────────────────────────────────────
const movements = ref<Movement[]>([]);
const movementsLoading = ref(false);
const movementsError = ref<string | null>(null);

// ── PIN modal ─────────────────────────────────────────────────────────────────
const pinOpen = ref(false);
const pinValue = ref("");
const pinError = ref("");
const pinLoading = ref(false);
const pendingObligationId = ref<number | null>(null);
const pendingObligation = ref<Obligation | null>(null);
const pendingObligationLabel = ref("");
const settleSuccess = ref<string | null>(null);
const currentPinToken = ref<string | null>(null);

// ── Fetchers ──────────────────────────────────────────────────────────────────
async function fetchObligations() {
  obligationsLoading.value = true;
  obligationsError.value = null;
  try {
    const res = await api.getObligations();
    obligations.value = res.obligations;
  } catch (e: any) {
    obligationsError.value = e.message ?? "Failed to load obligations";
  } finally {
    obligationsLoading.value = false;
  }
}

async function fetchMovements() {
  movementsLoading.value = true;
  movementsError.value = null;
  try {
    const res = await api.getMovements();
    movements.value = res.movements;
  } catch (e: any) {
    movementsError.value = e.message ?? "Failed to load movements";
  } finally {
    movementsLoading.value = false;
  }
}

function refreshAll() {
  store.fetchSummary();
  fetchObligations();
  fetchMovements();
}

onMounted(() => {
  store.fetchSummary();
  fetchObligations();
  fetchMovements();
});

// ── PIN flow ──────────────────────────────────────────────────────────────────
function openPinModal(ob: Obligation) {
  pendingObligationId.value = ob.id;
  pendingObligation.value = ob;
  pendingObligationLabel.value = `${ob.amount_display} ${ob.asset_unit} → ${ob.creditor_name}`;
  pinValue.value = "";
  pinError.value = "";
  settleSuccess.value = null;
  currentPinToken.value = null;
  pinOpen.value = true;
}

function closePinModal() {
  pinOpen.value = false;
  pendingObligationId.value = null;
  pendingObligation.value = null;
  currentPinToken.value = null;
  pinValue.value = "";
  pinError.value = "";
}

function pinDigit(d: string) {
  if (pinValue.value.length < 12) pinValue.value += d;
}

function pinBackspace() {
  pinValue.value = pinValue.value.slice(0, -1);
}

async function submitPin() {
  if (!pinValue.value) { pinError.value = "Enter your PIN."; return; }
  pinLoading.value = true;
  pinError.value = "";
  try {
    const res = await api.verifyPin(pinValue.value);
    if (!res.ok) {
      if (res.no_pin) {
        pinError.value = "No wallet PIN set. Set one via the portal first.";
      } else {
        pinError.value = res.error ?? "Incorrect PIN.";
      }
      pinValue.value = "";
      return;
    }
    currentPinToken.value = res.pin_token ?? null;
    // PIN verified — now fulfill
    await settlePending();
  } catch (e: any) {
    pinError.value = e.message ?? "Network error. Try again.";
  } finally {
    pinLoading.value = false;
  }
}

async function settlePending() {
  if (pendingObligationId.value === null) return;
  try {
    const res = await api.fulfillObligation(pendingObligationId.value, currentPinToken.value ?? undefined);
    if (res.ok) {
      settleSuccess.value = `Transfer ${res.transaction_reference} posted.`;
      pinOpen.value = false;
      // Remove from local list
      obligations.value = obligations.value.filter((o) => o.id !== pendingObligationId.value);
      // Refresh movements and summary
      fetchMovements();
      store.fetchSummary();
    } else {
      pinError.value = res.error ?? "Settlement failed.";
    }
  } catch (e: any) {
    pinError.value = e.message ?? "Settlement failed.";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function refreshedAt() {
  if (!lastRefreshed.value) return null;
  return lastRefreshed.value.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  overdue:  "bg-red-500/20 text-red-400",
  paid:     "bg-green-500/20 text-green-400",
  cancelled:"bg-gray-500/20 text-gray-400",
};

function card() {
  return props.darkMode ? "bg-bubble-bg-dark border-accent-1" : "bg-bubble-bg-light border-accent-2";
}
function inner() {
  return props.darkMode ? "bg-primary-bg-dark" : "bg-primary-bg-light";
}
</script>

<template>
  <div class="flex w-full flex-col gap-6 pb-8">

    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <h2 class="text-xl font-bold flex items-center gap-2">
        <font-awesome-icon icon="wallet" />Wallet
      </h2>
      <div class="flex items-center gap-3">
        <span v-if="refreshedAt()" class="text-xs opacity-40">as of {{ refreshedAt() }}</span>
        <button
          @click="refreshAll"
          :disabled="loading"
          :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
          class="inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm transition hover:opacity-80 disabled:opacity-40"
        >
          <font-awesome-icon :icon="loading ? 'spinner' : 'rotate-right'" :spin="loading" />
          Refresh
        </button>
      </div>
    </div>

    <!-- Settle success banner -->
    <div v-if="settleSuccess" class="rounded-lg border border-green-400/40 bg-green-400/10 px-4 py-2 text-sm text-green-400 flex items-center gap-2">
      <font-awesome-icon icon="check" />{{ settleSuccess }}
    </div>

    <div v-if="error" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ error }}</div>
    <div v-if="loading && !summary" class="flex items-center justify-center py-16 opacity-50">
      <font-awesome-icon icon="spinner" spin class="text-2xl" />
    </div>

    <template v-if="summary">

      <!-- ── Balances ── -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">My Balances</h3>
        <div v-if="summary.accounts.length === 0" class="opacity-40 text-sm">No accounts found.</div>
        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="acct in summary.accounts" :key="acct.code" :class="card()" class="rounded-xl border p-4 shadow-sm">
            <p class="text-xs opacity-50 font-mono">{{ acct.code }}</p>
            <p class="font-semibold text-sm mt-0.5">{{ acct.name }}</p>
            <div v-if="acct.holdings.length" class="mt-3 space-y-1.5">
              <div v-for="h in acct.holdings" :key="h.asset_unit" class="flex items-center justify-between">
                <span class="text-xs opacity-60">{{ h.asset_name }}</span>
                <span class="font-bold text-sm">{{ h.balance_display }} <span class="text-xs font-mono opacity-60">{{ h.asset_unit }}</span></span>
              </div>
            </div>
            <p v-else class="mt-2 text-xs opacity-40">No holdings</p>
          </div>
        </div>
      </section>

      <!-- ── Obligations ── -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60 flex items-center gap-2">
          <font-awesome-icon icon="file-contract" class="opacity-70" />Outstanding Obligations
        </h3>
        <div v-if="obligationsLoading" class="flex items-center gap-2 opacity-40 text-sm py-4">
          <font-awesome-icon icon="spinner" spin />Loading…
        </div>
        <div v-else-if="obligationsError" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ obligationsError }}</div>
        <div v-else-if="obligations.length === 0" class="opacity-40 text-sm">No outstanding obligations.</div>
        <div v-else class="space-y-3">
          <div
            v-for="ob in obligations"
            :key="ob.id"
            :class="[card(), ob.is_overdue ? (darkMode ? 'ring-2 ring-red-500/60' : 'ring-2 ring-red-400/60') : '']"
            class="rounded-xl border p-4 shadow-sm"
          >
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="space-y-1">
                <p class="font-semibold text-sm" :class="ob.is_overdue ? 'text-red-400' : ''">
                  <font-awesome-icon v-if="ob.is_overdue" icon="circle-exclamation" class="mr-1" />
                  <span v-if="ob.is_overdue">OVERDUE — </span>
                  {{ ob.amount_display }} <span class="font-mono text-xs opacity-70">{{ ob.asset_unit }}</span>
                </p>
                <p class="text-xs opacity-60">To: <span class="font-semibold">{{ ob.creditor_name }}</span> <span class="font-mono opacity-40">({{ ob.creditor_code }})</span></p>
                <p v-if="ob.order_reference" class="text-xs opacity-50">Order: {{ ob.order_reference }}</p>
                <p class="text-xs opacity-40 font-mono">{{ ob.reference }}</p>
              </div>
              <div class="shrink-0 flex flex-row sm:flex-col sm:items-end items-center gap-3">
                <p class="text-xs" :class="ob.is_overdue ? 'text-red-400 font-semibold' : 'opacity-60'">
                  Due {{ fmt(ob.due_at) }}
                </p>
                <button
                  @click="openPinModal(ob)"
                  :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                  class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold shadow-sm transition hover:opacity-90"
                >
                  <font-awesome-icon icon="bolt" />Settle
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ── Pending Charges ── -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">Pending Charges</h3>
        <div v-if="summary.pending_charges.length === 0" class="opacity-40 text-sm">No pending charges.</div>
        <div v-else :class="card()" class="rounded-xl border shadow-sm overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm min-w-[480px]">
              <thead>
                <tr class="border-b border-current/10 text-xs uppercase tracking-wide opacity-50">
                  <th class="px-4 py-2.5 text-left">Metric</th>
                  <th class="px-4 py-2.5 text-left">Tariff</th>
                  <th class="px-4 py-2.5 text-left">Qty</th>
                  <th class="px-4 py-2.5 text-right">Charge</th>
                  <th class="px-4 py-2.5 text-left">Date</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(ch, i) in summary.pending_charges" :key="i" class="border-b border-current/5 last:border-0">
                  <td class="px-4 py-2.5 font-mono text-xs">{{ ch.metric_code }}</td>
                  <td class="px-4 py-2.5 text-xs opacity-70">{{ ch.tariff_name }}</td>
                  <td class="px-4 py-2.5 text-xs">{{ ch.quantity }} {{ ch.unit }}</td>
                  <td class="px-4 py-2.5 text-right font-semibold text-xs">{{ ch.amount_display }} <span class="opacity-50">{{ ch.asset_unit }}</span></td>
                  <td class="px-4 py-2.5 text-xs opacity-50">{{ fmt(ch.occurred_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ── Open Invoices ── -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">Open Invoices</h3>
        <div v-if="summary.open_invoices.length === 0" class="opacity-40 text-sm">No open invoices.</div>
        <div v-else :class="card()" class="rounded-xl border shadow-sm overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm min-w-[480px]">
              <thead>
                <tr class="border-b border-current/10 text-xs uppercase tracking-wide opacity-50">
                  <th class="px-4 py-2.5 text-left">Title</th>
                  <th class="px-4 py-2.5 text-left">Issued by</th>
                  <th class="px-4 py-2.5 text-right">Amount</th>
                  <th class="px-4 py-2.5 text-center">Status</th>
                  <th class="px-4 py-2.5 text-left">Due</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="inv in summary.open_invoices" :key="inv.id" class="border-b border-current/5 last:border-0">
                  <td class="px-4 py-2.5 text-xs font-semibold">{{ inv.title }}</td>
                  <td class="px-4 py-2.5 text-xs opacity-60">{{ inv.issued_by_name ?? "—" }}</td>
                  <td class="px-4 py-2.5 text-right font-bold text-xs">{{ inv.amount }} <span class="opacity-50">{{ inv.currency }}</span></td>
                  <td class="px-4 py-2.5 text-center">
                    <span :class="STATUS_COLORS[inv.status] ?? 'bg-gray-500/20 text-gray-400'" class="rounded-full px-2 py-0.5 text-xs capitalize">{{ inv.status }}</span>
                  </td>
                  <td class="px-4 py-2.5 text-xs opacity-50">{{ fmt(inv.due_date) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ── Totals ── -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">Totals</h3>
        <div :class="card()" class="flex flex-wrap gap-4 rounded-xl border p-4 shadow-sm">
          <div>
            <p class="text-xs opacity-50">Open invoice total</p>
            <p class="mt-1 text-lg font-bold">{{ summary.totals.total_open_invoice_amount }}</p>
          </div>
          <template v-for="(amount, unit) in summary.totals.total_pending_by_asset" :key="unit">
            <div>
              <p class="text-xs opacity-50">Pending charges ({{ unit }})</p>
              <p class="mt-1 text-lg font-bold">{{ amount }} <span class="text-sm font-mono opacity-60">{{ unit }}</span></p>
            </div>
          </template>
          <div v-if="!summary.open_invoices.length && !summary.pending_charges.length" class="opacity-40 text-sm self-center">All clear — no outstanding charges</div>
        </div>
      </section>

    </template>

    <!-- ── Recent Movements ── -->
    <section>
      <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60 flex items-center gap-2">
        <font-awesome-icon icon="arrow-right-arrow-left" class="opacity-70" />Recent Movements
      </h3>
      <div v-if="movementsLoading" class="flex items-center gap-2 opacity-40 text-sm py-4">
        <font-awesome-icon icon="spinner" spin />Loading…
      </div>
      <div v-else-if="movementsError" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ movementsError }}</div>
      <div v-else-if="movements.length === 0" class="opacity-40 text-sm">No movements yet.</div>
      <div v-else :class="card()" class="rounded-xl border shadow-sm divide-y divide-current/5">
        <div
          v-for="mv in movements"
          :key="mv.transaction_reference + mv.created_at"
          :class="inner()"
          class="first:rounded-t-xl last:rounded-b-xl px-4 py-3"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs opacity-60 font-mono truncate">{{ mv.transaction_reference }}</span>
            <span
              class="shrink-0 font-mono font-bold text-sm"
              :class="mv.is_credit ? 'text-green-400' : 'text-red-400'"
            >
              {{ mv.is_credit ? '+' : '' }}{{ mv.amount_display }}
              <span class="text-xs font-normal opacity-60">{{ mv.asset_unit }}</span>
            </span>
          </div>
          <div class="mt-1 flex justify-between text-xs opacity-50">
            <span class="font-mono">{{ mv.account_code }}</span>
            <span>{{ fmtDateTime(mv.created_at) }}</span>
          </div>
        </div>
      </div>
    </section>

  </div>

  <!-- ── PIN Modal ── -->
  <Teleport to="body">
    <Transition name="pin-fade">
      <div
        v-if="pinOpen"
        class="fixed inset-0 z-[800] flex items-end sm:items-center justify-center p-4"
        style="background: rgba(0,0,0,0.6)"
        @click.self="closePinModal"
      >
        <div
          :class="darkMode ? 'bg-bubble-bg-dark text-white border-accent-1' : 'bg-bubble-bg-light text-gray-900 border-gray-200'"
          class="w-full max-w-xs rounded-2xl border shadow-2xl overflow-hidden"
          @click.stop
        >
          <!-- Header -->
          <div class="px-5 pt-5 pb-4 border-b border-current/10">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-bold uppercase tracking-wide">PIN required</p>
                <h2 class="mt-1 text-lg font-bold flex items-center gap-2">
                  <font-awesome-icon icon="lock" />Settle obligation
                </h2>
                <p class="mt-1 text-sm font-semibold">{{ pendingObligation?.amount_display }} {{ pendingObligation?.asset_unit }}</p>
                <div class="mt-1 text-xs opacity-60 space-y-0.5">
                  <p>To: <span class="font-semibold">{{ pendingObligation?.creditor_name }}</span></p>
                  <p>From wallet: <span class="font-semibold">{{ pendingObligation?.debtor_code }}</span></p>
                  <p v-if="pendingObligation?.order_reference" class="opacity-70">Ref: {{ pendingObligation.order_reference }}</p>
                </div>
              </div>
              <button @click="closePinModal" class="opacity-40 hover:opacity-80 transition p-1 shrink-0">
                <font-awesome-icon icon="xmark" />
              </button>
            </div>
          </div>

          <!-- PIN dots display -->
          <div class="px-5 pt-4 pb-2">
            <div class="flex justify-center gap-3 mb-1">
              <span
                v-for="i in Math.max(4, pinValue.length)"
                :key="i"
                class="h-3 w-3 rounded-full border-2 transition-all"
                :class="i <= pinValue.length
                  ? (darkMode ? 'bg-accent-dark border-accent-dark' : 'bg-accent-light border-accent-light')
                  : 'border-current/30 bg-transparent'"
              ></span>
            </div>
            <p v-if="pinError" class="text-center text-xs text-red-400 mt-2">{{ pinError }}</p>
          </div>

          <!-- Numeric keypad -->
          <div class="px-5 pb-3 grid grid-cols-3 gap-2">
            <button
              v-for="d in ['1','2','3','4','5','6','7','8','9','','0','⌫']"
              :key="d"
              @click="d === '⌫' ? pinBackspace() : d ? pinDigit(d) : null"
              :disabled="d === ''"
              class="h-12 rounded-xl text-lg font-bold transition active:scale-95 disabled:invisible"
              :class="d === '⌫'
                ? 'text-current opacity-60 hover:opacity-100'
                : (darkMode ? 'bg-primary-bg-dark hover:bg-accent-dark/20' : 'bg-primary-bg-light hover:bg-accent-light/10 border border-current/10')"
            >{{ d }}</button>
          </div>

          <!-- Confirm -->
          <div class="px-5 pb-5">
            <button
              @click="submitPin"
              :disabled="pinLoading || !pinValue"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold shadow-sm transition hover:opacity-90 disabled:opacity-50"
            >
              <font-awesome-icon :icon="pinLoading ? 'spinner' : 'bolt'" :spin="pinLoading" />
              {{ pinLoading ? "Verifying…" : "Confirm transfer" }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.pin-fade-enter-active, .pin-fade-leave-active { transition: opacity 0.2s ease; }
.pin-fade-enter-from, .pin-fade-leave-to { opacity: 0; }
</style>
