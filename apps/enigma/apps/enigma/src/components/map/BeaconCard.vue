<script setup lang="ts">
// Sidebar card for beacon — the ACTIVE location shares on the user's faros
// server (volatile, fetched on open + explicit refresh; nothing persisted).
// Owns the on-open fetch: it mounts exactly once per Maps-tab visit, so the
// cloud session mirror is initialized here before the first refresh.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  beaconTtlLeftMs,
  getUseTor,
  isBeaconLive,
  isTauri,
  OyaCard,
  type BeaconPin,
  type BeaconRoute,
  type BeaconZone,
} from "rakotis";
import { useBeaconStore } from "../../stores/beacon";
import { useCloudStore } from "../../stores/cloud";
import { BEACON_COLOR } from "./pinColors";

const emit = defineEmits<{
  (e: "focus-pin", pin: BeaconPin): void;
  (e: "focus-zone", zone: BeaconZone): void;
  (e: "focus-route", route: BeaconRoute): void;
  /** Ask the map panel for a /beacon/near query around the visible viewport. */
  (e: "near"): void;
}>();

const { t } = useI18n({ useScope: "global" });
const beacon = useBeaconStore();
const cloud = useCloudStore();

/** Render-time cull between refreshes (the server never sends expired rows). */
const now = ref(Date.now());
let tick: number | undefined;

onMounted(async () => {
  tick = window.setInterval(() => (now.value = Date.now()), 60_000);
  // Tor mode drops location sharing entirely (cloud.md) — settle that BEFORE
  // the first fetch, or a Tor profile would still ask the server once.
  if (isTauri()) beacon.torBlocked = await getUseTor().catch(() => false);
  await cloud.init();
  void beacon.refresh();
});

onUnmounted(() => {
  if (tick !== undefined) window.clearInterval(tick);
});

const livePins = computed(() => beacon.pins.filter((p) => isBeaconLive(p.expiresAt, now.value)));
/** Near mode replaces the pins group with the distance-sorted server answer. */
const liveNearPins = computed(() =>
  (beacon.nearPins ?? []).filter((p) => isBeaconLive(p.expiresAt, now.value)),
);
const liveZones = computed(() => beacon.zones.filter((z) => isBeaconLive(z.expiresAt, now.value)));
const liveRoutes = computed(() => beacon.routes.filter((r) => isBeaconLive(r.expiresAt, now.value)));
const empty = computed(
  () => livePins.value.length + liveZones.value.length + liveRoutes.value.length === 0,
);

function leftText(expiresAt: number): string {
  const ms = beaconTtlLeftMs(expiresAt, now.value);
  if (ms <= 0) return t("map.beaconExpired");
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t("map.beaconLeftMinutes", { n: Math.max(1, minutes) });
  return t("map.beaconLeftHours", { n: Math.round(minutes / 60) });
}

function owner(user: string): string {
  return user === cloud.username ? t("map.beaconYou") : user;
}

function distanceText(distanceM: number | undefined): string {
  if (distanceM === undefined) return "";
  return distanceM < 1000
    ? t("map.beaconDistanceM", { n: Math.round(distanceM) })
    : t("map.beaconDistanceKm", { n: (distanceM / 1000).toFixed(1) });
}

function isMine(user: string): boolean {
  return user === cloud.username;
}

async function removeZone(id: number) {
  try {
    await beacon.deleteZone(id);
  } catch { /* surfaced via beacon.error / rethrown message not needed here */ }
}

async function removeRoute(id: number) {
  try {
    await beacon.deleteRoute(id);
  } catch { /* ignore — row simply stays until the next refresh */ }
}

async function retractPin() {
  try {
    await beacon.deletePin();
  } catch { /* idempotent server-side; the row clears on the next refresh */ }
}
</script>

