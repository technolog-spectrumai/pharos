<script setup lang="ts">
// Build a table from CSV — pasted, or loaded from a file.
//
// The table button used to insert a fixed 2×2 grid, which meant getting real
// data in was retyping it cell by cell. What people actually have is a
// spreadsheet selection on the clipboard or a .csv on disk, so this takes
// both.
//
// It PREVIEWS before it inserts, and that is the point rather than a polish:
// the delimiter is guessed, and a wrong guess turns a table into one column of
// run-together text. Seeing the grid first makes that obvious while it can
// still be fixed, instead of after it is in the document.
//
// The parsing is `petalite/formats`, shared with whatever imports CSV next —
// a field may hold the delimiter, a doubled quote or a literal newline, and
// that is not a thing to re-solve per app.
import { useWorkspace } from "petalite/files";
import { errorText, fsErrorKey, readText } from "../files/fs";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton, OyaModal } from "petalite/primitives";
import ModalPanel from "petalite/ModalPanel.vue";
import { parseCsv, sniffDelimiter } from "petalite/formats";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  "update:open": [boolean];
  insert: [{ rows: string[][]; withHeaderRow: boolean }];
}>();

const { t } = useI18n({ useScope: "global" });

/** A pasted sheet is unbounded input. Past this size the table stops being
 *  useful and starts making the editor unusable — so it is refused with a
 *  number, not silently truncated into something that looks complete. */
const MAX_ROWS = 200;
const MAX_COLS = 50;
/** How much of the grid the preview shows. */
const PREVIEW_ROWS = 8;
const PREVIEW_COLS = 8;

const text = ref("");
const withHeaderRow = ref(true);
/** Empty means "whatever the sniffer decides" — an explicit choice overrides. */
const delimiter = ref("");
const loadError = ref("");

const DELIMITERS = [
  { value: "", labelKey: "doc.csvAuto" },
  { value: ",", labelKey: "doc.csvComma" },
  { value: ";", labelKey: "doc.csvSemicolon" },
  { value: "\t", labelKey: "doc.csvTab" },
] as const;

const detected = computed(() => (text.value.trim() ? sniffDelimiter(text.value) : ","));

const rows = computed<string[][]>(() => {
  if (!text.value.trim()) return [];
  return parseCsv(text.value, { delimiter: delimiter.value || undefined });
});

const tooBig = computed(
  () => rows.value.length > MAX_ROWS || (rows.value[0]?.length ?? 0) > MAX_COLS,
);
const canInsert = computed(() => rows.value.length > 0 && !tooBig.value);

const preview = computed(() => rows.value.slice(0, PREVIEW_ROWS).map((r) => r.slice(0, PREVIEW_COLS)));
const hiddenRows = computed(() => Math.max(0, rows.value.length - PREVIEW_ROWS));
const hiddenCols = computed(() => Math.max(0, (rows.value[0]?.length ?? 0) - PREVIEW_COLS));

/** A fresh sheet each time the modal opens — a previous paste lingering in the
 *  box is confusing when the intent was to load a file. */
watch(() => props.open, (open) => {
  if (open) {
    text.value = "";
    delimiter.value = "";
    loadError.value = "";
    withHeaderRow.value = true;
  }
});

/** Where the file dialog starts, and the boundary a picked file must be in. */
const workspace = useWorkspace();

async function loadFile() {
  loadError.value = "";
  try {
    // Picked in the dialog, read through the workspace: a file outside it is
    // refused, and an encrypted one is refused rather than read as ciphertext.
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      defaultPath: workspace.root.value || undefined,
      filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
    });
    if (typeof picked !== "string") return;
    text.value = await readText(picked);
  } catch (err) {
    // A browser build has no dialog plugin, and a denied read is ordinary.
    // Say so rather than leaving a button that appears to do nothing.
    const message = errorText(err);
    const key = fsErrorKey(message);
    loadError.value = key ? t(key) : message;
  }
}

function confirm() {
  if (!canInsert.value) return;
  emit("insert", { rows: rows.value, withHeaderRow: withHeaderRow.value });
  emit("update:open", false);
}
</script>

<template>
  <OyaModal :open="open" @close="emit('update:open', false)">
    <ModalPanel :title="t('doc.csvTitle')">
      <p class="text-xs opacity-70">{{ t("doc.csvIntro") }}</p>

      <textarea
        v-model="text"
        data-testid="csv-input"
        rows="6"
        :placeholder="t('doc.csvPlaceholder')"
        class="w-full rounded-lg border border-current/15 bg-transparent p-2 font-mono text-xs"
      />

      <div class="flex flex-wrap items-center gap-2">
        <OyaButton variant="secondary" data-testid="csv-load" @click="loadFile">
          {{ t("doc.csvLoadFile") }}
        </OyaButton>

        <label class="flex items-center gap-1.5 text-xs">
          {{ t("doc.csvDelimiter") }}
          <select
            v-model="delimiter"
            data-testid="csv-delimiter"
            class="rounded-lg border border-current/15 bg-transparent px-2 py-1 text-xs"
          >
            <option v-for="d in DELIMITERS" :key="d.value" :value="d.value">
              {{ t(d.labelKey) }}
            </option>
          </select>
        </label>

        <label class="flex items-center gap-1.5 text-xs">
          <input v-model="withHeaderRow" type="checkbox" data-testid="csv-header" />
          {{ t("doc.csvHeaderRow") }}
        </label>
      </div>

      <p v-if="loadError" class="text-xs text-warn-dark" data-testid="csv-error">{{ loadError }}</p>

      <!-- The preview. A wrong delimiter shows up here as one wide column,
           which is the whole reason to look before inserting. -->
      <div v-if="preview.length" class="overflow-x-auto" data-testid="csv-preview">
        <p class="mb-1 text-xs opacity-60">
          {{ t("doc.csvDetected", { d: detected === "\t" ? "tab" : detected }) }}
          ·
          {{ t("doc.csvSize", { rows: rows.length, cols: rows[0]?.length ?? 0 }) }}
        </p>
        <table class="w-full border-collapse text-xs">
          <tbody>
            <tr v-for="(row, r) in preview" :key="r">
              <td
                v-for="(cell, c) in row"
                :key="c"
                class="max-w-[12rem] truncate border border-current/10 px-1.5 py-0.5"
                :class="r === 0 && withHeaderRow ? 'font-semibold opacity-100' : 'opacity-80'"
              >{{ cell }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="hiddenRows || hiddenCols" class="mt-1 text-xs opacity-60">
          {{ t("doc.csvMore", { rows: hiddenRows, cols: hiddenCols }) }}
        </p>
      </div>

      <p v-if="tooBig" class="text-xs text-warn-dark" data-testid="csv-too-big">
        {{ t("doc.csvTooBig", { rows: MAX_ROWS, cols: MAX_COLS }) }}
      </p>

      <div class="flex justify-end gap-2">
        <OyaButton variant="secondary" @click="emit('update:open', false)">
          {{ t("common.cancel") }}
        </OyaButton>
        <OyaButton data-testid="csv-insert" :disabled="!canInsert" @click="confirm">
          {{ t("doc.csvInsert") }}
        </OyaButton>
      </div>
    </ModalPanel>
  </OyaModal>
</template>
