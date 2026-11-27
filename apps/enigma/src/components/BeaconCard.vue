<script setup lang="ts">
// Settings → Connections: your Beacon (8.C2). Optional: scan or paste its code and
// new rooms use it; without one, rooms are pure mesh. Also shows this phone's key
// for a Beacon set to "only my phones" (beacon allow NAME KEY).
import { onMounted, ref } from "vue";
import { OyaButton, OyaCard, OyaCopyField, OyaTextField } from "petalite/primitives";
import QrScannerModal from "./chat/QrScannerModal.vue";
import { clearBeacon, discoveryKey, loadBeacon, myBeacon, setBeacon } from "../stores/beacon";

defineProps<{ darkMode?: boolean }>();
const pasted = ref("");
const error = ref("");
const scanning = ref(false);
const key = ref("");

onMounted(loadBeacon);

async function take(code: string) {
  error.value = "";
  key.value = "";
  try {
    await setBeacon(code);
    pasted.value = "";
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  }
}
function onScanned(text: string) {
  scanning.value = false;
  void take(text);
}
async function showKey() {
  if (!myBeacon.value) return;
  try {
    key.value = await discoveryKey(myBeacon.value.onion);
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  }
}
</script>

<template>
  <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-3" data-testid="beacon-card">
    <p :class="darkMode ? 'text-accent-dark' : 'text-accent-light'" class="text-xs font-semibold uppercase tracking-wide">
      {{ $t("beacon.title") }}
    </p>
    <p class="text-xs leading-relaxed opacity-65">{{ $t("beacon.intro") }}</p>

    <template v-if="myBeacon">
      <div class="flex items-center gap-3 rounded-xl bg-current/5 p-3">
        <font-awesome-icon icon="tower-broadcast" class="shrink-0 opacity-70" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold" data-testid="beacon-name">{{ myBeacon.name }}</p>
          <p class="truncate font-mono text-[11px] opacity-50">{{ myBeacon.onion }}</p>
        </div>
      </div>
      <p class="text-xs opacity-65">{{ $t("beacon.newRoomsOnly") }}</p>
      <div class="flex flex-wrap gap-2">
        <OyaButton variant="secondary" data-testid="beacon-key" @click="showKey">{{ $t("beacon.showKey") }}</OyaButton>
        <OyaButton variant="secondary" data-testid="beacon-clear" @click="clearBeacon(); key = ''">{{ $t("beacon.remove") }}</OyaButton>
      </div>
      <template v-if="key">
        <p class="text-xs opacity-65">{{ $t("beacon.keyHint") }}</p>
        <OyaCopyField :value="key" mono :copy-label="$t('chat.copy')" />
      </template>
    </template>

    <template v-else>
      <OyaButton class="w-full justify-center" data-testid="beacon-scan" @click="scanning = true">
        <font-awesome-icon icon="camera" />{{ $t("beacon.scan") }}
      </OyaButton>
      <div class="flex gap-2">
        <OyaTextField v-model="pasted" class="flex-1" mono :placeholder="$t('beacon.paste')" data-testid="beacon-paste" @enter="take(pasted)" />
        <OyaButton variant="secondary" :disabled="!pasted.trim()" @click="take(pasted)">{{ $t("beacon.use") }}</OyaButton>
      </div>
    </template>
    <p v-if="error" class="text-xs text-warn-dark" data-testid="beacon-error">{{ error }}</p>
    <QrScannerModal :open="scanning" @update:open="scanning = $event" @decoded="onScanned" />
  </OyaCard>
</template>