<template>
  <OyaCard data-testid="beacon-card">
    <div class="mb-2 flex items-center gap-2">
      <h3 class="min-w-0 flex-1 truncate text-sm font-bold">
        <font-awesome-icon icon="layer-group" /> {{ $t('map.beaconTitle') }}
      </h3>
      <template v-if="cloud.enabled && cloud.loggedIn">
        <button
          type="button"
          class="opacity-60 transition hover:opacity-100"
          :title="$t('map.beaconLayerToggle')"
          data-testid="beacon-layer-toggle"
          @click="beacon.layerVisible = !beacon.layerVisible"
        >
          <font-awesome-icon :icon="beacon.layerVisible ? 'eye' : 'eye-slash'" />
        </button>
        <button
          type="button"
          class="opacity-60 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-25"
          :disabled="beacon.loading"
          :title="$t('map.beaconRefresh')"
          data-testid="beacon-refresh"
          @click="beacon.refresh()"
        >
          <font-awesome-icon icon="rotate-right" />
        </button>
      </template>
    </div>

    <!-- Knob off ⇒ point at the Cloud tab; knob on but logged out ⇒ login hint. -->
    <p v-if="!cloud.enabled" class="text-xs opacity-60" data-testid="beacon-cloud-off-hint">
      {{ $t('cloud.cloudOffHint') }}
    </p>
    <p v-else-if="!cloud.loggedIn" class="text-xs opacity-60" data-testid="beacon-login-hint">
      {{ $t('map.beaconLoginHint') }}
    </p>

    <template v-else>
      <p v-if="beacon.error" class="mb-2 text-xs text-warn-dark">{{ beacon.error }}</p>
      <p v-if="empty && !beacon.error && !beacon.nearPins" class="text-xs opacity-60">
        {{ $t('map.beaconEmpty') }}
      </p>

      <div class="mb-2 flex flex-wrap gap-2">
        <button
          v-if="!beacon.nearPins"
          type="button"
          class="rounded-full border border-accent-2 px-2 py-0.5 text-xs font-semibold transition hover:opacity-80 dark:border-accent-1"
          data-testid="beacon-near"
          @click="emit('near')"
        >
          <font-awesome-icon icon="bullseye" /> {{ $t('map.beaconNearHere') }}
        </button>
        <template v-else>
          <span class="py-0.5 text-xs opacity-70">
            {{ $t('map.beaconNearShowing', { n: liveNearPins.length }) }}
          </span>
          <button
            type="button"
            class="rounded-full border border-accent-2 px-2 py-0.5 text-xs font-semibold transition hover:opacity-80 dark:border-accent-1"
            data-testid="beacon-clear-near"
            @click="beacon.clearNear()"
          >
            {{ $t('map.beaconClearNear') }}
          </button>
        </template>
      </div>

      <div v-if="beacon.nearPins" class="mb-2" data-testid="beacon-near-list">
        <ul class="space-y-1">
          <li v-for="pin in liveNearPins" :key="pin.id" class="flex items-center gap-2 text-sm">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-70"
              @click="emit('focus-pin', pin)"
            >
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: BEACON_COLOR }" />
              <span class="min-w-0 truncate">{{ owner(pin.user) }}</span>
              <span v-if="pin.comment" class="min-w-0 truncate text-xs opacity-60">{{ pin.comment }}</span>
            </button>
            <span class="shrink-0 text-xs font-semibold opacity-70">{{ distanceText(pin.distanceM) }}</span>
          </li>
        </ul>
      </div>

      <div v-if="!beacon.nearPins && livePins.length" class="mb-2">
        <p class="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
          {{ $t('map.beaconPinsGroup') }}
        </p>
        <ul class="space-y-1">
          <li v-for="pin in livePins" :key="pin.id" class="flex items-center gap-2 text-sm">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-70"
              @click="emit('focus-pin', pin)"
            >
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: BEACON_COLOR }" />
              <span class="min-w-0 truncate">{{ owner(pin.user) }}</span>
              <span v-if="pin.comment" class="min-w-0 truncate text-xs opacity-60">{{ pin.comment }}</span>
            </button>
            <span class="shrink-0 text-xs opacity-50">{{ leftText(pin.expiresAt) }}</span>
            <button
              v-if="isMine(pin.user)"
              type="button"
              class="opacity-60 transition hover:opacity-100"
              :title="$t('map.beaconDeleteShare')"
              data-testid="beacon-retract-pin"
              @click="retractPin()"
            >
              <font-awesome-icon icon="trash" />
            </button>
          </li>
        </ul>
      </div>

      <div v-if="liveZones.length" class="mb-2">
        <p class="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
          {{ $t('map.beaconZonesGroup') }}
        </p>
        <ul class="space-y-1">
          <li v-for="zone in liveZones" :key="zone.id" class="flex items-center gap-2 text-sm">
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left hover:opacity-70"
              @click="emit('focus-zone', zone)"
            >
              {{ zone.name || $t('map.beaconZonesGroup') }}
              <span class="opacity-50">· {{ owner(zone.user) }}</span>
            </button>
            <span class="shrink-0 text-xs opacity-50">{{ leftText(zone.expiresAt) }}</span>
            <button
              v-if="isMine(zone.user)"
              type="button"
              class="opacity-60 transition hover:opacity-100"
              :title="$t('map.beaconDeleteShare')"
              @click="removeZone(zone.id)"
            >
              <font-awesome-icon icon="trash" />
            </button>
          </li>
        </ul>
      </div>

      <div v-if="liveRoutes.length">
        <p class="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
          {{ $t('map.beaconRoutesGroup') }}
        </p>
        <ul class="space-y-1">
          <li v-for="route in liveRoutes" :key="route.id" class="flex items-center gap-2 text-sm">
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left hover:opacity-70"
              @click="emit('focus-route', route)"
            >
              {{ route.name || $t('map.beaconRoutesGroup') }}
              <span class="opacity-50">· {{ owner(route.user) }}</span>
            </button>
            <span class="shrink-0 text-xs opacity-50">{{ leftText(route.expiresAt) }}</span>
            <button
              v-if="isMine(route.user)"
              type="button"
              class="opacity-60 transition hover:opacity-100"
              :title="$t('map.beaconDeleteShare')"
              @click="removeRoute(route.id)"
            >
              <font-awesome-icon icon="trash" />
            </button>
          </li>
        </ul>
      </div>
    </template>
  </OyaCard>
</template>
