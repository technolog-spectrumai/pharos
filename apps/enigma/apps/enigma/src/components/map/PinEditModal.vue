<script setup lang="ts">
// Create or edit a pin: name, an optional note, and a colour. The model has
// carried `color` and `note` since the start — they simply had no form until
// now, so a pin could never be more than a name, and a shared pin's colour was
// dropped on save.
import { ref, watch } from "vue";
import { OyaButton, OyaModal, OyaTextField, type MapPin } from "rakotis";
import { MAP_PIN_COLORS } from "./pinColors";

const props = defineProps<{
  open: boolean;
  /** Set = editing that pin; null = creating a new one. */
  pin?: MapPin | null;
}>();

const emit = defineEmits<{
  submit: [{ name: string; note: string; color: string }];
  close: [];
}>();

const name = ref("");
const note = ref("");
const color = ref<string>("");

// Reseed whenever the modal opens (or is retargeted at another pin).
watch(
  () => [props.open, props.pin?.id] as const,
  () => {
    if (!props.open) return;
    name.value = props.pin?.name ?? "";
    note.value = props.pin?.note ?? "";
    color.value = props.pin?.color ?? "";
  },
  { immediate: true },
);

function submit() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  emit("submit", { name: trimmed, note: note.value.trim(), color: color.value });
}
</script>

<template>
  <OyaModal :open="open" @close="emit('close')">
    <form
      class="w-full max-w-sm space-y-3 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark"
      @submit.prevent="submit"
    >
      <p class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="location-dot" />
        {{ pin ? $t('map.editPinTitle') : $t('map.namePinTitle') }}
      </p>

      <label class="block text-xs font-semibold uppercase tracking-wide opacity-70">
        {{ $t('map.nameLabel') }}
        <OyaTextField v-model="name" :maxlength="120" data-testid="pin-name" class="mt-1" />
      </label>

      <label class="block text-xs font-semibold uppercase tracking-wide opacity-70">
        {{ $t('map.pinNoteLabel') }}
        <OyaTextField v-model="note" :maxlength="500" data-testid="pin-note" class="mt-1" />
      </label>

      <div class="space-y-1">
        <p class="text-xs font-semibold uppercase tracking-wide opacity-70">{{ $t('map.pinColor') }}</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="swatch in MAP_PIN_COLORS"
            :key="swatch"
            type="button"
            :data-testid="`pin-color-${swatch.slice(1)}`"
            class="h-7 w-7 rounded-full border-2 transition hover:scale-110"
            :class="color === swatch ? 'border-highlight' : 'border-transparent'"
            :style="{ backgroundColor: swatch }"
            :aria-pressed="color === swatch"
            @click="color = color === swatch ? '' : swatch"
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <OyaButton variant="secondary" type="button" @click="emit('close')">
          {{ $t('common.cancel') }}
        </OyaButton>
        <OyaButton type="submit" :disabled="!name.trim()" data-testid="pin-submit">
          <font-awesome-icon icon="check" /> {{ $t('common.save') }}
        </OyaButton>
      </div>
    </form>
  </OyaModal>
</template>
