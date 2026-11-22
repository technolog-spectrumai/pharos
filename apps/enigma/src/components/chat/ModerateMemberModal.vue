<script setup lang="ts">
// Captain-only moderation sheet for one member: timed mute (presets or custom
// minutes), unmute, and kick (two-step confirm). Actions go through the channel,
// which broadcasts them over the encrypted seam (technology.md §9 — cooperative,
// captain-authoritative enforcement).
import { ref, computed, watch } from "vue";
import { formatRemaining, MUTE_PRESETS_MIN } from "rakotis";
import { OyaModal, OyaAvatar, OyaButton } from "petalite/primitives";
import type { ChatChannel, Participant } from "rakotis";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps<{ open: boolean; participant: Participant | null; channel: ChatChannel }>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const customMin = ref<number | null>(null);
const confirmKick = ref(false);
watch(() => props.open, () => { confirmKick.value = false; customMin.value = null; });

const muteRemaining = computed(() => {
  const until = props.participant?.muteUntil;
  return until && until > Date.now() ? formatRemaining(until, Date.now()) : "";
});

function presetLabel(min: number): string {
  // The same unit keys the mute countdown uses, so a preset button and the badge it
  // produces cannot disagree about how an hour is spelled.
  return min >= 60 ? t("chat.dur.hours", { h: min / 60 }) : t("chat.dur.minutes", { m: min });
}

async function mute(minutes: number) {
  const id = props.participant?.id;
  if (!id || !Number.isFinite(minutes) || minutes <= 0) return;
  await props.channel.muteMember(id, Math.round(minutes));
  emit("update:open", false);
}

async function unmute() {
  const id = props.participant?.id;
  if (!id) return;
  await props.channel.unmuteMember(id);
  emit("update:open", false);
}

async function kick() {
  if (!confirmKick.value) { confirmKick.value = true; return; }
  const id = props.participant?.id;
  if (!id) return;
  await props.channel.kickMember(id);
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="emit('update:open', false)">
    <div v-if="participant" class="max-h-[85dvh] overflow-y-auto w-full max-w-sm space-y-4 rounded-2xl bg-primary-bg-light p-5 dark:bg-primary-bg-dark">
      <div class="flex items-center gap-3">
        <OyaAvatar :name="participant.name" :src="participant.avatar_url" size="md" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-base font-bold">{{ participant.name }}</p>
          <p v-if="muteRemaining" class="text-xs text-warn-dark">
            <font-awesome-icon icon="comment-slash" /> {{ $t("chat.mutedFor", { time: muteRemaining }) }}
          </p>
        </div>
      </div>

      <!-- Timed mute -->
      <div class="space-y-2">
        <p class="text-[10px] uppercase tracking-wide opacity-50">{{ $t("chat.muteFor") }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="min in MUTE_PRESETS_MIN"
            :key="min"
            type="button"
            class="rounded-lg border border-current/20 px-3 py-1.5 text-sm font-semibold transition hover:opacity-80"
            @click="mute(min)"
          >
            {{ presetLabel(min) }}
          </button>
          <input
            v-model.number="customMin"
            type="number"
            min="1"
            :placeholder="$t('chat.muteCustomMin')"
            class="w-24 rounded-lg border border-current/20 bg-transparent px-2 py-1.5 text-sm"
            @keyup.enter="customMin && mute(customMin)"
          />
          <button
            type="button"
            :disabled="!customMin || customMin <= 0"
            class="rounded-lg border border-current/20 px-3 py-1.5 text-sm font-semibold transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            @click="customMin && mute(customMin)"
          >
            {{ $t("chat.applyMute") }}
          </button>
        </div>
        <OyaButton v-if="muteRemaining" type="button" class="w-full" @click="unmute">
          <font-awesome-icon icon="comments" />{{ $t("chat.unmute") }}
        </OyaButton>
      </div>

      <!-- Kick (removes from the MLS group + bans the identity) -->
      <div class="space-y-1 border-t border-current/10 pt-3">
        <button
          type="button"
          :class="confirmKick ? 'bg-warn-dark text-white' : 'text-warn-dark hover:bg-warn-dark/10'"
          class="w-full rounded-lg border border-warn-dark px-3 py-2 text-sm font-semibold transition"
          @click="kick"
        >
          <font-awesome-icon icon="user-slash" class="mr-1" />
          {{ confirmKick ? $t("chat.kickConfirm") : $t("chat.kick") }}
        </button>
        <p class="text-[10px] opacity-50">{{ $t("chat.kickHint") }}</p>
      </div>
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        @click="emit('update:open', false)"
      >
        {{ $t("chat.close") }}
      </button>
    </template>
  </OyaModal>
</template>
