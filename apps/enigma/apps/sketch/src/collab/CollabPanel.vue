<script setup lang="ts">
// The Collab tab: pair the drawing on screen with ONE other person's, by QR.
//
// Two roles, one screen. The host shows a code; the joiner scans or pastes
// it. Then both see six digits and the HOST decides — that tap is what sends
// the document, and there is no path around it (useCollabSession.accept; the
// Rust gate drops the joiner's frames until the `Welcome` it sends). The
// digits are the defence against a photographed code: whoever scans it first
// lands on the topic, but their digits are not the ones the person you are
// looking at reads out, and you refuse.
//
// The session outlives this tab. It is a singleton the editor attaches to
// (src/collab/index.ts), so switching to the Sketch tab to draw does not end
// it; the header shows a badge while it runs, and New/Open ends it.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaQrCode, OyaTextField } from "petalite/primitives";
import QrScanner from "./QrScanner.vue";
import type { CollabSession } from "./useCollabSession";

const props = defineProps<{ session: CollabSession }>();
const { t } = useI18n({ useScope: "global" });

const joining = ref(false);
const code = ref("");
const scanning = ref(false);
const copied = ref(false);

const phase = computed(() => props.session.phase.value);

/** A catalogue key is translated; anything else is shown as it came, which
 *  for a network message says more than "something failed" would. */
const errorText = computed(() => {
  const e = props.session.error.value;
  if (!e) return "";
  return e.startsWith("collab.errors.") ? t(e) : e;
});

async function copy() {
  const text = props.session.ticket.value;
  if (!text) return;
  try {
    await navigator.clipboard?.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* no clipboard here; the code is selectable on screen */
  }
}

async function join(text = code.value) {
  const value = text.trim();
  if (!value) return;
  joining.value = false;
  await props.session.join(value);
}

function onDecoded(text: string) {
  code.value = text;
  void join(text);
}

async function leave() {
  await props.session.leave();
  joining.value = false;
  code.value = "";
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-6" data-testid="collab-panel">
    <div class="flex w-full max-w-md flex-col gap-4">
      <h2 class="text-base font-semibold">{{ t("collab.title") }}</h2>

      <!-- idle: pick a side -->
      <template v-if="phase === 'idle'">
        <p class="text-sm opacity-70">{{ t("collab.intro") }}</p>
        <p v-if="!session.attached.value" class="text-xs text-warn-dark" data-testid="collab-noboard">
          {{ t("collab.noBoard") }}
        </p>
        <div v-if="!joining" class="flex flex-col gap-2">
          <OyaButton data-testid="collab-share" :disabled="!session.attached.value" @click="session.host()">
            <font-awesome-icon icon="qrcode" class="mr-2" />{{ t("collab.share") }}
          </OyaButton>
          <OyaButton variant="secondary" data-testid="collab-join" :disabled="!session.attached.value" @click="joining = true">
            <font-awesome-icon icon="user-group" class="mr-2" />{{ t("collab.join") }}
          </OyaButton>
        </div>
        <div v-else class="flex flex-col gap-2">
          <p class="text-xs text-warn-dark">{{ t("collab.joinHint") }}</p>
          <OyaTextField v-model="code" :placeholder="t('collab.codePlaceholder')" @enter="join()" />
          <div class="flex flex-wrap gap-2">
            <OyaButton data-testid="collab-connect" :disabled="!code.trim()" @click="join()">
              {{ t("collab.connect") }}
            </OyaButton>
            <OyaButton variant="secondary" data-testid="collab-scan" @click="scanning = true">
              <font-awesome-icon icon="camera" class="mr-2" />{{ t("collab.scan") }}
            </OyaButton>
            <OyaButton variant="secondary" data-testid="collab-back" @click="joining = false">{{ t("common.cancel") }}</OyaButton>
          </div>
        </div>
      </template>

      <!-- hosting: the code is on screen, nobody has scanned it yet -->
      <template v-else-if="phase === 'hosting'">
        <p class="text-sm opacity-70">{{ t("collab.showHint") }}</p>
        <OyaQrCode v-if="session.ticket.value" :value="session.ticket.value" :size="280" :alt="t('collab.share')" />
        <p class="select-all break-all rounded-lg border border-current/10 px-3 py-2 font-mono text-xs" data-testid="collab-ticket">
          {{ session.ticket.value }}
        </p>
        <div class="flex gap-2">
          <OyaButton variant="secondary" data-testid="collab-copy" @click="copy">
            <font-awesome-icon icon="copy" class="mr-2" />{{ copied ? t("collab.copied") : t("collab.copy") }}
          </OyaButton>
          <OyaButton variant="secondary" data-testid="collab-cancel" @click="leave">{{ t("common.cancel") }}</OyaButton>
        </div>
      </template>

      <!-- pairing: the digits, and the host's decision -->
      <template v-else-if="phase === 'pairing'">
        <p class="text-sm opacity-70">{{ t("collab.checkDigits") }}</p>
        <p class="text-center font-mono text-4xl tracking-[0.3em]" data-testid="collab-sas">{{ session.sas.value }}</p>
        <div v-if="session.role.value === 'host'" class="flex gap-2">
          <OyaButton data-testid="collab-accept" @click="session.accept()">
            <font-awesome-icon icon="check" class="mr-2" />{{ t("collab.accept") }}
          </OyaButton>
          <OyaButton variant="secondary" data-testid="collab-reject" @click="leave">{{ t("collab.reject") }}</OyaButton>
        </div>
        <template v-else>
          <p class="text-sm opacity-70" data-testid="collab-waiting">{{ t("collab.waitingHost") }}</p>
          <OyaButton variant="secondary" data-testid="collab-cancel" @click="leave">{{ t("common.cancel") }}</OyaButton>
        </template>
      </template>

      <!-- live -->
      <template v-else>
        <p class="flex items-center gap-2 text-sm" data-testid="collab-live">
          <span class="inline-block h-2 w-2 rounded-full"
                :class="session.peerOnline.value ? 'bg-accent-light dark:bg-accent-dark' : 'bg-warn-dark'" />
          {{ session.peerOnline.value ? t("collab.live") : t("collab.peerOffline") }}
        </p>
        <p v-if="session.truncated.value" class="text-xs text-warn-dark" data-testid="collab-truncated">{{ t("collab.truncated") }}</p>
        <OyaButton variant="secondary" data-testid="collab-leave" @click="leave">{{ t("collab.leave") }}</OyaButton>
      </template>

      <p v-if="errorText" class="text-xs text-warn-dark" data-testid="collab-error">{{ errorText }}</p>
    </div>

    <QrScanner v-model:open="scanning" @decoded="onDecoded" />
  </div>
</template>
