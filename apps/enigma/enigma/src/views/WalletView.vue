<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useWalletStore } from "../stores/wallet";
import { api } from "../services/api";
import type { Obligation, Movement, BourseCenter, BourseProposal } from "../services/api";

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

// ── Bourse state ──────────────────────────────────────────────────────────────
type WalletTab = "wallet" | "exchange";
const walletTab = ref<WalletTab>("wallet");
type ExchangeTab = "market" | "proposals" | "tape";
const exchangeTab = ref<ExchangeTab>("market");

const bourse = ref<BourseCenter | null>(null);
const bourseLoading = ref(false);
const bourseError = ref<string | null>(null);

// Create form
const createOpen = ref(false);
const createAccountId = ref<number | null>(null);
const createOfferAssetId = ref<number | null>(null);
const createOfferAmount = ref("");
const createRequestAssetId = ref<number | null>(null);
const createExpectedAmount = ref("");
const createNote = ref("");
const createSaving = ref(false);
const createError = ref<string | null>(null);

// Accept flow (needs PIN)
const acceptingId = ref<number | null>(null);
const acceptAccountId = ref<number | null>(null);
const acceptPinOpen = ref(false);
const acceptPinValue = ref("");
const acceptPinError = ref("");
const acceptPinLoading = ref(false);
const acceptPinToken = ref<string | null>(null);

// Action feedback
const actionLoading = ref<number | null>(null);
const actionError = ref<string | null>(null);

async function fetchBourse() {
  bourseLoading.value = true;
  bourseError.value = null;
  try {
    bourse.value = await api.getBourseCenter();
  } catch (e: any) {
    bourseError.value = e.message ?? "Failed to load exchange";
  } finally {
    bourseLoading.value = false;
  }
}

function openExchangeTab() {
  walletTab.value = "exchange";
  if (!bourse.value) fetchBourse();
}

function openAcceptFlow(proposal: BourseProposal) {
  acceptingId.value = proposal.id;
  acceptAccountId.value = bourse.value?.accounts[0]?.id ?? null;
  acceptPinValue.value = "";
  acceptPinError.value = "";
  acceptPinToken.value = null;
  acceptPinOpen.value = true;
}

async function submitAcceptPin() {
  if (!acceptPinValue.value) { acceptPinError.value = "Enter your PIN."; return; }
  acceptPinLoading.value = true;
  acceptPinError.value = "";
  try {
    const res = await api.verifyPin(acceptPinValue.value);
    if (!res.ok) { acceptPinError.value = res.error ?? "Incorrect PIN."; acceptPinValue.value = ""; return; }
    acceptPinToken.value = res.pin_token ?? null;
    await doAccept();
  } catch (e: any) {
    acceptPinError.value = e.message ?? "Network error.";
  } finally {
    acceptPinLoading.value = false;
  }
}

async function doAccept() {
  if (!acceptingId.value || !acceptAccountId.value) return;
  try {
    const res = await api.acceptExchangeRequest(acceptingId.value, acceptAccountId.value, acceptPinToken.value ?? undefined);
    if (res.ok) {
      acceptPinOpen.value = false;
      await fetchBourse();
    } else {
      acceptPinError.value = res.error ?? "Accept failed.";
    }
  } catch (e: any) {
    acceptPinError.value = e.message ?? "Accept failed.";
  }
}

async function rejectProposal(id: number) {
  actionLoading.value = id;
  actionError.value = null;
  try {
    await api.rejectExchangeRequest(id);
    await fetchBourse();
  } catch (e: any) {
    actionError.value = e.message ?? "Failed.";
  } finally {
    actionLoading.value = null;
  }
}

async function cancelProposal(id: number) {
  actionLoading.value = id;
  actionError.value = null;
  try {
    await api.cancelExchangeRequest(id);
    await fetchBourse();
  } catch (e: any) {
    actionError.value = e.message ?? "Failed.";
  } finally {
    actionLoading.value = null;
  }
}

async function submitCreate() {
  if (!createAccountId.value || !createOfferAssetId.value || !createRequestAssetId.value || !createOfferAmount.value || !createExpectedAmount.value) {
    createError.value = "Fill in all required fields."; return;
  }
  createSaving.value = true;
  createError.value = null;
  try {
    await api.createExchangeRequest({
      requester_account_id: createAccountId.value,
      offer_asset_id: createOfferAssetId.value,
      offer_amount: createOfferAmount.value,
      request_asset_id: createRequestAssetId.value,
      expected_amount: createExpectedAmount.value,
      note: createNote.value,
    });
    createOpen.value = false;
    createOfferAmount.value = "";
    createExpectedAmount.value = "";
    createNote.value = "";
    await fetchBourse();
  } catch (e: any) {
    createError.value = e.message ?? "Failed to create proposal.";
  } finally {
    createSaving.value = false;
  }
}

