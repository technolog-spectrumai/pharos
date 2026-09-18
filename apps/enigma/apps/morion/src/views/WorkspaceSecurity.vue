<script setup lang="ts">
// Workspace security — reached from the shield beside the file tree, not from
// the menu: it is about THIS folder.
//
// Four things, all statements of fact rather than settings:
//   * how much of the workspace is encrypted, counted in Rust;
//   * whether a passphrase is remembered, and a way to forget it;
//   * Security Mana: the two meters, what costs what, and the recent
//     security actions from the ledger;
//   * what encryption does not hide.
//
// Nothing here encrypts anything. That happens where the files are — the
// shield beside the open file, beside each row, beside each folder.
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { baseName, useWorkspace } from "petalite/files";
import { forgetPassphrase, passphraseStatus, type SecretStatus } from "padova";
import { folderPreview, type FolderPreview } from "../security/folder";
import { manaLedger, manaStatus, refreshMana, type LedgerRow } from "../security/mana";
import { errorText, fsErrorKey } from "../files/fs";
import { invoke } from "../ipc";

const props = defineProps<{
  /** Whether the view is on screen. It stays mounted behind the editor, so
   *  showing it again is when the counts and the history are re-read. */
  active?: boolean;
}>();

const { t, locale } = useI18n({ useScope: "global" });
const workspace = useWorkspace();

const summary = ref<FolderPreview | null>(null);
const summaryError = ref("");
const secret = ref<SecretStatus | null>(null);
const ledger = ref<LedgerRow[]>([]);
const prices = ref<Array<{ id: string; base: number; perItem: number; cap: number }>>([]);
const loading = ref(false);

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function load() {
  if (!isTauri || !workspace.root.value) return;
  loading.value = true;
  summaryError.value = "";
  try {
    summary.value = await folderPreview("");
  } catch (err) {
    summary.value = null;
    const message = errorText(err);
    const key = fsErrorKey(message);
    summaryError.value = key ? t(key) : message;
  }
  try { secret.value = await passphraseStatus(); } catch { secret.value = null; }
  try { ledger.value = await manaLedger(); } catch { ledger.value = []; }
  try {
    prices.value = await invoke("mana_prices");
  } catch {
    prices.value = [];
  }
  await refreshMana();
  loading.value = false;
}

onMounted(load);
watch(() => props.active, (on) => { if (on) void load(); });
watch(() => workspace.root.value, load);
// A padlock changed somewhere: the counts and the history changed with it.
watch(() => workspace.sealed.value, load);

async function forget() {
  await forgetPassphrase();
  try { secret.value = await passphraseStatus(); } catch { secret.value = null; }
}

const meters = computed(() => {
  const s = manaStatus.value;
  if (!s) return [];
  return [
    { id: "daily", left: s.dailyLeft, max: s.dailyMax },
    { id: "weekly", left: s.weeklyLeft, max: s.weeklyMax },
  ];
});

function when(ts: number): string {
  return new Date(ts).toLocaleString(locale.value);
}

