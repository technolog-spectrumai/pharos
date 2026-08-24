<script setup lang="ts">
// The welcome page: what this app is, who you are on it, and what your privacy
// budget currently looks like. Reached by tapping the Enigma26 mark in the top
// left — that mark used to go to "/", which is also where every lock cycle
// re-enters, so the two were rewired apart: `/` still lands on your first visible
// tab after an unlock, and only a deliberate tap on the logo comes here.
//
// It is not a splash screen. Nothing gates on it, nothing is dismissed, and it
// keeps no state — it reads the same sources everything else does.
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  OyaAvatar,
  OyaCard,
  getBuildConfig,
  getOfflineProfile,
  getRuntimeConfig,
  type AppRuntimeConfig,
  type OfflineProfile,
} from "rakotis";
import { brand } from "../config/app";
import HpPanel from "../components/hp/HpPanel.vue";
import { isTabVisible, SETTINGS_PATH } from "../tabs";

const router = useRouter();
const cfg = getBuildConfig();

const profile = ref<OfflineProfile | null>(null);
const runtime = ref<AppRuntimeConfig | null>(null);

onMounted(async () => {
  // Both live behind the vault, so this view is only ever reachable unlocked.
  // Failures degrade to "not shown" rather than an error state: none of this is
  // load-bearing, and a welcome screen that can fail to open would be worse than
  // one missing a line.
  profile.value = await getOfflineProfile().catch(() => null);
  runtime.value = await getRuntimeConfig().catch(() => null);
});
</script>

<template>
  <section class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 pb-8">
    <!-- ── who this is ──────────────────────────────────────────────────── -->
    <OyaCard class="flex flex-col items-center gap-4 text-center">
      <img
        src="../assets/enigma26/app_icon.png"
        :alt="brand.name"
        class="h-24 w-24 rounded-2xl object-contain sm:h-28 sm:w-28"
      />
      <div class="flex flex-col gap-1">
        <h1 class="text-2xl font-bold tracking-wide sm:text-3xl">{{ brand.name }}</h1>
        <p class="text-xs opacity-60" data-testid="welcome-version">
          {{ $t("welcome.version", { v: cfg.app_version }) }}
        </p>
      </div>
      <p class="max-w-prose text-sm leading-relaxed opacity-80">{{ $t("welcome.tagline") }}</p>
    </OyaCard>

    <!-- ── who you are ──────────────────────────────────────────────────── -->
    <OyaCard class="flex flex-col gap-3">
      <h2 class="text-sm font-bold uppercase opacity-70">{{ $t("welcome.youTitle") }}</h2>
      <div class="flex items-center gap-4">
        <OyaAvatar :src="profile?.avatar || ''" :name="profile?.display_name || ''" size="md" />
        <div class="flex min-w-0 flex-col">
          <span class="truncate text-lg font-bold" data-testid="welcome-name">
            {{ profile?.display_name || $t("welcome.noName") }}
          </span>
          <!-- The MLS credential and the storage profile are different things and
               are labelled as such: one is who peers see, one is which vault is
               open. Conflating them is how people end up surprised by either. -->
          <span v-if="runtime" class="truncate text-xs opacity-60" data-testid="welcome-identity">
            {{ $t("welcome.identity", { id: runtime.identity }) }}
          </span>
          <span v-if="runtime" class="truncate text-xs opacity-50">
            {{ $t("welcome.profile", { p: runtime.profile }) }}
          </span>
        </div>
      </div>
    </OyaCard>

    <!-- ── your budget ──────────────────────────────────────────────────── -->
    <OyaCard class="flex flex-col gap-4">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-sm font-bold uppercase opacity-70">{{ $t("hp.title") }}</h2>
        <button
          type="button"
          class="text-xs font-semibold underline opacity-70 transition hover:opacity-100"
          data-testid="welcome-hp-details"
          @click="router.push(isTabVisible('privacy') ? '/privacy' : SETTINGS_PATH)"
        >
          {{ $t("hp.seeDetails") }}
        </button>
      </div>
      <HpPanel compact />
    </OyaCard>
  </section>
</template>
