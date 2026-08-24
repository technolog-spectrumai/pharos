<script setup lang="ts">
// The price badge that sits beside a risky control: "−3 HP" plus an info dot
// that reveals one sentence about what becomes visible, and to whom.
//
// Two rules from the brief live in this component. The price is shown BEFORE the
// tap, never after — so this renders next to the button, not in a confirmation.
// And the explanation is one sentence: the popover has no scroll, no heading and
// no second paragraph, because a wall of text beside every switch is a wall of
// text nobody reads.
//
// It is a label, not a control: it never emits, never disables anything, and is
// `aria-hidden` from the button's own accessible name (the parent control keeps
// its label; the price is announced separately through the info button).
import { ref } from "vue";
import { formatPrice, severityOf } from "../../privacyHp";

const props = withDefaults(
  defineProps<{
    /** Centi-HP, signed. Negative spends, positive credits. */
    centi: number;
    /** One-sentence explanation, already translated by the caller. */
    explain?: string;
    /** Metered actions show a rate ("/msg", "/MiB") after the number. */
    unit?: string;
    size?: "sm" | "md";
    /** Hide the info dot where the surrounding copy already explains it. */
    noInfo?: boolean;
  }>(),
  { size: "sm", noInfo: false },
);

const open = ref(false);

/** Ladder rung → tone. Presentation only; nothing behaves differently. */
const toneClass: Record<string, string> = {
  negligible: "border-current/20 opacity-70",
  low: "border-current/25",
  moderate: "border-accent-1/50 text-accent-light dark:text-accent-dark",
  high: "border-warn-light/50 text-warn-light dark:border-warn-dark/50 dark:text-warn-dark",
  severe:
    "border-warn-light bg-warn-light/10 text-warn-light dark:border-warn-dark dark:bg-warn-dark/10 dark:text-warn-dark",
};

/** A credit is never alarming, whatever its size. */
function tone(): string {
  if (props.centi > 0)
    return "border-success-light/50 text-success-light dark:border-success-dark/50 dark:text-success-dark";
  return toneClass[severityOf(props.centi)];
}
</script>

<template>
  <span class="relative inline-flex items-center gap-1">
    <span
      :class="[tone(), size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]']"
      class="inline-flex shrink-0 items-center rounded-md border font-bold tabular-nums whitespace-nowrap"
      data-testid="hp-price"
    >
      {{ formatPrice(centi) }}<span v-if="unit" class="font-normal opacity-70">/{{ unit }}</span>
    </span>

    <!-- The info dot is a real button so it is keyboard-reachable; the popover
         is toggled rather than hover-only, because there is no hover on a phone. -->
    <button
      v-if="!noInfo && explain"
      type="button"
      class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current/30 text-[9px] opacity-60 transition hover:opacity-100"
      :aria-label="explain"
      :aria-expanded="open"
      data-testid="hp-info"
      @click.stop.prevent="open = !open"
    >
      <font-awesome-icon icon="info" />
    </button>

    <!-- Anchored above the badge and clamped to the viewport on narrow screens.
         Click-away is handled by the backdrop rather than a document listener,
         so nothing leaks if the parent unmounts mid-open. -->
    <template v-if="open">
      <span class="fixed inset-0 z-40 cursor-default" @click.stop.prevent="open = false" />
      <span
        role="tooltip"
        class="absolute bottom-full left-0 z-50 mb-2 w-64 max-w-[70vw] rounded-lg border border-current/20 bg-primary-bg-light p-3 text-left text-xs leading-relaxed font-normal normal-case shadow-lg dark:bg-primary-bg-dark"
        data-testid="hp-explain"
      >
        {{ explain }}
      </span>
    </template>
  </span>
</template>
