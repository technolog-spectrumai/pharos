<script setup lang="ts">
// On-screen numeric keypad for PIN unlock. Deliberately plain: filled dots
// rather than digits (shoulder-surfing), no delete-all, and it submits itself
// the moment the last digit lands — a PIN of known length has no "done" step.
//
// Physical number keys work too; the pad is an affordance, not a restriction.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

const props = defineProps<{
  digits: number;
  /** Blocks input while the unlock is in flight. */
  busy?: boolean;
  /** Shown under the dots; also triggers the shake + clear. */
  error?: string;
}>();

const emit = defineEmits<{ (e: "submit", pin: string): void }>();

const entered = ref("");
const shake = ref(false);

const slots = computed(() => Array.from({ length: props.digits }, (_, i) => i < entered.value.length));

function press(digit: string): void {
  if (props.busy || entered.value.length >= props.digits) return;
  entered.value += digit;
  if (entered.value.length === props.digits) {
    const pin = entered.value;
    emit("submit", pin);
  }
}

function backspace(): void {
  if (props.busy) return;
  entered.value = entered.value.slice(0, -1);
}

/** A fresh error means that attempt failed: shake, then clear for a retry. */
watch(
  () => props.error,
  (message) => {
    if (!message) return;
    shake.value = true;
    entered.value = "";
    setTimeout(() => (shake.value = false), 400);
  },
);

function onKey(event: KeyboardEvent): void {
  if (event.key >= "0" && event.key <= "9") {
    press(event.key);
    event.preventDefault();
  } else if (event.key === "Backspace") {
    backspace();
    event.preventDefault();
  }
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));

defineExpose({ clear: () => (entered.value = "") });
</script>

<template>
  <div class="flex flex-col items-center gap-5" data-testid="pin-pad">
    <!-- Dots: how many digits are in, never which ones -->
    <div class="flex gap-3" :class="shake ? 'animate-pulse' : ''" data-testid="pin-dots">
      <span
        v-for="(filled, i) in slots"
        :key="i"
        class="h-3.5 w-3.5 rounded-full border-2 transition"
        :class="filled
          ? 'border-accent-dark bg-accent-dark'
          : 'border-current/30'"
        :data-filled="filled"
      />
    </div>

    <p v-if="error" class="text-sm text-warn-dark" data-testid="pin-error">{{ error }}</p>

    <div class="grid grid-cols-3 gap-3">
      <button
        v-for="n in 9"
        :key="n"
        type="button"
        class="h-16 w-16 rounded-full border border-current/15 text-xl font-semibold transition hover:bg-current/10 active:scale-95 disabled:opacity-40"
        :disabled="busy"
        :data-testid="`pin-key-${n}`"
        @click="press(String(n))"
      >
        {{ n }}
      </button>
      <span />
      <button
        type="button"
        class="h-16 w-16 rounded-full border border-current/15 text-xl font-semibold transition hover:bg-current/10 active:scale-95 disabled:opacity-40"
        :disabled="busy"
        data-testid="pin-key-0"
        @click="press('0')"
      >
        0
      </button>
      <button
        type="button"
        class="h-16 w-16 rounded-full text-xl transition hover:bg-current/10 active:scale-95 disabled:opacity-40"
        :disabled="busy || entered.length === 0"
        :aria-label="$t('common.back')"
        data-testid="pin-backspace"
        @click="backspace"
      >
        <font-awesome-icon icon="delete-left" />
      </button>
    </div>
  </div>
</template>
