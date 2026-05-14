<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { Html5Qrcode } from "html5-qrcode";
import OyaCard from "../components/OyaCard.vue";
import OyaButton from "../components/OyaButton.vue";

defineProps<{ darkMode: boolean }>();

const router = useRouter();

const serverUrl = ref(localStorage.getItem("enigma_server_url") ?? "");
const saved = ref(false);
const scanning = ref(false);
const scanError = ref("");
let scanner: Html5Qrcode | null = null;

function save() {
  localStorage.setItem("enigma_server_url", serverUrl.value);
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function startScan() {
  scanError.value = "";
  scanning.value = true;
  await new Promise((r) => setTimeout(r, 50)); // let DOM render the element
  scanner = new Html5Qrcode("qr-scanner-region");
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 220, height: 220 } },
      (decoded) => {
        serverUrl.value = decoded;
        stopScan();
      },
      () => {}
    );
  } catch {
    scanError.value = "Camera access denied or unavailable.";
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
    <header class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div class="space-y-2">
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
          <p class="mt-2 text-sm opacity-70">
            Set the server address Enigma connects to.
          </p>
        </div>
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
          class="flex-1 rounded-lg border px-3 py-2 text-sm font-mono outline-none transition focus:ring-2"
          :style="darkMode ? 'focus-ring-color: var(--color-accent-1)' : ''"
          @keyup.enter="save"
        />

        <OyaButton :dark-mode="darkMode" @click="save">
          <font-awesome-icon :icon="saved ? 'check' : 'floppy-disk'" />
          {{ saved ? "Saved" : "Save" }}
        </OyaButton>
      </div>

      <!-- Current value -->
      <div
        v-if="serverUrl"
        :class="
          darkMode
            ? 'border-accent-1 bg-primary-bg-dark'
            : 'border-accent-2 bg-primary-bg-light'
        "
        class="rounded-lg border px-3 py-2"
      >
        <p class="text-xs opacity-50">Configured server</p>
        <p class="mt-1 break-all font-mono text-sm">{{ serverUrl }}</p>
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
          Point the camera at the QR code shown on the welcome page of your server.
        </p>
      </div>

      <!-- Scanner viewport -->
      <div v-if="scanning" class="space-y-3">
        <div
          id="qr-scanner-region"
          :class="
            darkMode
              ? 'border-accent-1 bg-primary-bg-dark'
              : 'border-accent-2 bg-primary-bg-light'
          "
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
    </OyaCard>

  </section>
</template>
