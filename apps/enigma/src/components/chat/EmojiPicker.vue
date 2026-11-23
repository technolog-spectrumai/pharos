<script setup lang="ts">
import { ref } from "vue";

// `bare`: a borderless icon inside the composer's field, its panel opening to the left.
defineProps<{ disabled?: boolean; bare?: boolean }>();
const emit = defineEmits<{ select: [string] }>();

const open = ref(false);
const tab = ref(0);

const CATEGORIES: { label: string; emojis: string[] }[] = [
  { label: "😊", emojis: ["😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥸","🤩","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🫣","🤭","🫡","🤫","🤥","😶","😐","😑","😬","🫠","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🥴","🤢","🤮","🤧","😷","🤒","🤕"] },
  { label: "👍", emojis: ["👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","🫵","👍","👎","✊","👊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾","🦿","🦵","🦶","👂","🦻","👃","🫀","🫁","🧠","🦷","🦴","👀","👁️","👅","👄","🫦"] },
  { label: "❤️", emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️‍🔥","❤️‍🩹","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☯️","🕊️","🌈","⭐","🌟","💫","✨","🔥","🎉","🎊","🎈","🎁","🏆","🥇","🎯","💯","✅","❌","⚠️","💬","💭","🗯️"] },
  { label: "🐶", emojis: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🪱","🐛","🦋","🐌","🐞","🐜","🪲","🦟","🦗","🪳","🕷️","🦂","🐢","🐍","🦎","🦖","🐙","🦑","🦐","🦞","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🦭","🐅","🐆","🦓","🦍","🦧","🐘","🦛","🦏","🐪","🐫","🦒","🦘","🦬","🐃","🐂","🐄","🐎","🐖","🐏","🐑","🦙","🐐","🦌","🐕","🐩","🦮","🐈","🐓","🦃","🦤","🦚","🦜","🦢","🐇","🦝","🦨","🦡","🦦","🦥","🐁","🐀","🐿️","🦔"] },
  { label: "🍎", emojis: ["🍎","🍊","🍋","🍇","🍓","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🫐","🫒","🌽","🥕","🧄","🧅","🥦","🥬","🫑","🌶️","🥒","🥗","🥘","🫕","🍲","🍜","🍝","🍛","🍣","🍱","🍤","🍙","🍚","🍘","🧆","🍢","🍡","🍧","🍦","🍰","🎂","🧁","🍮","🍭","🍬","🍫","🍿","🍩","🍪","☕","🫖","🧋","🥤","🧃","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🧉","🍾"] },
  { label: "🚀", emojis: ["🚀","✈️","🚁","🚂","🚃","🚄","🚅","🚆","🚇","🚈","🚉","🚊","🚝","🚞","🚋","🚌","🚍","🚎","🏎️","🚐","🚑","🚒","🚓","🚔","🚕","🚖","🚗","🚘","🚙","🛻","🚚","🚛","🚜","🏍️","🛵","🚲","🛴","🛹","🛼","🚏","🛣️","🏖️","🏝️","🏔️","🗻","🏕️","🏜️","🏟️","🏛️","🏗️","🏘️","🏙️","🏚️","🏠","🏡","🏢","🏣","🏤","🏥","🏦","🏨","🏩","🏪","🏫","🏬","🏭","🏯","🏰","💒","🗼","🗽","⛪","🕌","🛕","🕍","⛩️","🌍","🌎","🌏","🌐","🗺️"] },
];

function pick(e: string) {
  emit("select", e);
  open.value = false;
}
</script>

<template>
  <div class="relative shrink-0">
    <button
      type="button"
      :disabled="disabled"
      :class="[
        disabled ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80',
        open ? 'bg-primary-bg-light dark:bg-primary-bg-dark' : '',
        bare ? 'h-9 w-9 rounded-full' : 'h-11 w-11 rounded-lg border border-accent-2 text-text-main-light dark:border-accent-1 dark:text-text-main-dark',
      ]"
      class="inline-flex shrink-0 items-center justify-center text-lg transition"
      title="Emoji"
      aria-label="Emoji"
      @click="open = !open"
    >
      😊
    </button>

    <div v-if="open" class="fixed inset-0 z-40" @click="open = false" />
    <div
      v-if="open"
      :class="bare ? 'right-0' : 'left-0'"
      class="absolute bottom-full mb-2 z-50 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border shadow-xl bg-bubble-bg-light border-accent-2 dark:bg-bubble-bg-dark dark:border-accent-1"
    >
      <div class="flex overflow-x-auto border-b border-accent-2 bg-primary-bg-light dark:border-accent-1 dark:bg-primary-bg-dark">
        <button
          v-for="(cat, i) in CATEGORIES"
          :key="i"
          class="flex-shrink-0 border-b-2 px-3 py-2 text-base transition hover:opacity-80"
          :class="tab === i ? 'border-accent-light dark:border-accent-dark' : 'border-transparent opacity-50'"
          @click="tab = i"
        >
          {{ cat.label }}
        </button>
      </div>
      <div class="grid h-44 grid-cols-8 gap-0.5 overflow-y-auto p-2">
        <button
          v-for="e in CATEGORIES[tab].emojis"
          :key="e"
          class="flex items-center justify-center rounded p-1 text-lg leading-none transition hover:opacity-80 hover:bg-black/5 dark:hover:bg-white/10"
          @click="pick(e)"
        >
          {{ e }}
        </button>
      </div>
    </div>
  </div>
</template>
