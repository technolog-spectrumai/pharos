<script setup lang="ts">
// Point the app at a server and hand it a token.
//
// TWO STEPS, and the split is the security design rather than a nicety. `probe`
// looks at the server before the token field is worth showing: it says whether
// the address answers and whether its certificate is trusted, and — when it is
// not — hands back the fingerprint for the user to compare. Only after that is
// a token asked for, so nobody pastes a credential at a server they have not
// looked at.
//
// The token field is `type="password"` and cleared the moment `connect`
// returns. It goes straight through to Rust, which writes it to the OS keyring;
// nothing on this side keeps it and no command hands it back.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaTextField } from "petalite/primitives";
import { looksLikeToken } from "totoapi";
// NOT `session` or `forget`: this component is only ever rendered when there
// is no connection. The "connected as…" panel it used to carry was dead code —
// App shows this view only when `!session.connected` — and now lives on the
// workspace picker, which is the screen a connected person is actually on.
import { probe, connect, session } from "../platform/session";

const { t } = useI18n({ useScope: "global" });

const server = ref(session.server);
const token = ref("");
const checking = ref(false);
const probed = ref<{
  reachable: boolean; tls: string; fingerprint: string | null; reason: string | null;
} | null>(null);
const accepted = ref(false);
const failure = ref("");

/** The certificate needs a decision before a token is worth pasting. */
const needsDecision = computed(
  () => probed.value !== null && probed.value.tls === "untrusted" && !accepted.value,
);

/** Shape only. The SERVER decides whether a token is live — this just catches
 *  a pasted URL or a truncated copy before a round trip. */
const tokenLooksRight = computed(() => looksLikeToken(token.value));

const canConnect = computed(
  () => Boolean(server.value.trim()) && tokenLooksRight.value
    && !needsDecision.value && !session.busy,
);

async function check() {
  failure.value = "";
  accepted.value = false;
  checking.value = true;
  try {
    probed.value = await probe(server.value.trim());
    if (!probed.value.reachable && probed.value.tls !== "untrusted") {
      failure.value = t("errors.unreachable");
    }
  } catch (err) {
    failure.value = String(err);
    probed.value = null;
  } finally {
    checking.value = false;
  }
}

async function submit() {
  failure.value = "";
  try {
    await connect(
      server.value.trim(), token.value,
      accepted.value ? (probed.value?.fingerprint ?? "") : "",
    );
  } catch (err) {
    failure.value = String(err).includes("bad_token")
      ? t("errors.badToken")
      : t("errors.generic", { detail: String(err) });
  } finally {
    // ALWAYS, including on failure: a token left in a field survives into a
    // screenshot, a bug report and the next person to walk past the screen.
    token.value = "";
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-xl flex-col gap-4 p-6">
    <header>
      <h1 class="text-xl font-bold">{{ t("connect.title") }}</h1>
      <p class="text-sm opacity-70">{{ t("app.tagline") }}</p>
    </header>

    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">{{ t("connect.server") }}</span>
        <OyaTextField v-model="server" placeholder="https://" data-testid="server" />
        <span class="text-xs opacity-60">{{ t("connect.serverHint") }}</span>
      </label>

      <div>
        <OyaButton type="button" data-testid="check" :disabled="checking || !server.trim()"
                   @click="check">
          {{ t("connect.check") }}
        </OyaButton>
      </div>

      <!-- The fingerprint the user has to compare. Shown in full and in the
           same format `openssl x509 -fingerprint -sha256` prints, so it can be
           checked by eye against what an administrator sent. -->
      <section v-if="needsDecision" class="rounded-xl border border-amber-500 p-3"
               data-testid="untrusted">
        <p class="text-sm">{{ t("connect.untrustedCert") }}</p>
        <code class="mt-2 block break-all text-xs">{{ probed?.fingerprint }}</code>
        <OyaButton class="mt-2" variant="secondary" data-testid="accept" @click="accepted = true">
          {{ t("connect.accept") }}
        </OyaButton>
      </section>

      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">{{ t("connect.token") }}</span>
        <OyaTextField v-model="token" type="password" data-testid="token"
                      placeholder="capsule." />
        <!-- The only place a person is told where the token comes from. -->
        <span class="text-xs opacity-60">{{ t("connect.tokenHint") }}</span>
      </label>

      <div>
        <OyaButton type="submit" :disabled="!canConnect" data-testid="connect">
          {{ t("connect.connect") }}
        </OyaButton>
      </div>

      <p v-if="failure" class="text-sm text-red-600" data-testid="failure">{{ failure }}</p>
    </form>
  </div>
</template>
