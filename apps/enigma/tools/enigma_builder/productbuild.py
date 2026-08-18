"""Headless product builds — the Builder half of the split, without a window.

Consumes ONE saved product config and produces the app: materialises
``build_config.custom.yaml``, applies the file's identity to tauri.conf.json
for the duration of the build (snapshot/restore, same contract as the GUI),
runs the repo's own build script, verifies Android signing through
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
        model.load_product(product)
    except (ValueError, OSError) as exc:
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

    # Identity applies for the build only — snapshot the whole file and put it
    # back verbatim, exactly the GUI's contract. The Builder never commits.
    conf_snapshot = identity_mod.read_conf_text()
    identity_changed = identity_mod.write_identity(pending)
    if identity_changed:
        print(f"# tauri.conf.json: identity set to {pending.name} "
              f"/ {pending.identifier} / {pending.version} (restored afterwards)")

    env = os.environ.copy()
    env["ENIGMA_EDITION"] = paths.CUSTOM_EDITION
    command = _command(platform, build_type, abi_spec, allow_unsigned)
    print("$ ENIGMA_EDITION=custom", " ".join(command))
    try:
        result = subprocess.run(command, cwd=paths.REPO_ROOT, env=env)
        code = result.returncode
    finally:
        if identity_changed and conf_snapshot:
            identity_mod.write_conf_text(conf_snapshot)
            print("# tauri.conf.json restored")

    if code != 0:
        return code

    _write_build_info(
        product, model, pending,
        platform=platform, build_type=build_type, allow_unsigned=allow_unsigned,
    )
    return 0


def _write_build_info(product, model, pending, *, platform, build_type,
                      allow_unsigned) -> None:
    """build-info.json: which config produced these artifacts, verifiably."""
    info = {
        "product_config": str(product),
        "product_config_sha256": _sha256(product),
        "provenance": model.provenance(),
        "app": pending.as_conf_fields(),
        "platform": platform,
        "build_type": build_type,
        "unsigned_release_requested": allow_unsigned,
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
