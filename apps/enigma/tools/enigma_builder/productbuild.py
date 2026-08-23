"""Headless product builds — the Builder half of the split, without a window.

Consumes ONE saved product config and produces the app: materialises
``build_config.custom.yaml``, applies the fixed identity plus product version
to tauri.conf.json for the duration of the build (snapshot/restore, same
contract as the GUI), runs the repo's own build script, verifies Android signing through
signing_cli, and records ``build-info.json`` beside the artifacts.

The product file is read-only input here: nothing in this module ever writes
back to it. That asymmetry IS the split.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import buildcmd
import icons as icons_mod
import iconsets
import identity as identity_mod
import paths
from config_model import ConfigModel
from validation import errors as error_issues


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _command(platform: str, build_type: str, abi_spec: str,
             allow_unsigned: bool) -> list[str]:
    if platform == "both":
        return ["bash", str(paths.DEPLOY_BUILD_SH), "both", build_type, abi_spec]
    if platform == "desktop":
        command = ["bash", str(paths.BUILD_DESKTOP_SH)]
        if build_type == "debug":
            command.append("--debug")
        return command
    return buildcmd.android(
        paths.APP_SLUG, build_type, abi_spec, allow_unsigned=allow_unsigned
    )


def run(
    product: Path,
    *,
    platform: str = "desktop",
    build_type: str = "release",
    abi_spec: str = "aarch64",
    allow_unsigned: bool = False,
) -> int:
    product = Path(product)
    model = ConfigModel()
    if not model.ready:
        print("no readable build_config.yaml — wrong repo root?", file=sys.stderr)
        return 1
    try:
        icon_value = model.load_product(product)
    except (ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    # branding.icon names a curated set. Resolve it BEFORE any work: a config
    # that asks for an icon this Builder cannot produce must fail loudly, not
    # build the repo's icons under the product's name.
    try:
        icon_source = _resolve_icon(icon_value, base=product.parent)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    pending = identity_mod.Identity(
        name=str(model.get("app.name") or ""),
        identifier=str(model.get("app.identifier") or ""),
        version=str(model.get("app.version") or ""),
    )
    issues = error_issues(model.validate(pending.as_conf_fields()))
    if issues:
        print("the product config is not valid:", file=sys.stderr)
        for issue in issues:
            print(f"  - {issue}", file=sys.stderr)
        return 1

    written = model.write_custom_yaml()
    print(f"# config: {model.provenance()}")
    print(f"# wrote {written}")

    # Fixed identity + product version apply for the build only — snapshot the
    # whole file and put it back verbatim, exactly the GUI's contract.
    conf_snapshot = identity_mod.read_conf_text()
    identity_changed = identity_mod.write_identity(pending)
    if identity_changed:
        print(f"# tauri.conf.json: identity set to {pending.name} "
              f"/ {pending.identifier} / {pending.version} (restored afterwards)")

    env = os.environ.copy()
    env["ENIGMA_EDITION"] = paths.CUSTOM_EDITION
    command = _command(platform, build_type, abi_spec, allow_unsigned)

    icon_snapshot: dict[Path, bytes] = {}
    try:
        if icon_source is not None:
            # Same contract as the GUI: the generated icons are tracked files,
            # so snapshot them and put them back however this run ends.
            icon_snapshot = icons_mod.snapshot()
            print(f"# icon: {icon_source} → {len(icon_snapshot)} generated "
                  f"file(s) will be replaced and restored afterwards")
            print(f"# if this run dies mid-way: {icons_mod.recovery_hint()}")
            icon_command = icons_mod.icon_command(icon_source)
            print("$", " ".join(icon_command))
            generated = subprocess.run(
                icon_command, cwd=paths.APP_DIR, env=os.environ.copy()
            )
            if generated.returncode != 0:
                print("ERROR: generating the icons failed; not building with "
                      "the wrong icon set", file=sys.stderr)
                return generated.returncode
            # `tauri icon` only writes icons/android/; the generated Gradle
            # project keeps its own copy, so mirror it across.
            copied = icons_mod.sync_android_icons()
            if copied:
                print(f"# copied {copied} launcher icon file(s) into "
                      f"src-tauri/gen/android")
            else:
                print("# no src-tauri/gen/android yet — its launcher icons "
                      "will be taken from icons/android at "
                      "`tauri android init`")

        print("$ ENIGMA_EDITION=custom", " ".join(command))
        result = subprocess.run(command, cwd=paths.REPO_ROOT, env=env)
        code = result.returncode
    finally:
        if icon_snapshot:
            restored = icons_mod.restore(icon_snapshot)
            print(f"# restored {restored} icon file(s) to the committed set")
        if identity_changed and conf_snapshot:
            identity_mod.write_conf_text(conf_snapshot)
            print("# tauri.conf.json restored")

    if code != 0:
        return code

    _write_build_info(
        product, model, pending,
        platform=platform, build_type=build_type, allow_unsigned=allow_unsigned,
        icon=icon_value,
    )
    return 0


def _resolve_icon(value: str | None, *, base: Path) -> Path | None:
    """The master image a product config's ``branding.icon`` names.

    None when the config names no icon (the repo's committed icons are used, as
    before). Raises ValueError when it names one that cannot be used — building
    a release branded with the wrong icon, silently, is the failure that would
    actually ship, so this fails closed rather than falling back.
    """
    if not value:
        return None
    chosen = iconsets.resolve(value, base=base)
    if chosen is None:
        offered = ", ".join(s.id for s in iconsets.usable_sets()) or "none"
        raise ValueError(
            f"this product config asks for icon set \u201c{value}\u201d, which this "
            f"Builder does not ship (available: {offered}). Add the set to "
            f"{iconsets.sets_dir()} or re-save the config with one that exists."
        )
    if not chosen.ok:
        raise ValueError(
            f"icon set \u201c{chosen.id}\u201d is present but unusable: "
            + "; ".join(chosen.problems)
        )
    return chosen.master


def _write_build_info(product, model, pending, *, platform, build_type,
                      allow_unsigned, icon=None) -> None:
    """build-info.json: which config produced these artifacts, verifiably."""
    info = {
        "product_config": str(product),
        "product_config_sha256": _sha256(product),
        "provenance": model.provenance(),
        "app": pending.as_conf_fields(),
        "platform": platform,
        "build_type": build_type,
        "unsigned_release_requested": allow_unsigned,
        # Which curated set branded these artifacts; null means the repo's
        # committed icons were used untouched.
        "icon_set": icon or None,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    # Android release: record what actually got signed, from the artifacts.
    if platform in ("android", "both") and build_type == "release":
        import signing

        artifacts = []
        outputs = paths.ANDROID_OUTPUTS
        for pattern in ("apk/universal/release/*.apk", "bundle/universalRelease/*.aab"):
            for path in sorted(outputs.glob(pattern)):
                try:
                    signature, verdict, _meta = signing.describe_artifact(path)
                except FileNotFoundError:
                    verdict, signature = "UNVERIFIABLE", None
                artifacts.append({
                    "file": path.name,
                    "classification": verdict,
                    "sha256_fingerprints": list(signature.fingerprints) if signature else [],
                })
        info["android_signing"] = artifacts

    target = paths.DEPLOY_DIST / "build-info.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(f"# wrote {target}")
