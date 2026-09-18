<script setup lang="ts">
// Up to three tags for one file.
//
// Three fields rather than a free-form chip editor: the cap is the product,
// and three boxes say it without a counter. The note is not decoration — a
// tag lives in plain text beside the file, encrypted or not, and the person
// typing one into an encrypted file's box is choosing to say one word about
// it in the clear.
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ModalPanel from "petalite/ModalPanel.vue";
import { OyaModal } from "petalite/primitives";
import { errorText, fsErrorKey } from "./fs";
import { MAX_TAGS, tagsGet, tagsSet } from "./tags";
import ManaCost from "../security/ManaCost.vue";
import { manaCharge, manaQuote, type ManaQuote } from "../security/mana";

const props = defineProps<{
  open: boolean;
  name: string;
  path: string;
  /** Whether the file is encrypted: the note is sharper for one. */
  sealed: boolean;
}>();

const emit = defineEmits<{
  "update:open": [boolean];
  saved: [string[]];
}>();

const { t } = useI18n({ useScope: "global" });

const fields = ref<string[]>(Array.from({ length: MAX_TAGS }, () => ""));
const busy = ref(false);
const error = ref("");
/** The tags as they were when the modal opened: only a NEW word written about
 *  an encrypted file is new exposure. Removing tags costs nothing. */
let before: string[] = [];
const quote = ref<ManaQuote | null>(null);

/** A Rust refusal ("at most 3 tags") as its sentence; anything else as it came. */
function sentence(err: unknown): string {
  const message = errorText(err);
  const key = fsErrorKey(message);
  return key ? t(key) : message;
}

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return;
  error.value = "";
  busy.value = true;
  try {
    const current = await tagsGet(props.path);
    before = current.map((tag) => tag.toLowerCase());
    fields.value = Array.from({ length: MAX_TAGS }, (_, i) => current[i] ?? "");
    quote.value = props.sealed ? await manaQuote("tag_sealed", 1) : null;
  } catch (err) {
    error.value = sentence(err);
  } finally {
    busy.value = false;
  }
});

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const saved = await tagsSet(props.path, fields.value);
    if (props.sealed && saved.some((tag) => !before.includes(tag.toLowerCase()))) {
      await manaCharge("tag_sealed", 1, props.path);
    }
    emit("saved", saved);
    emit("update:open", false);
  } catch (err) {
    error.value = sentence(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <OyaModal :open="open" @close="!busy && emit('update:open', false)">
    <ModalPanel :title="t('tags.title')">
      <p class="truncate text-xs opacity-60">{{ name }}</p>
      <div class="flex flex-col gap-1.5">
        <input v-for="(_, i) in fields" :key="i" v-model="fields[i]" type="text" autocomplete="off"
               :placeholder="t('tags.placeholder', { n: i + 1 })" :data-testid="`tag-field-${i}`"
               :disabled="busy" maxlength="32"
               class="w-full rounded-lg border border-accent-2 bg-transparent px-2.5 py-1.5 text-sm dark:border-accent-1"
               @keydown.enter="save" />
      </div>
      <p class="text-xs opacity-70" data-testid="tags-note">
        {{ t("tags.note") }}
        <span v-if="sealed" class="text-warn-dark" data-testid="tags-sealed-note">{{ t("tags.sealedNote") }}</span>
      </p>
      <template v-if="sealed && quote">
        <p class="text-xs" data-testid="tags-consequence">{{ t("mana.consequence.tag_sealed") }}</p>
        <ManaCost :quote="quote" />
      </template>
      <p v-if="error" class="text-sm text-warn-dark" data-testid="tags-error">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-lg border border-accent-2 px-3 py-1.5 text-sm dark:border-accent-1"
                :disabled="busy" @click="emit('update:open', false)">
          {{ t("common.cancel") }}
        </button>
        <button type="button" data-testid="tags-save"
                class="rounded-lg bg-accent-light px-3 py-1.5 text-sm font-bold text-primary-bg-light
                       transition hover:opacity-90 disabled:opacity-40 dark:bg-accent-dark dark:text-primary-bg-dark"
                :disabled="busy" @click="save">
          {{ t("common.save") }}
        </button>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
