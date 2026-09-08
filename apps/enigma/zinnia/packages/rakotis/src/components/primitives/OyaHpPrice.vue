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
import { onBeforeUnmount, ref } from "vue";
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
const trigger = ref<HTMLElement | null>(null);
const panelTop = ref(0);
const panelLeft = ref(0);

/** Panel width, and the gap it keeps from the viewport edge. */
const PANEL_W = 256;
const MARGIN = 12;

/**
 * Place the panel under the info dot, in viewport coordinates.
 *
 * It has to be measured rather than positioned with `absolute`, because this
 * badge lives inside modals whose card is `overflow-y-auto` — an absolutely
 * positioned child of a scroll container is CLIPPED by it, which is exactly how
 * the explanation ended up half off the side of the New-chat dialog. Teleporting
 * to <body> and using fixed coordinates is what takes it out of every ancestor's
 * clipping box.
 *
 * Opens DOWNWARD. Upward looked tidier next to a button near the bottom of a
 * dialog, but these badges usually sit near the top of one, where "up" is off
 * the dialog entirely.
 */
function place() {
  const el = trigger.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  panelTop.value = r.bottom + 8;
  // Right-align to the dot, then clamp both edges so a badge near either side of
  // the screen still shows the whole sentence.
  const wanted = r.right - PANEL_W;
  const maxLeft = window.innerWidth - PANEL_W - MARGIN;
  panelLeft.value = Math.max(MARGIN, Math.min(wanted, maxLeft));
}

function toggle() {
  open.value = !open.value;
  if (open.value) {
    place();
    // Reposition rather than drift: the badge can move under the panel when the
    // dialog behind it scrolls.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
  } else {
    detach();
  }
}

function close() {
  open.value = false;
  detach();
}

function detach() {
  window.removeEventListener("scroll", place, true);
  window.removeEventListener("resize", place);
}

// A badge can be unmounted while its panel is open (closing the dialog it sits
// in), and a listener outliving the component would keep measuring a dead node.
onBeforeUnmount(detach);

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
      ref="trigger"
      class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current/30 text-[9px] opacity-60 transition hover:opacity-100"
      :aria-label="explain"
      :aria-expanded="open"
      data-testid="hp-info"
      @click.stop.prevent="toggle()"
    >
      <font-awesome-icon icon="info" />
    </button>

    <!-- Teleported to <body> so no ancestor's `overflow` can clip it, and given
         fixed viewport coordinates by `place()`. z-75 sits above the modal layer
         (60) and the idle-lock toast (70) but below the vault gate (80) — the
         app's stacking ladder, see OyaModal. -->
    <Teleport to="body">
      <template v-if="open">
        <div
          class="fixed inset-0 z-[74] cursor-default"
          data-testid="hp-explain-backdrop"
          @click.stop.prevent="close()"
        />
        <div
          role="tooltip"
          class="fixed z-[75] rounded-lg border border-current/20 bg-primary-bg-light p-3 text-left text-xs leading-relaxed font-normal normal-case text-text-main-light shadow-lg dark:bg-primary-bg-dark dark:text-text-main-dark"
          :style="{
            top: `${panelTop}px`,
            left: `${panelLeft}px`,
            width: `${PANEL_W}px`,
            maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
          }"
          data-testid="hp-explain"
        >
          {{ explain }}
        </div>
      </template>
    </Teleport>
  </span>
</template>
