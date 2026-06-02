<script setup lang="ts">
import { onMounted, computed } from "vue";
import { storeToRefs } from "pinia";
import { useWalletStore } from "../stores/wallet";

defineProps<{ darkMode: boolean }>();

const store = useWalletStore();
const { summary, loading, error, lastRefreshed } = storeToRefs(store);

onMounted(() => store.fetchSummary());

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function refreshedAt() {
  if (!lastRefreshed.value) return null;
  return lastRefreshed.value.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  overdue: "bg-red-500/20 text-red-400",
  paid: "bg-green-500/20 text-green-400",
  cancelled: "bg-gray-500/20 text-gray-400",
};
</script>

<template>
  <div class="flex w-full flex-col gap-6 pb-8">

    <!-- Header -->
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-bold flex items-center gap-2">
        <font-awesome-icon icon="wallet" />
        Wallet
      </h2>
      <div class="flex items-center gap-3">
        <span v-if="refreshedAt()" class="text-xs opacity-40">as of {{ refreshedAt() }}</span>
        <button
          @click="store.fetchSummary()"
          :disabled="loading"
          :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
          class="inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm transition hover:opacity-80 disabled:opacity-40"
        >
          <font-awesome-icon :icon="loading ? 'spinner' : 'rotate-right'" :spin="loading" />
          Refresh
        </button>
      </div>
    </div>

    <div v-if="error" class="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-2 text-sm text-red-400">{{ error }}</div>

    <div v-if="loading && !summary" class="flex items-center justify-center py-16 opacity-50">
      <font-awesome-icon icon="spinner" spin class="text-2xl" />
    </div>

    <template v-if="summary">

      <!-- Section 1: Balances -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">My Balances</h3>
        <div v-if="summary.accounts.length === 0" class="opacity-40 text-sm">No accounts found.</div>
        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="acct in summary.accounts"
            :key="acct.code"
            :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
            class="rounded-xl border p-4 shadow-sm"
          >
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

      <!-- Section 2: Pending Charges -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">Pending Charges</h3>
        <div v-if="summary.pending_charges.length === 0" class="opacity-40 text-sm">No pending charges.</div>
        <div v-else
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border shadow-sm overflow-hidden"
        >
          <table class="w-full text-sm">
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
              <tr
                v-for="(ch, i) in summary.pending_charges"
                :key="i"
                class="border-b border-current/5 last:border-0"
              >
                <td class="px-4 py-2.5 font-mono text-xs">{{ ch.metric_code }}</td>
                <td class="px-4 py-2.5 text-xs opacity-70">{{ ch.tariff_name }}</td>
                <td class="px-4 py-2.5 text-xs">{{ ch.quantity }} {{ ch.unit }}</td>
                <td class="px-4 py-2.5 text-right font-semibold text-xs">
                  {{ ch.amount_display }} <span class="opacity-50">{{ ch.asset_unit }}</span>
                </td>
                <td class="px-4 py-2.5 text-xs opacity-50">{{ fmt(ch.occurred_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Section 3: Open Invoices -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">Open Invoices</h3>
        <div v-if="summary.open_invoices.length === 0" class="opacity-40 text-sm">No open invoices.</div>
        <div v-else
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="rounded-xl border shadow-sm overflow-hidden"
        >
          <table class="w-full text-sm">
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
              <tr
                v-for="inv in summary.open_invoices"
                :key="inv.id"
                class="border-b border-current/5 last:border-0"
              >
                <td class="px-4 py-2.5 text-xs font-semibold">{{ inv.title }}</td>
                <td class="px-4 py-2.5 text-xs opacity-60">{{ inv.issued_by_name ?? "—" }}</td>
                <td class="px-4 py-2.5 text-right font-bold text-xs">
                  {{ inv.amount }} <span class="opacity-50">{{ inv.currency }}</span>
                </td>
                <td class="px-4 py-2.5 text-center">
                  <span :class="STATUS_COLORS[inv.status] ?? 'bg-gray-500/20 text-gray-400'"
                    class="rounded-full px-2 py-0.5 text-xs capitalize">{{ inv.status }}</span>
                </td>
                <td class="px-4 py-2.5 text-xs opacity-50">{{ fmt(inv.due_date) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Section 4: Totals -->
      <section>
        <h3 class="mb-3 text-sm font-bold uppercase tracking-wide opacity-60">Totals</h3>
        <div
          :class="darkMode ? 'bg-bubble-bg-dark border-accent-1' : 'bg-bubble-bg-light border-accent-2'"
          class="flex flex-wrap gap-4 rounded-xl border p-4 shadow-sm"
        >
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
          <div v-if="!summary.open_invoices.length && !summary.pending_charges.length" class="opacity-40 text-sm self-center">
            All clear — no outstanding charges
          </div>
        </div>
      </section>

    </template>
  </div>
</template>
