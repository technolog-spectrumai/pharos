<script setup lang="ts">
// Signing in to a platform server.
//
// Sign-in only. Registration is deliberately not offered here — accounts are
// made in a browser on the server's own page, and a desktop form that created
// one would be a second, unreviewed path into the same account system.
//
// The certificate warning is a STATE, not a checkbox beside the button. A
// checkbox invites clicking past it; a step that shows the fingerprint and asks
// is a decision the user actually makes, and one that stops applying the moment
// the certificate changes.
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useCloud } from "../cloud/useCloud";

const { t } = useI18n({ useScope: "global" });
const cloud = useCloud();

const address = ref(cloud.settings.value.server);
const user = ref("");
const password = ref("");

onMounted(() => void cloud.refresh());

async function onProbe() {
  await cloud.probe(address.value.trim());
}

function onTrust() {
  cloud.trust(address.value.trim());
}

async function onSignIn() {
  const ok = await cloud.signIn(address.value.trim(), user.value.trim(), password.value);
  // Cleared either way: a failed attempt leaves a password sitting in a field
  // for the next person at the keyboard just as a successful one would.
  password.value = "";
  if (ok) user.value = "";
}

/** Errors arrive from Rust as `prefix: detail`. The prefix is the contract;
 *  the detail is for the log, not the user. */
function reasonKey(message: string): string {
  const prefix = message.split(":")[0];
  const known = [
    "insecure_scheme", "no_server", "bad_url", "bad_credentials",
    "untrusted_cert", "timeout", "unreachable", "desktop_only", "bad_response",
  ];
  return known.includes(prefix) ? `cloud.errors.${prefix}` : "cloud.errors.unknown";
}

async function openRegistration() {
  const base = cloud.settings.value.server || address.value.trim();
  if (!base) return;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(`${base}/sso/`);
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto p-6">
    <div class="mx-auto w-full max-w-xl">
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <font-awesome-icon icon="cloud" class="opacity-60" />
        {{ t("cloud.title") }}
      </h2>
      <p class="mt-1 text-sm opacity-70">{{ t("cloud.help") }}</p>

      <!-- ── signed in ────────────────────────────────────────────────── -->
      <div v-if="cloud.signedIn.value" class="mt-5 space-y-3" data-testid="cloud-session">
        <div class="rounded-xl border border-accent-2 p-4 dark:border-accent-1">
          <p class="text-sm">
            <span class="opacity-60">{{ t("cloud.signedInAs") }}</span>
            <span class="ml-1.5 font-bold" data-testid="cloud-username">{{ cloud.username.value }}</span>
          </p>
          <p class="mt-1 truncate text-xs opacity-60" data-testid="cloud-server">
            {{ cloud.settings.value.server }}
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span v-if="cloud.settings.value.fingerprint"
                  class="rounded border border-current/25 px-1.5 py-0.5 opacity-70"
                  :title="cloud.settings.value.fingerprint"
                  data-testid="cloud-pinned">
              <font-awesome-icon icon="lock" /> {{ t("cloud.pinned") }}
            </span>
            <!-- Said plainly rather than hidden: a session that will not
                 survive a restart should not look like one that will. -->
            <span v-if="cloud.storage.value === 'memory'"
                  class="rounded border border-current/25 px-1.5 py-0.5 text-warn-dark"
                  data-testid="cloud-memory-only">
              {{ t("cloud.memoryOnly") }}
            </span>
          </div>
        </div>

        <button type="button" data-testid="cloud-signout"
                class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
                :disabled="cloud.busy.value" @click="cloud.signOut()">
          {{ t("cloud.signOut") }}
        </button>
      </div>

      <!-- ── signed out ───────────────────────────────────────────────── -->
      <form v-else class="mt-5 space-y-4" data-testid="cloud-form" @submit.prevent="onSignIn">
        <div>
          <label class="mb-1 block text-xs font-semibold opacity-70" for="cloud-address">
            {{ t("cloud.address") }}
          </label>
          <div class="flex gap-2">
            <input id="cloud-address" v-model="address" type="url" inputmode="url"
                   placeholder="https://" spellcheck="false" autocomplete="off"
                   data-testid="cloud-address"
                   class="min-w-0 flex-1 rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1" />
            <button type="button" data-testid="cloud-check"
                    class="shrink-0 rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:opacity-80 disabled:opacity-40 dark:border-accent-1"
                    :disabled="cloud.busy.value || !address.trim()" @click="onProbe">
              <font-awesome-icon :icon="cloud.busy.value ? 'spinner' : 'plug'" :spin="cloud.busy.value" />
              {{ t("cloud.check") }}
            </button>
          </div>
          <p class="mt-1 text-xs opacity-50">{{ t("cloud.httpsOnly") }}</p>
        </div>

        <!-- The certificate step. Shown instead of the credentials, never
             beside them: the point is that the decision comes first. -->
        <div v-if="cloud.needsTrust.value"
             class="rounded-xl border border-dashed border-warn-dark p-4"
             data-testid="cloud-untrusted">
          <p class="text-sm font-semibold">
            <font-awesome-icon icon="triangle-exclamation" class="text-warn-dark" />
            {{ t("cloud.untrustedTitle") }}
          </p>
          <p class="mt-1 text-xs opacity-70">{{ t("cloud.untrustedBody") }}</p>
          <code class="mt-2 block break-all rounded bg-current/5 p-2 text-[11px]"
                data-testid="cloud-fingerprint">{{ cloud.pending.value?.fingerprint }}</code>
          <button type="button" data-testid="cloud-trust"
                  class="mt-3 rounded-lg border border-accent-2 px-3 py-1.5 text-sm transition hover:opacity-80 dark:border-accent-1"
                  @click="onTrust">
            {{ t("cloud.trustIt") }}
          </button>
        </div>

        <template v-else-if="cloud.pending.value?.reachable || cloud.settings.value.server">
          <div>
            <label class="mb-1 block text-xs font-semibold opacity-70" for="cloud-user">
              {{ t("cloud.username") }}
            </label>
            <input id="cloud-user" v-model="user" type="text" autocomplete="username"
                   spellcheck="false" data-testid="cloud-user"
                   class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1" />
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold opacity-70" for="cloud-password">
              {{ t("cloud.password") }}
            </label>
            <input id="cloud-password" v-model="password" type="password"
                   autocomplete="current-password" data-testid="cloud-password"
                   class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1" />
          </div>

          <button type="submit" data-testid="cloud-signin"
                  class="rounded-lg bg-accent-light px-4 py-1.5 text-sm font-bold text-primary-bg-light transition
                         hover:opacity-90 disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                  :disabled="cloud.busy.value || !user.trim() || !password">
            <font-awesome-icon v-if="cloud.busy.value" icon="spinner" spin />
            {{ t("cloud.signIn") }}
          </button>

          <!-- Stated, not offered: accounts are made on the server. -->
          <p class="text-xs opacity-60">
            {{ t("cloud.noRegistration") }}
            <button type="button" class="underline" data-testid="cloud-register" @click="openRegistration">
              {{ t("cloud.openServer") }}
            </button>
          </p>
        </template>

        <p v-if="cloud.error.value" class="text-sm text-warn-dark" data-testid="cloud-error">
          {{ t(reasonKey(cloud.error.value)) }}
        </p>
      </form>
    </div>
  </div>
</template>
