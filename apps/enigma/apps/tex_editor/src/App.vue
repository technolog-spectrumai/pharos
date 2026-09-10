<script setup lang="ts">
// The whole app: connect, pick a workspace, edit, run.
//
// THREE SCREENS AND NO ROUTER. Which one shows is derived from state a person
// can see — are we connected, is a workspace open — rather than from a URL,
// because a desktop window has no address bar and a route would be a second
// place for "where am I" to be recorded and to disagree.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { OyaButton } from "petalite/primitives";
import ConnectView from "./views/ConnectView.vue";
import TreePanel from "./files/TreePanel.vue";
import CodeEditor from "./editors/CodeEditor.vue";
import OutputPanel from "./views/OutputPanel.vue";
import { session, restore, refresh, client, forget } from "./platform/session";
import {
  workspaceState, loadList, open, openFile, edit, save, saveRefusal,
  execute, active, isDirty, canWrite, clearTranscript, poll, isPolling,
} from "./platform/workspace";
import type { Row } from "./files/rows";

const { t } = useI18n({ useScope: "global" });
const failure = ref("");

// Dark mode as a plain ref plus the `.dark` class — the class is what every
// `dark:` utility reacts to. Persisted under this app's OWN key; the initial
// guess follows the OS. Petalite exports `isDark`/`watchDark` for READING the
// class (CodeEditor uses them to pick an ace theme) but nothing that sets it,
// so the switch lives here, as it does in primula.
const dark = ref(
  localStorage.getItem("tex_editor:dark") === null
    ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
    : localStorage.getItem("tex_editor:dark") === "1",
);
watch(dark, (on) => {
  document.documentElement.classList.toggle("dark", on);
  localStorage.setItem("tex_editor:dark", on ? "1" : "0");
}, { immediate: true });

onMounted(async () => {
  restore();
  await refresh();
  if (session.connected) await loadList(client()).catch(() => { /* shown below */ });
});

const buffer = computed(() => active());
const refusal = computed(() => (buffer.value ? saveRefusal(buffer.value) : ""));
const dirty = computed(() => (buffer.value ? isDirty(buffer.value) : false));

async function guarded(work: () => Promise<unknown>) {
  failure.value = "";
  try { await work(); } catch (err) { failure.value = String(err); }
}

const openWorkspace = (slug: string) => guarded(async () => {
  await open(client(), slug);
});

const openRow = (row: Row) => guarded(async () => {
  await openFile(client(), row.id);
});

const saveActive = () => guarded(async () => {
  if (buffer.value) await save(client(), buffer.value.pk);
});

/** Stop the loop when the window goes away, so a closed workspace does not keep
 *  a timer alive against a server nobody is watching. */
let polling: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => { if (polling) clearTimeout(polling); });

/** A COMPILE IS QUEUED, NOT ANSWERED. Unlike a Python run, `execute` hands back
 *  a receipt and the result arrives seconds later, so this starts a loop.
 *
 *  1.5s, and the interval is a judgement rather than a default: a multi-pass
 *  compile of a real document takes tens of seconds, so a tighter loop is
 *  requests nobody reads, and a looser one makes a fast compile feel stuck. */
const POLL_MS = 1500;

async function pump(entryId: number) {
  const again = await poll(client(), entryId);
  if (again) polling = setTimeout(() => void pump(entryId), POLL_MS);
}

const runWorkspace = () => guarded(async () => {
  // A COMPILE READS FROM DISK, so unlike the Python app this saves first —
  // pdflatex opens the file on the server and would otherwise typeset the last
  // saved version while the screen shows something else. Skipped where the
  // buffer cannot be saved at all; a read-only workspace can still be compiled.
  const current = buffer.value;
  if (current && isDirty(current) && !saveRefusal(current)) {
    await save(client(), current.pk);
  }
  const result = await execute(client(), {}, current?.name ?? "");
  // The entry just pushed. Started here rather than inside the store so the
  // store stays free of timers and testable without fake clocks.
  const entry = workspaceState.entries[workspaceState.entries.length - 1];
  if (entry?.runId) void pump(entry.id);
  return result;
});
</script>

