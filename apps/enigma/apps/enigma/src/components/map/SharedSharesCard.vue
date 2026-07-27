<script setup lang="ts">
// Sidebar list of what room members shared. Two groups, because the map can
// only honestly draw one of them: items an imported region covers, and items it
// doesn't. The second group exists so a share never vanishes silently — the
// user can still read it, save it, and learn which region package they'd need.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaCard } from "rakotis";
import { sharedItemName, type SharedItem } from "./sharedLayerModel";

const props = defineProps<{
  onMap: SharedItem[];
  outside: SharedItem[];
  visible: boolean;
}>();

const emit = defineEmits<{
  focus: [SharedItem];
  save: [SharedItem];
  toggle: [];
}>();

const { t } = useI18n({ useScope: "global" });

const outsideOpen = ref(false);
const total = computed(() => props.onMap.length + props.outside.length);

function icon(item: SharedItem): string {
  return item.kind === "loc" ? "location-crosshairs" : "location-dot";
}

function who(item: SharedItem): string {
  return item.self ? t("map.sharedYou") : t("map.sharedFrom", { name: item.sender });
}

function coords(item: SharedItem): string {
  const s = item.share;
  return t("map.locCoords", { lat: s.lat.toFixed(4), lng: s.lng.toFixed(4) });
}
</script>

<template>
  <OyaCard :padded="true" class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <p class="text-xs font-semibold uppercase tracking-wide text-accent-light dark:text-accent-dark">
        {{ t('map.sharedTitle') }}
      </p>
      <button
        v-if="total"
        type="button"
        data-testid="shared-sidebar-toggle"
        class="text-xs opacity-70 transition hover:opacity-100"
        :title="t('map.sharedLayerToggle')"
        @click="emit('toggle')"
      >
        <font-awesome-icon :icon="visible ? 'layer-group' : 'eye-slash'" />
      </button>
    </div>

    <p v-if="!total" class="text-sm opacity-60">{{ t('map.sharedNone') }}</p>

    <ul v-else-if="onMap.length" class="space-y-1">
      <li
        v-for="item in onMap"
        :key="item.key"
        class="flex items-center justify-between gap-2 rounded-lg border border-accent-2 px-2 py-1.5 dark:border-accent-1"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left transition hover:opacity-70"
          @click="emit('focus', item)"
        >
          <font-awesome-icon :icon="icon(item)" class="shrink-0 opacity-70" />
          <span class="min-w-0">
            <span class="block truncate text-sm">{{ sharedItemName(item, t('map.locCardDefault')) }}</span>
            <span class="block truncate text-xs opacity-60">{{ who(item) }} · {{ coords(item) }}</span>
          </span>
        </button>
        <OyaButton variant="secondary" :title="t('map.saveToMyPins')" @click="emit('save', item)">
          <font-awesome-icon icon="plus" />
        </OyaButton>
      </li>
    </ul>

    <!-- Shared, but no imported region covers it: listed, never drawn. -->
    <template v-if="outside.length">
      <button
        type="button"
        data-testid="shared-outside-toggle"
        class="w-full text-left text-xs opacity-60 transition hover:opacity-100"
        @click="outsideOpen = !outsideOpen"
      >
        <font-awesome-icon :icon="outsideOpen ? 'chevron-down' : 'chevron-right'" />
        {{ t('map.sharedOutsideCoverage', { n: outside.length }) }}
      </button>
      <template v-if="outsideOpen">
        <p class="text-xs opacity-50">{{ t('map.sharedOutsideHint') }}</p>
        <ul class="space-y-1">
          <li
            v-for="item in outside"
            :key="item.key"
            class="flex items-center justify-between gap-2 rounded-lg border border-dashed border-accent-2 px-2 py-1.5 dark:border-accent-1"
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 text-left transition hover:opacity-70"
              :title="t('map.noMapDataHere')"
              @click="emit('focus', item)"
            >
              <font-awesome-icon :icon="icon(item)" class="shrink-0 opacity-50" />
              <span class="min-w-0">
                <span class="block truncate text-sm opacity-80">
                  {{ sharedItemName(item, t('map.locCardDefault')) }}
                </span>
                <span class="block truncate text-xs opacity-50">{{ who(item) }} · {{ coords(item) }}</span>
              </span>
            </button>
            <OyaButton variant="secondary" :title="t('map.saveToMyPins')" @click="emit('save', item)">
              <font-awesome-icon icon="plus" />
            </OyaButton>
          </li>
        </ul>
      </template>
    </template>
  </OyaCard>
</template>
