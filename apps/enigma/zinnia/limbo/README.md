# zinnia's limbo

Code zinnia used to run and no longer does. It is parked here rather than
deleted, the same way `toto_libs/limbo/` parks library apps no host installs and
`zenobia/limbo/` parks apps zenobia stopped serving — which is what let aurelian
later revive nine ops apps from one of them.

Nothing in here is reachable. `tsconfig.json` includes only `src/**`, vitest
collects only `tests/unit/**` and `tests/component/**`, vite builds only what
`src/main.ts` imports, and cargo compiles only what a `mod` in
`src-tauri/src/lib.rs` names. Delete the whole directory and every build and
every test still passes; that is the property that makes parking cheap.

| Parked | On | Why |
|---|---|---|
| [`cloud`](cloud/LIMBO.md) | 2026-08-25 | Sign-in, the vault browser, and the typed HTTP client under both. Worked and was tested; parked because zinnia is a local-first office suite and the server half was the only thing in it that could not run offline. |

Each parked area carries a `LIMBO.md` saying what it did, what left with it,
what changed elsewhere, and what lifting it back takes — the same convention as
`toto_libs/limbo/` and `zenobia/limbo/`.

## The layout mirrors the repo, on purpose

A parked Django app is one directory and moves as one directory. Zinnia's cloud
was not one directory — it was five, across the frontend, the Rust crate and the
test tree. So `limbo/cloud/` mirrors the repo paths the files came from:

```
limbo/cloud/src/api/…            ← src/api/
limbo/cloud/src/cloud/…          ← src/cloud/
limbo/cloud/src/files/…          ← src/files/
limbo/cloud/src/views/…          ← src/views/
limbo/cloud/src-tauri/src/…      ← src-tauri/src/
limbo/cloud/tests/…              ← tests/
```

Two things follow, and both are deliberate:

* **Files are byte-identical to what was removed.** Reviving is `git mv`, not a
  patch, and a diff against the commit that parked them shows nothing.
* **Relative imports point at where the files are GOING, not where they sit.**
  Inside the mirror most of them already resolve (`../api/vault` from
  `limbo/cloud/src/files/cloudTree.ts` finds its neighbour), but the ones that
  reach out of it — `../../src/i18n` in the parked component test — dangle until
  the move back. That is correct: the paths are the destination's, and nothing
  in limbo is compiled, so a dangling specifier costs nothing.

## Limbo is not an archive

Git already keeps deleted code. What limbo keeps is code that is *expected back*
and whose removal was reversible on purpose: the parking commit lists every edit
made elsewhere, so the revival is a checklist rather than an archaeology
project. Something genuinely finished should be deleted instead.