<template>
  <div class="flex h-screen flex-col bg-primary-bg-light text-text-main-light
              dark:bg-primary-bg-dark dark:text-text-main-dark">

    <header class="flex items-center gap-3 border-b px-3 py-2">
      <strong class="text-sm">{{ t("app.name") }}</strong>
      <span v-if="workspaceState.current" class="text-sm opacity-70">
        {{ workspaceState.current.name }}
      </span>
      <span v-if="workspaceState.current && !canWrite()"
            class="rounded border px-1.5 py-0.5 text-xs opacity-70" data-testid="readonly-badge">
        {{ t("workspaces.readOnly") }}
      </span>

      <span class="flex-1"></span>

      <template v-if="buffer">
        <OyaButton variant="secondary" data-testid="save"
                   :disabled="Boolean(refusal) || !dirty || workspaceState.busy"
                   :title="refusal || undefined" @click="saveActive">
          {{ dirty ? t("editor.save") : t("editor.saved") }}
        </OyaButton>
        <OyaButton data-testid="run"
                   :disabled="workspaceState.busy || isPolling()
                     || !workspaceState.current?.can_execute"
                   @click="runWorkspace">
          {{ workspaceState.busy || isPolling()
            ? t("editor.running") : t("editor.run") }}
        </OyaButton>
      </template>

      <OyaButton variant="secondary" data-testid="theme" @click="dark = !dark">
        <font-awesome-icon :icon="dark ? 'sun' : 'moon'" />
      </OyaButton>
    </header>

    <!-- A REFUSAL IS ALWAYS A SENTENCE. A disabled Save with no explanation is
         how somebody loses an afternoon working out what is wrong. -->
    <p v-if="refusal" class="border-b bg-amber-500/10 px-3 py-1.5 text-xs"
       data-testid="save-refusal">
      {{ refusal }}
    </p>
    <p v-if="failure || workspaceState.error"
       class="border-b bg-red-500/10 px-3 py-1.5 text-xs" data-testid="failure">
      {{ failure || workspaceState.error }}
    </p>

    <!-- 1. no server -->
    <ConnectView v-if="!session.connected" class="flex-1 overflow-y-auto" />

    <!-- 2. connected, nothing open -->
    <section v-else-if="!workspaceState.current"
             class="flex-1 overflow-y-auto p-6" data-testid="picker">

      <!-- WHO WE ARE, AND HOW TO STOP BEING THEM.
           This lived inside ConnectView until it was noticed that App only
           renders that component when NOT connected — so the whole panel was
           unreachable and there was no way to see the connection or forget the
           token. It belongs here: this is the screen a person is on between
           connecting and opening something. -->
      <section class="mb-5 rounded-xl border p-4" data-testid="connected">
        <p class="font-semibold">
          {{ t("connect.connectedAs", { username: session.username }) }}
        </p>
        <p v-if="session.label" class="text-sm opacity-70">
          {{ t("connect.viaToken", { label: session.label }) }}
        </p>
        <p class="mt-2 text-xs opacity-60">{{ session.server }}</p>
        <!-- A session that will not survive a restart must say so rather than
             look permanent. -->
        <p class="mt-1 text-xs"
           :class="session.storage === 'memory' ? 'text-amber-600' : 'opacity-60'">
          {{ session.storage === "memory"
            ? t("connect.storedInMemory")
            : t("connect.storedInKeyring") }}
        </p>
        <div class="mt-3">
          <OyaButton variant="secondary" data-testid="forget" @click="forget()">
            {{ t("connect.forget") }}
          </OyaButton>
          <p class="mt-1 text-xs opacity-60">{{ t("connect.forgetHint") }}</p>
        </div>
      </section>

      <h2 class="mb-3 text-lg font-bold">{{ t("workspaces.title") }}</h2>
      <p v-if="!workspaceState.list.length" class="opacity-60" data-testid="no-workspaces">
        {{ t("workspaces.empty") }}
      </p>
      <ul class="flex flex-col gap-2">
        <li v-for="ws in workspaceState.list" :key="ws.slug"
            class="flex items-center gap-3 rounded-lg border px-3 py-2">
          <span class="flex-1">{{ ws.name }}</span>
          <span class="text-xs opacity-60">{{ ws.kind }}</span>
          <OyaButton :data-testid="`open-${ws.slug}`" @click="openWorkspace(ws.slug)">
            {{ t("workspaces.open") }}
          </OyaButton>
        </li>
      </ul>
    </section>

    <!-- 3. editing -->
    <main v-else class="flex min-h-0 flex-1">
      <aside class="w-64 shrink-0 overflow-y-auto border-r p-2">
        <TreePanel :items="workspaceState.items" :active-id="workspaceState.activePk"
                   @open="openRow" />
      </aside>

      <section class="flex min-w-0 flex-1 flex-col">
        <div class="min-h-0 flex-1">
          <CodeEditor v-if="buffer" :name="buffer.name" :text="buffer.text"
                      :readonly="Boolean(refusal)"
                      @change="(text: string) => edit(buffer!.pk, text)"
                      @save="saveActive" />
          <p v-else class="p-6 opacity-60" data-testid="no-file">{{ t("editor.noFile") }}</p>
        </div>
        <div class="h-64 shrink-0 border-t">
          <OutputPanel :entries="workspaceState.entries" @clear="clearTranscript" />
        </div>
      </section>
    </main>
  </div>
</template>
