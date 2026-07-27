<script setup lang="ts">
// The Cloud master switch, with its conscious-enable confirm modal. Mounted in
// Settings → Connections, beside the other network toggles; the Cloud tab
// itself only points here. Drives the store ref backed by kv
// `cloud:settings/default/enabled`.
//
// Turning it ON opens a danger-style confirm listing what the server will see
// and the per-transport risks; the kv flag is written only after the confirm
// press. Turning it OFF is instant — no ceremony to STOP talking to a server —
// and aborts in-flight transfers Rust-side. cloud.md D2/D4.
import { ref } from "vue";
import { OyaCard, OyaModal } from "rakotis";
import { useCloudStore } from "../../stores/cloud";

defineProps<{ darkMode?: boolean }>();

const cloud = useCloudStore();

const showEnableConfirm = ref(false);
const knobBusy = ref(false);
// A failed flip (e.g. the vault locked, so the kv write errors) is recoverable
// — surface it under the knob instead of letting the rejection escalate to the
// global fatal overlay.
const knobError = ref("");

function asMessage(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
}

function onKnobClick() {
  if (knobBusy.value) return;
  knobError.value = "";
  if (cloud.enabled) {
    knobBusy.value = true;
    cloud
      .setEnabled(false)
      .catch((e) => { knobError.value = asMessage(e); })
      .finally(() => { knobBusy.value = false; });
  } else {
    showEnableConfirm.value = true;
  }
}

async function confirmEnable() {
  if (knobBusy.value) return;
  knobBusy.value = true;
  knobError.value = "";
  try {
    await cloud.setEnabled(true);
    showEnableConfirm.value = false;
  } catch (e) {
    knobError.value = asMessage(e);
    showEnableConfirm.value = false;
  } finally {
    knobBusy.value = false;
  }
}

</script>

<template>
  <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-3">
    <div class="flex items-center gap-3">
      <font-awesome-icon
        icon="cloud"
        :class="cloud.enabled ? 'text-accent-dark' : 'opacity-60'"
        class="shrink-0"
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">{{ $t('cloud.enableTitle') }}</p>
        <p class="text-xs opacity-60">
          {{ cloud.enabled ? $t('cloud.enableHintOn') : $t('cloud.enableHintOff') }}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="cloud.enabled"
        :aria-label="$t('cloud.enableTitle')"
        data-testid="cloud-knob"
        :class="cloud.enabled ? 'bg-accent-dark' : darkMode ? 'bg-accent-1' : 'bg-accent-2'"
        class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition"
        @click="onKnobClick"
      >
        <span
          :class="cloud.enabled ? 'translate-x-6' : 'translate-x-1'"
          class="inline-block h-4 w-4 transform rounded-full bg-white transition"
        />
      </button>
    </div>
    <p v-if="knobError" class="text-xs text-warn-dark" data-testid="cloud-knob-error">
      {{ knobError }}
    </p>

    <!-- What the switch turns on, and the metadata price of it -->
    <div v-if="!cloud.enabled" class="space-y-3 border-t border-current/10 pt-3">
      <p class="text-sm opacity-70">{{ $t('cloud.offExplanation') }}</p>
      <div class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark">
        {{ $t('cloud.offNotice') }}
      </div>
    </div>

    <!-- Conscious-enable confirm: the full risk list BEFORE any kv write -->
    <OyaModal :open="showEnableConfirm" @close="showEnableConfirm = false">
      <div class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
        <p class="flex items-center gap-2 text-lg font-bold text-warn-dark">
          <font-awesome-icon icon="triangle-exclamation" />
          {{ $t('cloud.confirmTitle') }}
        </p>
        <p class="text-sm opacity-80">{{ $t('cloud.confirmIntro') }}</p>
        <ul class="list-disc space-y-1 pl-5 text-sm opacity-80">
          <li>{{ $t('cloud.confirmMeta1') }}</li>
          <li>{{ $t('cloud.confirmMeta2') }}</li>
          <li>{{ $t('cloud.confirmMeta3') }}</li>
        </ul>
        <p class="text-sm opacity-80">{{ $t('cloud.confirmTransport') }}</p>
        <ul class="list-disc space-y-1 pl-5 text-sm opacity-80">
          <li>{{ $t('cloud.confirmClearnet') }}</li>
          <li>{{ $t('cloud.confirmTor') }}</li>
          <li>{{ $t('cloud.confirmOnion') }}</li>
        </ul>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          @click="showEnableConfirm = false"
        >
          {{ $t('common.cancel') }}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg border border-warn-dark/50 px-4 py-2 text-sm font-semibold text-warn-dark transition hover:bg-warn-dark/10"
          data-testid="cloud-enable-confirm"
          @click="confirmEnable"
        >
          <font-awesome-icon :icon="knobBusy ? 'spinner' : 'cloud'" :spin="knobBusy" />
          {{ $t('cloud.confirmEnable') }}
        </button>
      </template>
    </OyaModal>
  </OyaCard>
</template>