const impliedRate = computed(() => {
  const o = parseFloat(createOfferAmount.value);
  const r = parseFloat(createExpectedAmount.value);
  if (!o || !r || o === 0) return null;
  return (r / o).toFixed(6);
});

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

    <!-- Top tab bar -->
    <div class="flex gap-1">
      <button
        @click="walletTab = 'wallet'"
        :class="[
          'rounded-lg px-4 py-2 text-sm font-semibold border transition',
          walletTab === 'wallet'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : (darkMode ? 'border-accent-1 opacity-60 hover:opacity-80' : 'border-accent-2 opacity-60 hover:opacity-80')
        ]"
      ><font-awesome-icon icon="wallet" class="mr-1.5" />Wallet</button>
      <button
        @click="openExchangeTab()"
        :class="[
          'rounded-lg px-4 py-2 text-sm font-semibold border transition',
          walletTab === 'exchange'
            ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
            : (darkMode ? 'border-accent-1 opacity-60 hover:opacity-80' : 'border-accent-2 opacity-60 hover:opacity-80')
        ]"
      ><font-awesome-icon icon="arrow-right-arrow-left" class="mr-1.5" />Exchange</button>
    </div>

    <!-- ── WALLET TAB ── -->
    <template v-if="walletTab === 'wallet'">

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

    </template><!-- end wallet tab -->

    <!-- ── EXCHANGE TAB ── -->
    <template v-if="walletTab === 'exchange'">

      <!-- Loading / error -->
      <div v-if="bourseLoading" class="flex items-center justify-center py-16 opacity-50">
        <font-awesome-icon icon="spinner" spin class="text-2xl" />
      </div>
      <div v-else-if="bourseError" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ bourseError }}</div>

      <template v-else-if="bourse">

        <!-- Sub-tab bar + actions -->
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex gap-1">
            <button v-for="t in (['market','proposals','tape'] as ExchangeTab[])" :key="t"
              @click="exchangeTab = t"
              class="rounded-lg px-3 py-1.5 text-xs font-semibold border transition capitalize"
              :class="exchangeTab === t
                ? (darkMode ? 'bg-accent-dark text-primary-bg-dark border-transparent' : 'bg-accent-light text-primary-bg-light border-transparent')
                : (darkMode ? 'border-accent-1 opacity-60 hover:opacity-80' : 'border-accent-2 opacity-60 hover:opacity-80')"
            >
              {{ t === 'market' ? `Market (${bourse.public_asks.length})` : t === 'proposals' ? `Proposals (${bourse.pending_incoming + bourse.pending_outgoing})` : `Tape (${bourse.recent_trades.length})` }}
            </button>
          </div>
          <div class="flex items-center gap-2">
            <button @click="fetchBourse()" :class="darkMode ? 'border-accent-1' : 'border-accent-2'" class="rounded-lg border px-2.5 py-1.5 text-xs transition hover:opacity-80">
              <font-awesome-icon icon="rotate-right" />
            </button>
            <button @click="createOpen = !createOpen"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90 flex items-center gap-1.5"
            >
              <font-awesome-icon icon="plus" />New ask
            </button>
          </div>
        </div>

        <!-- Pair stats bar -->
        <div v-if="bourse.pair_stats.length" class="flex flex-wrap gap-2">
          <div v-for="ps in bourse.pair_stats" :key="ps.pair"
            :class="darkMode ? 'bg-primary-bg-dark border-accent-1' : 'bg-primary-bg-light border-accent-2'"
            class="rounded-lg border px-3 py-1.5 text-xs"
          >
            <span class="font-semibold font-mono">{{ ps.pair }}</span>
            <span class="opacity-50 ml-2">{{ ps.ask_count }} ask{{ ps.ask_count !== 1 ? 's' : '' }}</span>
            <span class="opacity-40 ml-1">@ {{ parseFloat(ps.last_rate).toFixed(4) }}</span>
          </div>
        </div>

        <!-- Create form -->
        <div v-if="createOpen" :class="card()" class="rounded-2xl border p-5 shadow-sm space-y-4">
          <p class="font-semibold text-sm flex items-center gap-2"><font-awesome-icon icon="plus" />New exchange proposal</p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label class="block text-xs font-semibold opacity-50 uppercase tracking-wide mb-1">Pay from account</label>
              <select v-model="createAccountId" class="rounded-lg border px-3 py-2 text-xs outline-none w-full">
                <option :value="null">— choose —</option>
                <option v-for="acc in bourse.accounts" :key="acc.id" :value="acc.id">{{ acc.code }} ({{ acc.name }})</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold opacity-50 uppercase tracking-wide mb-1">You offer</label>
              <div class="flex gap-2">
                <select v-model="createOfferAssetId" class="rounded-lg border px-3 py-2 text-xs outline-none flex-1">
                  <option :value="null">Asset</option>
                  <option v-for="a in bourse.assets" :key="a.id" :value="a.id">{{ a.unit_name }}</option>
                </select>
                <input v-model="createOfferAmount" type="text" inputmode="decimal" placeholder="Amount" class="rounded-lg border px-3 py-2 text-xs outline-none w-28" />
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold opacity-50 uppercase tracking-wide mb-1">You request</label>
              <div class="flex gap-2">
                <select v-model="createRequestAssetId" class="rounded-lg border px-3 py-2 text-xs outline-none flex-1">
                  <option :value="null">Asset</option>
                  <option v-for="a in bourse.assets" :key="a.id" :value="a.id">{{ a.unit_name }}</option>
                </select>
                <input v-model="createExpectedAmount" type="text" inputmode="decimal" placeholder="Amount" class="rounded-lg border px-3 py-2 text-xs outline-none w-28" />
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold opacity-50 uppercase tracking-wide mb-1">Note (optional)</label>
              <input v-model="createNote" type="text" placeholder="e.g. price negotiable" class="rounded-lg border px-3 py-2 text-xs outline-none w-full" />
            </div>
          </div>
          <p v-if="impliedRate" class="text-xs opacity-50">Implied rate: <span class="font-semibold font-mono">{{ impliedRate }}</span></p>
          <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
          <div class="flex gap-2">
            <button @click="submitCreate()" :disabled="createSaving"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="rounded-lg px-4 py-2 text-xs font-bold transition hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
            >
              <font-awesome-icon :icon="createSaving ? 'spinner' : 'bolt'" :spin="createSaving" />
              {{ createSaving ? 'Posting…' : 'Post ask' }}
            </button>
            <button @click="createOpen = false" class="rounded-lg border border-current/20 px-3 py-2 text-xs opacity-60 hover:opacity-80">Cancel</button>
          </div>
        </div>

        <!-- Market tab -->
        <div v-if="exchangeTab === 'market'">
          <div v-if="bourse.public_asks.length === 0" class="flex flex-col items-center justify-center py-12 opacity-40 gap-3">
            <font-awesome-icon icon="arrow-right-arrow-left" class="text-4xl" />
            <p class="text-sm">No public asks right now</p>
          </div>
          <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div v-for="ask in bourse.public_asks" :key="ask.id" :class="card()" class="rounded-xl border p-4 shadow-sm space-y-2">
              <div class="flex items-start justify-between gap-2">
                <span class="font-semibold text-sm font-mono">{{ ask.pair }}</span>
                <span class="text-[10px] rounded-full px-2 py-0.5 font-semibold bg-blue-500/20 text-blue-400">public ask</span>
              </div>
              <div class="text-xs space-y-0.5">
                <p><span class="opacity-50">Offers:</span> <span class="font-semibold">{{ ask.offer_amount }} {{ ask.offer_asset }}</span></p>
                <p><span class="opacity-50">Wants:</span> <span class="font-semibold">{{ ask.request_amount }} {{ ask.request_asset }}</span></p>
                <p><span class="opacity-50">Rate:</span> <span class="font-mono">{{ parseFloat(ask.exchange_rate).toFixed(6) }}</span></p>
                <p><span class="opacity-50">From:</span> {{ ask.requester }}</p>
                <p v-if="ask.note" class="opacity-50 italic">{{ ask.note }}</p>
              </div>
              <button @click="openAcceptFlow(ask)"
                :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                class="w-full rounded-lg py-1.5 text-xs font-bold transition hover:opacity-90 flex items-center justify-center gap-1.5"
              >
                <font-awesome-icon icon="bolt" />Accept trade
              </button>
            </div>
          </div>
        </div>

        <!-- Proposals tab -->
        <div v-if="exchangeTab === 'proposals'">
          <p v-if="actionError" class="text-xs text-red-400 mb-2">{{ actionError }}</p>
          <div v-if="bourse.proposals.length === 0" class="flex flex-col items-center justify-center py-12 opacity-40 gap-3">
            <font-awesome-icon icon="file-contract" class="text-4xl" />
            <p class="text-sm">No proposals yet</p>
          </div>
          <div v-else class="space-y-3">
            <div v-for="prop in bourse.proposals" :key="prop.id" :class="card()" class="rounded-xl border p-4 shadow-sm">
              <div class="flex items-start justify-between gap-3 flex-wrap">
                <div class="space-y-0.5 text-xs">
                  <div class="flex items-center gap-2">
                    <span class="text-[10px] rounded-full px-2 py-0.5 font-semibold"
                      :class="{
                        'bg-yellow-500/20 text-yellow-400': prop.status === 'pending',
                        'bg-green-500/20 text-green-400': prop.status === 'accepted',
                        'bg-red-500/20 text-red-400': prop.status === 'rejected' || prop.status === 'cancelled',
                      }">{{ prop.status }}</span>
                    <span class="text-[10px] rounded-full px-2 py-0.5 font-semibold opacity-60 border border-current/20">
                      {{ prop.direction }}
                    </span>
                    <span class="font-semibold font-mono">{{ prop.pair }}</span>
                  </div>
                  <p><span class="opacity-50">Offer:</span> {{ prop.offer_amount }} {{ prop.offer_asset }} → <span class="font-semibold">{{ prop.request_amount }} {{ prop.request_asset }}</span></p>
                  <p><span class="opacity-50">Rate:</span> <span class="font-mono">{{ parseFloat(prop.exchange_rate).toFixed(6) }}</span></p>
                  <p><span class="opacity-50">{{ prop.direction === 'outgoing' ? 'To' : 'From' }}:</span> {{ prop.direction === 'outgoing' ? (prop.counterparty ?? 'public') : prop.requester }}</p>
                  <p v-if="prop.note" class="opacity-40 italic">{{ prop.note }}</p>
                  <p class="opacity-30">{{ fmtDateTime(prop.created_at) }}</p>
                </div>
                <div v-if="prop.status === 'pending'" class="flex flex-col gap-1.5 shrink-0">
                  <button v-if="prop.direction === 'incoming'"
                    @click="openAcceptFlow(prop)"
                    :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
                    class="rounded-lg px-3 py-1.5 text-xs font-bold transition hover:opacity-90 flex items-center gap-1"
                  ><font-awesome-icon icon="check" />Accept</button>
                  <button v-if="prop.direction === 'incoming'"
                    @click="rejectProposal(prop.id)"
                    :disabled="actionLoading === prop.id"
                    class="rounded-lg border border-red-400/40 text-red-400 px-3 py-1.5 text-xs font-semibold transition hover:opacity-80 disabled:opacity-50 flex items-center gap-1"
                  ><font-awesome-icon :icon="actionLoading === prop.id ? 'spinner' : 'xmark'" :spin="actionLoading === prop.id" />Reject</button>
                  <button v-if="prop.direction === 'outgoing'"
                    @click="cancelProposal(prop.id)"
                    :disabled="actionLoading === prop.id"
                    class="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-semibold opacity-60 transition hover:opacity-80 disabled:opacity-50 flex items-center gap-1"
                  ><font-awesome-icon :icon="actionLoading === prop.id ? 'spinner' : 'xmark'" :spin="actionLoading === prop.id" />Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Trade tape tab -->
        <div v-if="exchangeTab === 'tape'">
          <div v-if="bourse.recent_trades.length === 0" class="flex flex-col items-center justify-center py-12 opacity-40 gap-3">
            <font-awesome-icon icon="list" class="text-4xl" />
            <p class="text-sm">No settled trades yet</p>
          </div>
          <div v-else class="space-y-2">
            <div v-for="trade in bourse.recent_trades" :key="trade.id" :class="card()" class="rounded-xl border px-4 py-3 shadow-sm">
              <div class="flex items-start justify-between gap-3 flex-wrap text-xs">
                <div class="space-y-0.5">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold font-mono">{{ trade.pair }}</span>
                    <span class="text-[10px] rounded-full px-2 py-0.5 bg-green-500/20 text-green-400 font-semibold">settled</span>
                    <span class="text-[10px] opacity-50 rounded-full px-2 py-0.5 border border-current/20">{{ trade.direction }}</span>
                  </div>
                  <p>{{ trade.offer_amount }} {{ trade.offer_asset }} ⇄ {{ trade.request_amount }} {{ trade.request_asset }}</p>
                  <p class="opacity-50">{{ trade.requester }} ↔ {{ trade.counterparty ?? '—' }}</p>
                  <p class="opacity-30">{{ trade.responded_at ? fmtDateTime(trade.responded_at) : fmtDateTime(trade.created_at) }}</p>
                </div>
                <div class="text-[10px] opacity-40 font-mono space-y-0.5 text-right">
                  <p v-if="trade.response_note" class="opacity-60 not-italic text-left">{{ trade.response_note }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

      </template>
    </template><!-- end exchange tab -->

  </div>

  <!-- ── Accept PIN Modal ── -->
  <Teleport to="body">
    <Transition name="pin-fade">
      <div v-if="acceptPinOpen" class="fixed inset-0 z-[800] flex items-end sm:items-center justify-center p-4" style="background:rgba(0,0,0,0.6)" @click.self="acceptPinOpen = false">
        <div :class="darkMode ? 'bg-bubble-bg-dark text-white border-accent-1' : 'bg-bubble-bg-light text-gray-900 border-gray-200'" class="w-full max-w-xs rounded-2xl border shadow-2xl overflow-hidden">
          <div class="px-5 pt-5 pb-4 border-b border-current/10 flex items-start justify-between gap-3">
            <div>
              <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-bold uppercase tracking-wide">PIN required</p>
              <h2 class="mt-1 text-lg font-bold flex items-center gap-2"><font-awesome-icon icon="bolt" />Accept trade</h2>
              <div v-if="acceptAccountId && bourse" class="mt-2 text-xs space-y-1">
                <div>
                  <label class="opacity-50">Receive into account</label>
                  <select v-model="acceptAccountId" class="rounded-lg border px-3 py-1.5 text-xs outline-none w-full mt-0.5">
                    <option v-for="acc in bourse.accounts" :key="acc.id" :value="acc.id">{{ acc.code }}</option>
                  </select>
                </div>
              </div>
            </div>
            <button @click="acceptPinOpen = false" class="opacity-40 hover:opacity-80 p-1 shrink-0"><font-awesome-icon icon="xmark" /></button>
          </div>
          <div class="px-5 pt-4 pb-2">
            <div class="flex justify-center gap-3 mb-1">
              <span v-for="i in 6" :key="i" class="h-3 w-3 rounded-full border-2 transition-colors"
                :class="acceptPinValue.length >= i ? (darkMode ? 'bg-accent-dark border-accent-dark' : 'bg-accent-light border-accent-light') : 'border-current/30 bg-transparent'"
              ></span>
            </div>
            <p v-if="acceptPinError" class="text-center text-xs text-red-400 mt-2">{{ acceptPinError }}</p>
          </div>
          <div class="grid grid-cols-3 gap-px p-3">
            <button v-for="d in ['1','2','3','4','5','6','7','8','9','','0','⌫']" :key="d"
              @click="d === '⌫' ? (acceptPinValue = acceptPinValue.slice(0,-1)) : (d && acceptPinValue.length < 12 && (acceptPinValue += d))"
              :disabled="!d || acceptPinLoading"
              :class="darkMode ? 'bg-primary-bg-dark hover:bg-white/5' : 'bg-primary-bg-light hover:bg-black/5'"
              class="rounded-xl py-3 text-lg font-semibold transition disabled:opacity-0"
            >{{ d }}</button>
          </div>
          <div class="px-3 pb-3">
            <button @click="submitAcceptPin()" :disabled="acceptPinLoading || !acceptPinValue"
              :class="darkMode ? 'bg-accent-dark text-primary-bg-dark' : 'bg-accent-light text-primary-bg-light'"
              class="w-full rounded-xl py-3 font-bold text-sm transition hover:opacity-85 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <font-awesome-icon :icon="acceptPinLoading ? 'spinner' : 'bolt'" :spin="acceptPinLoading" />
              {{ acceptPinLoading ? 'Verifying…' : 'Confirm trade' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

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
