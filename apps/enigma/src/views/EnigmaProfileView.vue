<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { useUserStore } from "../stores/user";
import { useChatStore } from "../stores/chat";
import { OyaCard } from "petalite/primitives";
import { OyaButton } from "petalite/primitives";
import { downscaleImageToDataUrl } from "rakotis";
import { OyaAvatar } from "petalite/primitives";
import { useRouter } from "vue-router";
import { policy } from "../config/app";

// `embedded` = rendered inside another page (Settings) → drop the page header/back button.
defineProps<{ darkMode: boolean; embedded?: boolean }>();

const { t } = useI18n();
const router = useRouter();
const userStore = useUserStore();
const chatStore = useChatStore();
const {
  offlineProfile,
  offlineProfiles,
  selectedOfflineProfileId,
} = storeToRefs(userStore);

// Profile picture: picked file → small JPEG data URL on the profile (persisted
// by the normal Save; shared to room members over encrypted presence).
const avatarInput = ref<HTMLInputElement | null>(null);
async function onAvatarPicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (avatarInput.value) avatarInput.value.value = "";
  if (!file) return;
  offlineProfile.value.avatar = await downscaleImageToDataUrl(file, 256, 0.8);
}
function removeAvatar() {
  offlineProfile.value.avatar = "";
}

const savedOffline = ref(false);
const clearedOffline = ref(false);
const clearingAllData = ref(false);
const clearAllError = ref("");
const newOfflineProfileLabel = ref("");

const selectedOfflineProfileLabel = computed(() =>
  offlineProfiles.value.find((profile) => profile.id === selectedOfflineProfileId.value)?.label
  ?? t("profile.selectedProfile")
);

onMounted(async () => {
  await userStore.loadOfflineProfile();
});

async function saveOffline() {
  if (!offlineProfile.value.display_name.trim()) return;
  await userStore.saveOfflineProfile();
  savedOffline.value = true;
  setTimeout(() => (savedOffline.value = false), 2000);
}

async function chooseOfflineProfile(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  if (!id || id === selectedOfflineProfileId.value) return;
  await userStore.selectOfflineProfile(id);
}

async function saveAsNewOfflineProfile() {
  const label = newOfflineProfileLabel.value.trim();
  if (!label) return;
  const id = crypto.randomUUID?.() ?? `${Date.now()}`;
  await userStore.saveOfflineProfileAs(id, label);
  newOfflineProfileLabel.value = "";
  savedOffline.value = true;
  setTimeout(() => (savedOffline.value = false), 2000);
}

async function clearOfflineData() {
  await userStore.clearSelectedOfflineProfile();
  clearedOffline.value = true;
  savedOffline.value = false;
  setTimeout(() => (clearedOffline.value = false), 2000);
}

