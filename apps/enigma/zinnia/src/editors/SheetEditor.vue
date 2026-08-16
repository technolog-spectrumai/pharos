<script setup lang="ts">
// Primula's spreadsheet, under zinnia's editor contract (./types.ts).
//
// The boundary with Univer is deliberately narrow: snapshot in, snapshot out.
// Univer owns its own state and command system, and funnelling every cell edit
// through ours would mean fighting the library forever for nothing — the file
// is the snapshot, and `workbook.save()` is the only way to produce one.
//
// The consequence, stated because it matters later: the Yjs-swappability the
// other editors have does NOT extend here. A collaborative future for sheets
// goes through Univer's own collaboration plugin behind the same transport, not
// through a CRDT we drive.
//
// Loaded from npm rather than the UMD globals the web editor uses, so React,
// ReactDOM and RxJS come along as ordinary dependencies with no load-order rule
// to get wrong.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import OyaButton from "rakotis/components/primitives/OyaButton.vue";
import { dumps, isSheet, loads, newWorkbook, type Workbook } from "../formats/sheet";
import { isDark, watchDark } from "../theme";

const props = defineProps<{
  path: string | null;
  name: string;
  content: string;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  save: [content: string];
  "update:dirty": [boolean];
  "open-as-text": [];
}>();

const { t } = useI18n({ useScope: "global" });

const host = ref<HTMLElement | null>(null);
const notSheet = ref(false);
const mountError = ref("");
/** shallowRef: Univer holds its own reactive graph and Vue must not walk into
 *  it — the same reason the sketch orchestrator is held this way. */
const api = shallowRef<{
  getActiveWorkbook(): { save(): Workbook };
  toggleDarkMode?(on: boolean): void;
} | null>(null);
let stopDarkWatch: (() => void) | null = null;
let disposeUniver: (() => void) | null = null;
/** The snapshot we handed Univer, kept because the grid mounts ASYNCHRONOUSLY.
 *  Until it is up there is no workbook to ask, and answering with the original
 *  buffer would mean a Ctrl+S in that window saves a brand-new sheet as an
 *  empty file. */
let pending: Workbook | null = null;

/** The snapshot as of the last successful save; dirtiness measures against it. */
let savedContent = props.content;
const dirty = ref(false);

function setDirty(v: boolean) {
  if (dirty.value === v) return;
  dirty.value = v;
  emit("update:dirty", v);
}

function currentText(): string {
  const wb = api.value?.getActiveWorkbook();
  if (wb) return dumps(wb.save());
  if (pending) return dumps(pending);
  return savedContent;
}

/** Baseline against what we WOULD write, like every other editor here: Univer
 *  normalises a snapshot on load (filling defaults it owns), so comparing
 *  against the bytes we read marks every opened sheet unsaved. */
function baseline() {
  savedContent = currentText();
  setDirty(false);
}

function save() {
  if (props.busy) return;
  emit("save", currentText());
}

