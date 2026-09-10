# These icons are PRIMULA'S, copied so the app builds

**Not this app's mark.** `icons.md` at the repo root is explicit that the app
icon is part of the product's identity — "like its name, its bundle id and its
version: one mark, fixed in the repository" — and that it is changed in code by
a person, not generated or picked per build.

Inventing a mark here would ship the wrong brand in a way nothing downstream
catches: the artifact installs and runs perfectly with the wrong face.

## To fix

Put a square master (1024×1024 PNG with alpha, mark inside the middle ~66% so
Android's circle crop does not eat it) at
`tools/enigma_builder/assets/icons/py_editor/{icon.png,source.png,set.json}`,
then regenerate:

    npx tauri icon tools/enigma_builder/assets/icons/py_editor/icon.png \
      -o apps/py_editor/src-tauri/icons

and delete this file. `icons.md` has the full requirements.

Until then Python Editor and Primula are indistinguishable on a launcher.
