<script setup lang="ts">
// A person's icon: the first letter of their nickname (avatarIcon.ts).
import { computed } from "vue";
import { letterIcon } from "../avatarIcon";

const props = withDefaults(defineProps<{ name: string; size?: "sm" | "md" | "lg" }>(), { size: "md" });
const src = computed(() => letterIcon(props.name));
const box = computed(() => ({ sm: "h-8 w-8", md: "h-10 w-10", lg: "h-14 w-14" })[props.size]);
</script>

<template>
  <img :src="src" :alt="name" class="shrink-0 rounded-full" :class="box" data-testid="letter-avatar" />
</template>