async function mountUniver() {
  const el = host.value;
  if (!el) return;

  let snapshot: Workbook;
  if (!props.content.trim()) {
    snapshot = newWorkbook(props.name.replace(/\.[^.]+$/, "") || "New sheet");
  } else if (!isSheet(props.content)) {
    notSheet.value = true;
    return;
  } else {
    snapshot = loads(props.content);
  }
  pending = snapshot;
  // Baseline now, not only after the grid is up: a save between these two
  // points must write the workbook, not the buffer it came from.
  baseline();

  try {
    // Univer lays the grid out from the container's box the moment it is
    // created, and a container with no width yields a negative column width —
    // "The column width is less than 0, need to adjust page width to make it
    // great than 0" from engine-render. A flex child measured in the same tick
    // it was inserted has not been laid out yet, so wait for a real box first.
    if (!(await hasSize(el))) {
      mountError.value = t("sheet.noRoom");
      return;
    }

    const [{ createUniver, LocaleType, merge }, sheetsCore, enUS] = await Promise.all([
      import("@univerjs/presets"),
      import("@univerjs/preset-sheets-core"),
      import("@univerjs/preset-sheets-core/locales/en-US"),
    ]);
    await import("@univerjs/preset-sheets-core/lib/index.css");

    const { univerAPI, univer } = createUniver({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: merge({}, (enUS as { default?: unknown }).default ?? enUS) },
      // Univer's own dark theme for the chrome and the grid's DEFAULT surfaces.
      // Explicit cell fills come from the snapshot and stay exactly as saved.
      darkMode: isDark(),
      presets: [sheetsCore.UniverSheetsCorePreset({ container: el })],
    });

    univerAPI.createWorkbook(snapshot as never);
    api.value = univerAPI as never;
    disposeUniver = () => univer.dispose();

    // The theme is not a mount-time constant. Tabs stay alive, so a grid
    // mounted in dark mode was still dark after the user switched to light —
    // Univer only ever heard the value it was constructed with.
    stopDarkWatch = watchDark((on) => {
      try {
        (univerAPI as { toggleDarkMode?(v: boolean): void }).toggleDarkMode?.(on);
      } catch {
        /* an older Univer without the facade method: leave the theme alone */
      }
    });

    // Univer has no single "changed" event we can trust across versions, so the
    // dirty flag is polled against the snapshot. Cheap next to a grid redraw,
    // and it cannot miss an edit route we did not think of.
    poll = window.setInterval(() => {
      if (!api.value) return;
      setDirty(currentText() !== savedContent);
    }, 1000);

    baseline();
  } catch (err) {
    mountError.value = (err as Error)?.message ?? String(err);
  }
}

let poll = 0;

/** Resolve once the element has a non-zero box, or give up. Bounded because a
 *  tab the user never opens must not spin frames forever. */
function hasSize(el: HTMLElement, tries = 60): Promise<boolean> {
  return new Promise((resolve) => {
    const check = (left: number) => {
      if (el.clientWidth > 0 && el.clientHeight > 0) return resolve(true);
      if (left <= 0) return resolve(false);
      requestAnimationFrame(() => check(left - 1));
    };
    check(tries);
  });
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
}

onMounted(() => {
  void mountUniver();
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  if (poll) window.clearInterval(poll);
  stopDarkWatch?.();
  try {
    disposeUniver?.();
  } catch {
    /* a grid that will not dispose must not block closing the file */
  }
  api.value = null;
});

// Save As renames the file; the buffer is unchanged, so do NOT reload the grid.
watch(() => props.path, () => undefined);

defineExpose({
  markSaved() {
    savedContent = currentText();
    setDirty(false);
  },
  getContent(): string {
    return currentText();
  },
  isDirty(): boolean {
    return dirty.value;
  },
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <p v-if="error" class="border-b border-current/10 px-3 py-2 text-xs text-warn-dark">
      {{ error }}
    </p>

    <div v-if="notSheet" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <font-awesome-icon icon="triangle-exclamation" class="text-3xl text-warn-dark" />
      <p class="text-sm font-semibold">{{ t("sheet.notASheet") }}</p>
      <p class="max-w-md text-sm opacity-70">{{ t("sheet.notASheetBody") }}</p>
      <OyaButton variant="secondary" data-testid="sheet-open-text" @click="emit('open-as-text')">
        {{ t("file.openAsText") }}
      </OyaButton>
    </div>

    <div v-else-if="mountError" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <font-awesome-icon icon="triangle-exclamation" class="text-3xl text-warn-dark" />
      <p class="text-sm font-semibold">{{ t("sheet.gridFailed") }}</p>
      <p class="max-w-md font-mono text-xs opacity-70" data-testid="sheet-mount-error">{{ mountError }}</p>
      <OyaButton variant="secondary" @click="emit('open-as-text')">
        {{ t("file.openAsText") }}
      </OyaButton>
    </div>

    <!-- Univer mounts here and sizes itself to this box. -->
    <div v-show="!notSheet && !mountError" ref="host" class="min-h-0 w-full flex-1"
         data-testid="univer-host" />
  </div>
</template>
