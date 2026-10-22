# Notes tab shell — parked 2026-07-27

`EnigmaNotesView.vue` was the container for the three workspaces that were parked
on the same day: the **Board** (group Kanban), the **Sketch board** and the
**Mind map**. It owned nothing of its own — a sub-tab pill bar, a `?tab=` query
sync, and the full-height frame its children mounted into. With all three
children gone it had nothing left to host, so it is parked here rather than left
in the app as an empty tab.

See the sibling parks for the features themselves:
`../kanban/NOTES.md`, `../sketch/NOTES.md`, `../mind/NOTES.md`.

## What it did

- A pill bar over `ORDER = ["board", "sketch", "mind"]`, each pill hidden by its
  own compile-time build flag (`kanban_enabled` / `sketch_enabled` /
  `mind_enabled`), with `TAB_META` supplying the icon and the `nav.*` label key.
- `?tab=board|sketch|mind` selected a sub-tab, so the legacy per-feature routes
  could redirect into it (`/board` → `/notes?tab=board`, and the same for sketch
  and mind). An unknown or disabled value fell back to the first enabled tab.
- A `watch` on `route.query.tab` re-synced the selection when a nav link changed
  the query while the view was already mounted.
- The frame: `mx-auto flex h-[calc(100vh-8rem)] w-full max-w-7xl flex-1 flex-col
  gap-3`, which is what gave the children their height.

This pill-bar pattern is still live elsewhere — `EnigmaCloudView.vue` and
`EnigmaFilesView.vue` use the same shape, and `EnigmaCloudView` additionally
shows how to hide a pill at runtime rather than at build time.

## As parked

| File | Was |
|---|---|
| `views/EnigmaNotesView.vue` | `apps/enigma/src/views/EnigmaNotesView.vue` |
| `en.nav.snippet` / `pl.nav.snippet` | the `nav.notes` key in `apps/enigma/src/i18n/{en,pl}.ts` |

## Restore checklist

Only worth restoring when **at least two** of the three children come back; for a
single feature, give it its own top-level tab instead (that is what each of them
had before the Notes tab existed, and what the sibling checklists assume).

1. Move `views/EnigmaNotesView.vue` back to `apps/enigma/src/views/`.
2. Restore the children you want first — follow their own NOTES.md — then delete
   from `EnigmaNotesView.vue` the `ORDER` entries, `TAB_META` entries, imports
   and `enabled` record fields of any child that is staying parked.
3. Paste `en.nav.snippet` / `pl.nav.snippet` into the `nav:` block of
   `apps/enigma/src/i18n/en.ts` and `pl.ts`. **Both locales or neither** —
   `tests/unit/i18n.test.ts` compares the two key trees.
4. `apps/enigma/src/router/index.ts`: re-add the route and the legacy redirects,
   using `beforeEnter` (never a top-level `if` — the routes table is evaluated
   before `initBuildConfig()` resolves):
   ```ts
   {
     path: "/notes",
     component: EnigmaNotesView,
     name: "notes",
     beforeEnter: () => {
       const c = getBuildConfig();
       return c.kanban_enabled || c.sketch_enabled || c.mind_enabled || "/chat";
     },
   },
   { path: "/board", redirect: "/notes?tab=board" },
   { path: "/sketch", redirect: "/notes?tab=sketch" },
   { path: "/mind", redirect: "/notes?tab=mind" },
   ```
   Drop whichever flags/redirects belong to still-parked children.
5. `apps/enigma/src/App.vue`: re-add the `notesEnabled` computation beside the
   other feature flags and the two `RouterLink`s (desktop nav ~l.310 and the
   mobile dropdown ~l.410), both `v-if="notesEnabled"` with the `note-sticky`
   icon. Re-add `faNoteSticky` to the import list **and** the `library.add(...)`
   call in `apps/enigma/src/main.ts` — it was removed when the tab left.
6. If the Board comes back, its nav attention dot lived on this link:
   `<span v-if="(kanban?.attentionCount.value ?? 0) > 0" …>` with
   `:title="$t('kanban.attentionTitle')"`.
7. Gates: `npx vue-tsc --noEmit`, `npx vitest run` (app + rakotis),
   `npm run build`, `npx playwright test`.

## Caveats

- Not kept compiling. Its three `import` lines point at paths that no longer
  exist in the app, so it will not typecheck until at least one child is back.
- `tests/e2e/smoke.spec.ts` asserts the exact set of nav links; adding a tab back
  does not break it today, but read it before assuming.
