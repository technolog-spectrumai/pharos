<script setup lang="ts">
// One picture in a conversation: loaded from Rust when it is shown, opened
// full size on a click.
import { onMounted, ref } from "vue";
import { OyaModal } from "petalite/primitives";
import { imageUrl } from "../../friends/api";

const props = defineProps<{ id: string; alt: string }>();
const src = ref("");
const missing = ref(false);
const big = ref(false);

onMounted(async () => {
  try {
    src.value = await imageUrl(props.id);
  } catch {
    missing.value = true;
  }
});
</script>

<template>
  <button v-if="src" type="button" class="block" :aria-label="$t('friends.openImage')" @click="big = true">
    <img :src="src" :alt="alt" class="max-h-72 max-w-full rounded-xl object-contain" data-testid="friend-image" />
  </button>
  <div v-else class="flex h-24 w-40 items-center justify-center rounded-xl bg-current/10 text-xs opacity-60">
    <font-awesome-icon :icon="missing ? 'image' : 'spinner'" :spin="!missing" />
    <span class="ml-2">{{ missing ? $t('friends.imageNotKept') : $t('friends.imageLoading') }}</span>
  </div>
  <OyaModal v-model:open="big">
    <img :src="src" :alt="alt" class="max-h-[85vh] max-w-[92vw] rounded-xl object-contain" />
  </OyaModal>
</template>
