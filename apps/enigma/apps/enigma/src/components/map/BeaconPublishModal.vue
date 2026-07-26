<script setup lang="ts">
// Publish one share to the faros server: TTL preset (mandatory — the server
// rejects a share without an expiry), optional comment, and a name for
// zones/routes. Nothing leaves the device until the submit press.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { BEACON_TTL_PRESETS, OyaButton, OyaModal, OyaTextField } from "rakotis";

const props = defineProps<{
  open: boolean;
  kind: "pin" | "zone" | "route";
  /** Point count of the draft (zones/routes) — shown for confirmation. */
  pointCount?: number;
}>();

const emit = defineEmits<{
  (e: "submit", fields: { name: string; comment: string; ttlSeconds: number }): void;
  (e: "close"): void;
}>();

const { t } = useI18n({ useScope: "global" });

const name = ref("");
const comment = ref("");
const ttlSeconds = ref<number>(BEACON_TTL_PRESETS[2]); // 6 h — the typical share
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = "";
      comment.value = "";
      ttlSeconds.value = BEACON_TTL_PRESETS[2];
      busy.value = false;
      error.value = null;
    }
  },
);

const title = computed(() =>
  props.kind === "pin"
    ? t("map.beaconPublishPinTitle")
    : props.kind === "zone"
      ? t("map.beaconPublishZoneTitle")
      : t("map.beaconPublishRouteTitle"),
);

function presetLabel(seconds: number): string {
  return seconds < 3600
    ? t("map.beaconTtlMinutes", { n: Math.round(seconds / 60) })
    : t("map.beaconTtlHours", { n: Math.round(seconds / 3600) });
}

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    emit("submit", {
      name: name.value.trim(),
      comment: comment.value.trim(),
      ttlSeconds: ttlSeconds.value,
    });
  } finally {
    busy.value = false;
  }
}

/** The parent surfaces a failed publish back into the open modal. */
defineExpose({
  showError(message: string) {
    error.value = message;
  },
});
</script>

<template>
  <OyaModal :open="open" @close="emit('close')">
    <form
      class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      @submit.prevent="submit"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon
          :icon="kind === 'route' ? 'route' : kind === 'zone' ? 'object-group' : 'location-dot'"
        />
        {{ title }}
      </p>
      <p v-if="pointCount" class="text-xs opacity-60">
        {{ $t('map.pointCount', { n: pointCount }) }}
      </p>

      <label v-if="kind !== 'pin'" class="block text-xs font-semibold uppercase tracking-wide opacity-70">
        {{ $t('map.nameLabel') }}
        <OyaTextField v-model="name" :maxlength="120" class="mt-1" data-testid="beacon-publish-name" />
      </label>

      <label class="block text-xs font-semibold uppercase tracking-wide opacity-70">
        {{ $t('map.beaconCommentLabel') }}
        <OyaTextField v-model="comment" :maxlength="2000" class="mt-1" data-testid="beacon-publish-comment" />
      </label>

      <div>
        <p class="text-xs font-semibold uppercase tracking-wide opacity-70">
          {{ $t('map.beaconTtlLabel') }}
        </p>
        <div class="mt-1 flex gap-2">
          <OyaButton
            v-for="preset in BEACON_TTL_PRESETS"
            :key="preset"
            type="button"
            :variant="ttlSeconds === preset ? 'primary' : 'secondary'"
            :data-testid="`beacon-ttl-${preset}`"
            @click="ttlSeconds = preset"
          >
            {{ presetLabel(preset) }}
          </OyaButton>
        </div>
        <p class="mt-1 text-xs opacity-60">{{ $t('map.beaconTtlNotice') }}</p>
      </div>

      <p v-if="error" class="text-xs text-warn-dark" data-testid="beacon-publish-error">{{ error }}</p>

      <div class="flex justify-end gap-2 pt-1">
        <OyaButton variant="secondary" type="button" @click="emit('close')">
          {{ $t('common.cancel') }}
        </OyaButton>
        <OyaButton type="submit" :disabled="busy" data-testid="beacon-publish-submit">
          <font-awesome-icon icon="share-nodes" /> {{ $t('map.beaconPublishAction') }}
        </OyaButton>
      </div>
    </form>
  </OyaModal>
</template>