async function clearAllData() {
  if (clearingAllData.value) return;

  clearingAllData.value = true;
  clearAllError.value = "";
  try {
    await userStore.clearAllProfileData();
    chatStore.clearLocalChatState(t("profile.clearedNotice"));
    router.push("/chat");
  } catch (e) {
    clearAllError.value = (e as Error).message;
  } finally {
    clearingAllData.value = false;
  }
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6">

    <!-- Header (hidden when embedded inside the Settings page) -->
    <header v-if="!embedded" class="space-y-2">
      <button
        class="inline-flex items-center gap-2 text-sm underline hover:opacity-80"
        @click="router.push('/')"
      >
        <font-awesome-icon icon="arrow-left" />
        Back
      </button>

      <div>
        <p
          :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
          class="text-xs font-semibold uppercase tracking-wide"
        >
          Oya Studio
        </p>
        <h1 class="mt-1 flex items-center gap-3 text-3xl font-bold">
          <font-awesome-icon icon="user" />
          My Profile
        </h1>
      </div>
    </header>

    <!-- ── Local profile form ── -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-5">
      <div>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p
              :class="darkMode ? 'text-accent-dark' : 'text-accent-light'"
              class="text-xs font-semibold uppercase tracking-wide"
            >
              Profile
            </p>
            <p class="mt-1 text-sm opacity-60">
              Stored locally on this device. The display name is what peers see in chat.
            </p>
          </div>

          <label class="w-full space-y-1 sm:w-64">
            <span class="text-xs font-semibold uppercase tracking-wide opacity-60">
              Use data from
            </span>
            <select
              :value="selectedOfflineProfileId"
              :class="
                darkMode
                  ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark'
                  : 'bg-primary-bg-light border-accent-2 text-text-main-light'
              "
              class="w-full rounded-lg border px-3 py-2 text-sm font-semibold outline-none transition"
              @change="chooseOfflineProfile"
            >
              <option
                v-for="profile in offlineProfiles"
                :key="profile.id"
                :value="profile.id"
              >
                {{ profile.label }}
              </option>
            </select>
          </label>
        </div>
      </div>

      <div class="space-y-4">

        <!-- Profile picture (optional; shown to room members) -->
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Profile picture</label>
          <div class="flex items-center gap-3">
            <OyaAvatar :name="offlineProfile.display_name || '?'" :src="offlineProfile.avatar || ''" size="md" />
            <input
              ref="avatarInput"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              class="hidden"
              @change="onAvatarPicked"
            />
            <button
              type="button"
              class="rounded-lg border border-current/20 px-2.5 py-1 text-xs font-semibold transition hover:opacity-80"
              @click="avatarInput?.click()"
            >
              <font-awesome-icon icon="camera" class="mr-1" />Choose picture
            </button>
            <button
              v-if="offlineProfile.avatar"
              type="button"
              class="rounded-lg border border-current/20 px-2.5 py-1 text-xs font-semibold opacity-70 transition hover:opacity-100"
              @click="removeAvatar"
            >
              Remove
            </button>
          </div>
          <p class="text-[10px] opacity-50">Shared with your rooms (encrypted). Remember to save below.</p>
        </div>

        <!-- Display name (required) -->
        <div class="space-y-1">
          <label class="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide opacity-60">
            Display name
            <span class="text-warn-dark">*</span>
          </label>
          <input
            v-model="offlineProfile.display_name"
            type="text"
            :placeholder="$t('profile.yourNamePlaceholder')"
            :maxlength="policy.displayNameMaxLen"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
            "
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
          />
        </div>

        <!-- Email -->
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Email</label>
          <input
            v-model="offlineProfile.email"
            type="email"
            placeholder="you@example.com"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
            "
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
          />
        </div>

        <!-- Phone -->
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Phone</label>
          <input
            v-model="offlineProfile.phone"
            type="tel"
            placeholder="+1 555 000 0000"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
            "
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
          />
        </div>

        <!-- Date of birth -->
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Date of birth</label>
          <input
            v-model="offlineProfile.date_of_birth"
            type="date"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light'
            "
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none transition"
          />
        </div>

        <!-- Bio -->
        <div class="space-y-1">
          <label class="text-xs font-semibold uppercase tracking-wide opacity-60">Bio</label>
          <textarea
            v-model="offlineProfile.bio"
            rows="3"
            :placeholder="$t('profile.bioPlaceholder')"
            :class="
              darkMode
                ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
                : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
            "
            class="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition"
          />
        </div>

      </div>

      <div class="flex flex-col gap-2 sm:flex-row">
        <OyaButton
          :dark-mode="darkMode"
          :class="{ 'pointer-events-none opacity-50': !offlineProfile.display_name.trim() }"
          class="flex-1 justify-center"
          @click="saveOffline"
        >
          <font-awesome-icon :icon="savedOffline ? 'check' : 'floppy-disk'" />
          {{ savedOffline ? $t("profile.savedLocally") : $t("profile.saveNamed", { label: selectedOfflineProfileLabel }) }}
        </OyaButton>

        <OyaButton
          :dark-mode="darkMode"
          variant="secondary"
          class="justify-center"
          @click="clearOfflineData"
        >
          <font-awesome-icon :icon="clearedOffline ? 'check' : 'trash'" />
          {{ clearedOffline ? $t("profile.cleared") : $t("profile.clearData") }}
        </OyaButton>
      </div>

      <div class="flex flex-col gap-2 sm:flex-row">
        <input
          v-model="newOfflineProfileLabel"
          type="text"
          :placeholder="$t('profile.newProfilePlaceholder')"
          :maxlength="policy.profileNameMaxLen"
          :class="
            darkMode
              ? 'bg-primary-bg-dark border-accent-1 text-text-main-dark placeholder:text-text-main-dark/30'
              : 'bg-primary-bg-light border-accent-2 text-text-main-light placeholder:text-text-main-light/30'
          "
          class="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition"
        />
        <OyaButton
          :dark-mode="darkMode"
          variant="secondary"
          :class="{ 'pointer-events-none opacity-50': !newOfflineProfileLabel.trim() }"
          class="justify-center"
          @click="saveAsNewOfflineProfile"
        >
          <font-awesome-icon icon="plus" />
          Add profile
        </OyaButton>
      </div>
    </OyaCard>

    <!-- Danger zone -->
    <OyaCard :dark-mode="darkMode" :padded="true" class="space-y-4">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-warn-dark">
          {{ t("profile.dangerZone") }}
        </p>
        <p class="mt-1 text-sm opacity-60">
          {{ t("profile.dangerZoneHint") }}
        </p>
      </div>

      <div
        v-if="clearAllError"
        class="rounded-lg border border-warn-dark/30 bg-warn-dark/10 px-3 py-2 text-xs text-warn-dark"
      >
        {{ clearAllError }}
      </div>

      <OyaButton
        :dark-mode="darkMode"
        variant="secondary"
        :class="{ 'pointer-events-none opacity-50': clearingAllData }"
        class="justify-center border-warn-dark/50 text-warn-dark"
        @click="clearAllData"
      >
        <font-awesome-icon :icon="clearingAllData ? 'lock' : 'trash'" />
        {{ clearingAllData ? t("profile.clearingAllData") : t("profile.clearAllData") }}
      </OyaButton>
    </OyaCard>

  </section>
</template>