defineExpose({ reload: load });
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto p-6" data-testid="workspace-security">
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <div>
        <h2 class="flex items-center gap-2 text-lg font-bold">
          <font-awesome-icon icon="shield-halved" class="opacity-60" />
          {{ t("security.workspace.title") }}
        </h2>
        <p class="mt-1 text-sm opacity-70" data-testid="security-workspace-name">
          {{ workspace.root.value ? baseName(workspace.root.value) : t("workspace.none") }}
        </p>
      </div>

      <p v-if="!workspace.root.value" class="text-sm opacity-70" data-testid="security-no-workspace">
        {{ t("workspace.errors.no_workspace") }}
      </p>

      <template v-else>
        <!-- ── what is encrypted ─────────────────────────────────────────── -->
        <section data-testid="security-summary">
          <h3 class="text-sm font-semibold uppercase tracking-wide opacity-70">{{ t("security.workspace.filesTitle") }}</h3>
          <p v-if="summaryError" class="mt-2 text-sm text-warn-dark">{{ summaryError }}</p>
          <div v-else-if="summary" class="mt-2 grid grid-cols-3 gap-2">
            <div class="rounded-xl border border-accent-2 px-4 py-3 dark:border-accent-1">
              <p class="text-2xl font-bold" data-testid="security-count-sealed">{{ summary.sealed }}</p>
              <p class="text-xs opacity-70">{{ t("security.workspace.sealed") }}</p>
            </div>
            <div class="rounded-xl border border-accent-2 px-4 py-3 dark:border-accent-1">
              <p class="text-2xl font-bold" data-testid="security-count-plain">{{ summary.plain }}</p>
              <p class="text-xs opacity-70">{{ t("security.workspace.plain") }}</p>
            </div>
            <div class="rounded-xl border border-accent-2 px-4 py-3 dark:border-accent-1">
              <p class="text-2xl font-bold" data-testid="security-count-files">{{ summary.files }}</p>
              <p class="text-xs opacity-70">{{ t("security.workspace.total") }}</p>
            </div>
          </div>
          <p v-if="summary?.links" class="mt-2 text-xs opacity-60">{{ t("folder.links", { n: summary.links }) }}</p>
          <p v-if="summary?.truncated" class="mt-2 text-xs text-warn-dark" data-testid="security-truncated">
            {{ t("security.workspace.truncated") }}
          </p>
          <p class="mt-2 text-xs opacity-60">{{ t("security.workspace.where") }}</p>
        </section>

        <!-- ── the remembered passphrase ─────────────────────────────────── -->
        <section data-testid="security-passphrase">
          <h3 class="text-sm font-semibold uppercase tracking-wide opacity-70">{{ t("security.workspace.passphraseTitle") }}</h3>
          <div class="mt-2 flex items-center gap-3 rounded-xl border border-accent-2 px-4 py-3 text-sm dark:border-accent-1">
            <font-awesome-icon :icon="secret?.remembered ? 'lock-open' : 'lock'" class="opacity-60" />
            <span class="flex-1" data-testid="security-secret-status">
              {{ secret?.remembered ? t("security.workspace.secretHeld") : t("security.secret.none") }}
              <span v-if="secret?.remembered" class="opacity-60">
                {{ t(secret.storage === "keychain" ? "security.secret.keychain" : "security.secret.memory") }}
              </span>
            </span>
            <button v-if="secret?.remembered" type="button" data-testid="security-forget"
                    class="rounded-lg border border-accent-2 px-3 py-1.5 text-xs dark:border-accent-1" @click="forget">
              {{ t("security.secret.forget") }}
            </button>
          </div>
        </section>

        <!-- ── Security Mana ─────────────────────────────────────────────── -->
        <section data-testid="security-mana">
          <h3 class="text-sm font-semibold uppercase tracking-wide opacity-70">{{ t("mana.title") }}</h3>
          <p class="mt-1 text-xs opacity-70">{{ t("mana.advisory") }} {{ t("security.workspace.manaHow") }}</p>
          <div class="mt-3 flex flex-col gap-2">
            <div v-for="m in meters" :key="m.id" :data-testid="`mana-meter-${m.id}`">
              <div class="flex justify-between text-xs">
                <span>{{ t(`security.workspace.meter.${m.id}`) }}</span>
                <span class="font-semibold">{{ m.left }} / {{ m.max }}</span>
              </div>
              <div class="mt-1 h-2 overflow-hidden rounded-full bg-current/10">
                <div class="h-full rounded-full bg-accent-light dark:bg-accent-dark"
                     :style="{ width: `${Math.round((m.left / m.max) * 100)}%` }" />
              </div>
            </div>
          </div>
          <p v-if="manaStatus?.exhausted" class="mt-2 text-xs text-warn-dark" data-testid="security-mana-exhausted">
            {{ t("mana.exhausted") }}
          </p>

          <table v-if="prices.length" class="mt-4 w-full text-xs" data-testid="mana-prices">
            <tbody>
              <tr v-for="p in prices" :key="p.id" class="border-b border-current/10 last:border-0">
                <td class="py-1.5 pr-3">{{ t(`mana.notes.${p.id}`) }}</td>
                <td class="py-1.5 text-right font-semibold" :data-testid="`mana-price-${p.id}`">
                  {{ p.perItem ? t("security.workspace.pricePerItem", { base: p.base, per: p.perItem, cap: p.cap }) : p.base }}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- ── recent security actions ───────────────────────────────────── -->
        <section data-testid="security-history">
          <h3 class="text-sm font-semibold uppercase tracking-wide opacity-70">{{ t("security.workspace.historyTitle") }}</h3>
          <p v-if="!ledger.length" class="mt-2 text-xs opacity-60" data-testid="security-history-empty">
            {{ t("security.workspace.historyEmpty") }}
          </p>
          <ul v-else class="mt-2 flex flex-col text-xs">
            <li v-for="(row, i) in ledger" :key="`${row.ts}-${i}`" :data-testid="`security-history-${i}`"
                class="flex items-center gap-3 border-b border-current/10 py-1.5 last:border-0">
              <span class="w-36 shrink-0 opacity-60">{{ when(row.ts) }}</span>
              <span class="min-w-0 flex-1">
                <span class="block">{{ t(row.note) }}</span>
                <span v-if="row.path" class="block truncate opacity-60">{{ row.path }}</span>
              </span>
              <span class="shrink-0 font-semibold">{{ row.cost ? `−${row.cost}` : "0" }}</span>
            </li>
          </ul>
        </section>

        <!-- ── what encryption does not hide ─────────────────────────────── -->
        <section class="rounded-xl border border-dashed border-accent-2 px-4 py-3 text-xs leading-relaxed dark:border-accent-1"
                 data-testid="security-limits">
          <p class="font-semibold">{{ t("security.workspace.limitsTitle") }}</p>
          <p class="mt-1 opacity-80">{{ t("shield.limits") }}</p>
          <p class="mt-1 opacity-80">{{ t("security.workspace.limitsMore") }}</p>
        </section>
      </template>
    </div>
  </div>
</template>
