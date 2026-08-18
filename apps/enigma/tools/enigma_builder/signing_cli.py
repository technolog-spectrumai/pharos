#!/usr/bin/env python3
"""Headless Android-signing commands — the CLI half of signing.py.

Two ways in, by design:

- ``enigma-builder signing android <action>`` — main.py resolves the repository
  (with the remembered QSettings choice available) and calls the functions here
  with the resolved gen/android directory.
- ``python3 signing_cli.py <action> --gen DIR`` — no Qt, no venv, stdlib only.
  This is what scripts/build_android.sh calls, so a release build's signing
  checks cannot depend on the GUI's environment.

Everything here prints to stdout and returns an exit code; nothing imports
PyQt6. Keeping this module Qt-free is load-bearing: it must run under the bare
system python3 that a build machine has anyway.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import signing


def status(android_gen: Path) -> int:
    """Print the signing configuration report; 0 when a release would sign."""
    result = signing.inspect(android_gen)
    print(result.report())
    return 0 if result.signed_release else 1


def _artifacts_under(outputs: Path, build_type: str) -> list[Path]:
    """The APKs/AABs one build just produced, newest tree layout assumed."""
    found: list[Path] = []
    for pattern in ("*.apk", "*.aab"):
        for path in sorted(outputs.rglob(pattern)):
            # gen/android keeps both variants' outputs; only report the one
            # that was just built.
            if build_type in str(path.parent).lower() or (
                build_type == "release" and "universalRelease" in str(path)
            ):
                found.append(path)
    return found


def report_artifact(path: Path) -> tuple[str, bool]:
    """Print the full identity block for one artifact; returns (class, ok)."""
    signature, verdict, info = signing.describe_artifact(path)
    fingerprint = signature.fingerprints[0] if signature.fingerprints else "—"
    signer = signature.signers[0] if signature.signers else "—"
    print(f"  {verdict:17s}{path.name}")
    print(f"      path         {path}")
    if info.package:
        print(f"      package      {info.package}           ({info.source})")
        print(f"      version      {info.version_name}  (versionCode {info.version_code})")
    else:
        print("      package      unknown (no aapt2, no output-metadata.json)")
    print(f"      signer       {signer}")
    print(f"      SHA-256      {fingerprint}")
    return verdict, signature.verified and not signature.debug_signed


def verify(target: Path, build_type: str, allow_unsigned: bool) -> int:
    """Verify one artifact, or every artifact of one build under --gen.

    Exit 0 only when the produced artifacts match what was asked for: a
    signed release for a normal release build, anything for --allow-unsigned
    (still reported honestly), and the debug key never accepted for release.
    """
    if target.is_dir():
        outputs = target / "app" / "build" / "outputs"
        artifacts = _artifacts_under(outputs, build_type)
        if not artifacts:
            print(f"ERROR: no {build_type} artifacts under {outputs}", file=sys.stderr)
            return 1
    else:
        artifacts = [target]

    failures = 0
    print("==> Artifact verification")
    for path in artifacts:
        try:
            verdict, ok = report_artifact(path)
        except FileNotFoundError as exc:
            # No verifier is NOT "verified" — a release build must fail here.
            print(f"  UNVERIFIABLE     {path.name}: {exc}", file=sys.stderr)
            failures += 1
            continue
        if build_type == "release":
            if verdict == signing.DEBUG:
                failures += 1  # the escape hatch never waives the debug key
            elif verdict != signing.SIGNED_RELEASE and not allow_unsigned:
                failures += 1
    if failures:
        print(f"ERROR: {failures} artifact(s) failed verification", file=sys.stderr)
        return 1
    return 0


def _parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="signing_cli.py",
        description="Headless Android signing checks (no Qt).",
    )
    sub = parser.add_subparsers(dest="action", required=True)

    status_p = sub.add_parser("status", help="report the release-signing configuration")
    status_p.add_argument(
        "--gen",
        metavar="DIR",
        required=True,
        help="the generated Android project (…/src-tauri/gen/android)",
    )

    verify_p = sub.add_parser(
        "verify", help="verify built artifacts and print their identity"
    )
    target = verify_p.add_mutually_exclusive_group(required=True)
    target.add_argument("--gen", metavar="DIR", help="verify a build's outputs")
    target.add_argument("artifact", nargs="?", help="one .apk or .aab to verify")
    verify_p.add_argument(
        "--build-type", default="release", choices=("debug", "release")
    )
    verify_p.add_argument(
        "--allow-unsigned", action="store_true",
        help="an unsigned release was explicitly requested; report but do not fail",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse(argv if argv is not None else sys.argv[1:])
    if args.action == "status":
        return status(Path(args.gen).expanduser())
    if args.action == "verify":
        target = Path(args.gen).expanduser() if args.gen else Path(args.artifact).expanduser()
        return verify(target, args.build_type, args.allow_unsigned)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
