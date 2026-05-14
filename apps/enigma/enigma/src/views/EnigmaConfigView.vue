<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { Html5Qrcode } from "html5-qrcode";
import { api } from "../services/api";
import { getServerUrl, setServerUrl } from "../services/appStorage";
import OyaCard from "../components/OyaCard.vue";
import OyaButton from "../components/OyaButton.vue";

defineProps<{ darkMode: boolean }>();

const router = useRouter();

// ── Server URL ────────────────────────────────────────────────────────────────
const serverUrl = ref("");
const saved = ref(false);

onMounted(async () => {
  serverUrl.value = await getServerUrl();
});

async function save() {
  await setServerUrl(serverUrl.value.trim());
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function clearConnection() {
  await setServerUrl("");
  serverUrl.value = "";
  testStatus.value = "idle";
  testMessage.value = "";
}

// ── Test connection ───────────────────────────────────────────────────────────
type TestStatus = "idle" | "testing" | "ok" | "error";
const testStatus = ref<TestStatus>("idle");
const testMessage = ref("");
const timeoutMs = ref(5000); // user-configurable timeout in ms

async function testConnection() {
  if (!serverUrl.value) {
    testStatus.value = "error";
    testMessage.value = "No server URL configured.";
    return;
  }
  testStatus.value = "testing";
  testMessage.value = "";
  const t0 = Date.now();

  try {
    const me = await Promise.race([
      api.getMe(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs.value / 1000} s`)),
          timeoutMs.value
        )
      ),
    ]);
    const ms = Date.now() - t0;
    testStatus.value = "ok";
    testMessage.value = `Connected as ${me.full_name} (${ms} ms)`;
  } catch (e) {
    testStatus.value = "error";
    const raw = (e as Error).message;
    const elapsed = Date.now() - t0;
    const timedOut = elapsed >= timeoutMs.value - 50;
    testMessage.value = timedOut
      ? `No response after ${timeoutMs.value / 1000} s — server may be unreachable. (${raw})`
      : raw;
  }
}

// ── QR scanner ───────────────────────────────────────────────────────────────
interface ScanEntry {
  ts: Date;
  ok: boolean;
  text: string;
}

const scanning = ref(false);
const scanError = ref("");
const scanLog = ref<ScanEntry[]>([]);
let scanner: Html5Qrcode | null = null;

async function startScan() {
  scanError.value = "";
  scanning.value = true;
  await new Promise((r) => setTimeout(r, 50));
  scanner = new Html5Qrcode("qr-scanner-region");
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 220, height: 220 } },
      (decoded) => {
        scanLog.value.unshift({ ts: new Date(), ok: true, text: decoded });
        serverUrl.value = decoded;
        void save();      // auto-save scanned URL
        stopScan();
      },
      () => {
        // per-frame decode failure — ignore noise
      }
    );
  } catch {
    const msg = "Camera access denied or unavailable.";
    scanError.value = msg;
    scanLog.value.unshift({ ts: new Date(), ok: false, text: msg });
    scanning.value = false;
    scanner = null;
  }
}

async function stopScan() {
  if (scanner) {
    try { await scanner.stop(); } catch { /* ignore */ }
    scanner = null;
  }
  scanning.value = false;
}

onUnmounted(stopScan);
</script>

<template>
  <section class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">

    <!-- Header -->
    <header class="space-y-2">
      <button
        class="inline-flex items-center gap-2 text-sm underline hover:opacity-80"
        @click="router.push('/')"
      >
        <font-awesome-icon icon="arrow-left" />
        Back
      </button>

      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          Oya Studio
        </p>
        <h1 class="mt-1 flex items-center gap-3 text-3xl font-bold">
          <font-awesome-icon icon="gear" />
          Configuration
        </h1>
        <p class="mt-2 text-sm opacity-70">Set the server address Enigma connects to.</p>
      </div>
    </header>

    <!-- Server URL card -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          Server Address
        </p>
        <p class="mt-1 text-sm opacity-65">
          Enter the URL manually or scan the QR code from the welcome page.
        </p>
      </div>

      <!-- Input row -->
      <div class="flex gap-2">
        <input
          v-model="serverUrl"
          type="url"
          placeholder="http://192.168.x.x:8000"
          :class="
            darkMode
              ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
              : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
          "
          class="flex-1 rounded-lg border px-3 py-2 text-sm font-mono outline-none transition"
          @keyup.enter="save"
        />
        <OyaButton :dark-mode="darkMode" @click="save">
          <font-awesome-icon :icon="saved ? 'check' : 'floppy-disk'" />
          {{ saved ? "Saved" : "Save" }}
        </OyaButton>
      </div>

      <!-- Stored URL row -->
      <div
        v-if="serverUrl"
        :class="darkMode ? 'border-accent-1 bg-primary-bg-dark' : 'border-accent-2 bg-primary-bg-light'"
        class="flex items-center gap-3 rounded-lg border px-3 py-2"
      >
        <div class="min-w-0 flex-1">
          <p class="text-xs opacity-50">Configured server</p>
          <p class="mt-0.5 break-all font-mono text-sm">{{ serverUrl }}</p>
        </div>
        <button
          :class="darkMode ? 'hover:text-warn-dark' : 'hover:text-warn-light'"
          class="shrink-0 text-sm opacity-40 transition hover:opacity-100"
          title="Clear saved URL"
          @click="clearConnection"
        >
          <font-awesome-icon icon="xmark" />
        </button>
      </div>

      <!-- Test connection row -->
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-3">
          <!-- Timeout selector -->
          <div class="flex items-center gap-2 text-sm opacity-70">
            <label class="shrink-0 text-xs font-semibold uppercase tracking-wide opacity-60">
              Timeout
            </label>
            <select
              v-model.number="timeoutMs"
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light'
              "
              class="rounded-lg border px-2 py-1 text-sm outline-none transition"
            >
              <option :value="2000">2 s</option>
              <option :value="5000">5 s</option>
              <option :value="10000">10 s</option>
              <option :value="30000">30 s</option>
            </select>
          </div>

          <OyaButton
            :dark-mode="darkMode"
            variant="secondary"
            :class="{ 'pointer-events-none opacity-50': testStatus === 'testing' }"
            @click="testConnection"
          >
            <font-awesome-icon v-if="testStatus === 'idle'" icon="gauge" />
            <font-awesome-icon v-else-if="testStatus === 'testing'" icon="lock" />
            <font-awesome-icon v-else-if="testStatus === 'ok'" icon="check" class="text-success-dark" />
            <font-awesome-icon v-else icon="triangle-exclamation" class="text-warn-dark" />
            {{ testStatus === "testing" ? `Testing… (${timeoutMs / 1000} s max)` : "Test connection" }}
          </OyaButton>
        </div>

        <p
          v-if="testMessage"
          :class="testStatus === 'ok' ? 'text-success-dark' : 'text-warn-dark'"
          class="min-w-0 flex-1 break-all text-sm"
        >
          {{ testMessage }}
        </p>
      </div>
    </OyaCard>

    <!-- QR Scanner card -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          Scan QR Code
        </p>
        <p class="mt-1 text-sm opacity-65">
          Point the camera at the QR code on the server's welcome page. The URL is saved automatically on successful scan.
        </p>
      </div>

      <!-- Camera viewport -->
      <div v-if="scanning" class="space-y-3">
        <div
          id="qr-scanner-region"
          :class="darkMode ? 'border-accent-1' : 'border-accent-2'"
          class="overflow-hidden rounded-xl border"
        />
        <OyaButton :dark-mode="darkMode" variant="secondary" class="w-full" @click="stopScan">
          <font-awesome-icon icon="xmark" />
          Cancel scan
        </OyaButton>
      </div>

      <p v-if="scanError" class="text-sm text-warn-dark">
        <font-awesome-icon icon="triangle-exclamation" class="mr-1" />
        {{ scanError }}
      </p>

      <OyaButton v-if="!scanning" :dark-mode="darkMode" class="w-full" @click="startScan">
        <font-awesome-icon icon="camera" />
        Start camera scan
      </OyaButton>

      <!-- Scan log -->
      <div v-if="scanLog.length" class="space-y-1">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-50">Scan log</p>
        <div
          v-for="(entry, i) in scanLog"
          :key="i"
          :class="
            entry.ok
              ? darkMode ? 'border-success-dark/30 bg-success-dark/5' : 'border-success-light/30 bg-success-light/5'
              : darkMode ? 'border-warn-dark/30 bg-warn-dark/5' : 'border-warn-light/30 bg-warn-light/5'
          "
          class="flex items-start gap-2 rounded-lg border px-3 py-2 font-mono text-xs"
        >
          <span :class="entry.ok ? 'text-success-dark' : 'text-warn-dark'" class="shrink-0 font-bold">
            {{ entry.ok ? "✓" : "✗" }}
          </span>
          <span class="shrink-0 opacity-50">{{ entry.ts.toLocaleTimeString() }}</span>
          <span class="min-w-0 flex-1 break-all opacity-80">{{ entry.text }}</span>
        </div>
      </div>
    </OyaCard>

  </section>
</template>
