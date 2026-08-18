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


def verify(
    target: Path,
    build_type: str,
    allow_unsigned: bool,
    pin_file: Path | None = None,
) -> int:
    """Verify one artifact, or every artifact of one build under --gen.

    Exit 0 only when the produced artifacts match what was asked for: a
    signed release for a normal release build, anything for --allow-unsigned
    (still reported honestly), the debug key never accepted for release, and
    — when a pin is recorded — the release fingerprint matching it.
    """
    if target.is_dir():
        outputs = target / "app" / "build" / "outputs"
        artifacts = _artifacts_under(outputs, build_type)
        if not artifacts:
            print(f"ERROR: no {build_type} artifacts under {outputs}", file=sys.stderr)
            return 1
    else:
        artifacts = [target]

    pin = signing.read_pin(pin_file) if pin_file is not None else signing.Pin()
    notices: list[str] = []

    failures = 0
    print("==> Artifact verification")
    for path in artifacts:
        try:
            signature, verdict, info = signing.describe_artifact(path)
        except FileNotFoundError as exc:
            # No verifier is NOT "verified" — a release build must fail here.
            print(f"  UNVERIFIABLE     {path.name}: {exc}", file=sys.stderr)
            failures += 1
            continue
        _print_artifact(path, signature, verdict, info, pin)
        if build_type == "release":
            if verdict == signing.DEBUG:
                failures += 1  # the escape hatch never waives the debug key
            elif verdict != signing.SIGNED_RELEASE and not allow_unsigned:
                failures += 1
            elif verdict == signing.SIGNED_RELEASE and pin_file is not None:
                problem = signing.check_pin(pin, signature.fingerprints)
                if problem is None:
                    pass
                elif problem.code == signing.NO_PIN:
                    if problem.message not in notices:
                        notices.append(problem.message)
                else:
                    print(f"ERROR: {problem.message}", file=sys.stderr)
                    failures += 1

    for notice in notices:
        print(f"NOTICE: {notice}")
    if failures:
        print(f"ERROR: {failures} artifact(s) failed verification", file=sys.stderr)
        return 1
    return 0


def _print_artifact(path, signature, verdict, info, pin) -> None:
    fingerprint = signature.fingerprints[0] if signature.fingerprints else "—"
    signer = signature.signers[0] if signature.signers else "—"
    pin_note = ""
    if verdict == signing.SIGNED_RELEASE and pin.recorded and signature.fingerprints:
        matches = pin.sha256 in signature.fingerprints
        pin_note = "  ✓ matches the pinned release key" if matches \
            else "  ✗ DOES NOT match the pinned release key"
    print(f"  {verdict:17s}{path.name}")
    print(f"      path         {path}")
    if info.package:
        print(f"      package      {info.package}   ({info.source})")
        print(f"      version      {info.version_name}  (versionCode {info.version_code})")
    else:
        print("      package      unknown (no aapt2, no output-metadata.json)")
    print(f"      signer       {signer}")
    print(f"      SHA-256      {fingerprint}{pin_note}")


def pin_action(pin_file: Path, source: Path, rotate: bool, assume_yes: bool) -> int:
    """Record (or rotate) the pinned release fingerprint from an artifact."""
    try:
        signature, verdict, _info = signing.describe_artifact(source)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if verdict != signing.SIGNED_RELEASE or not signature.fingerprints:
        print(f"ERROR: {source.name} is {verdict} — only a signed release "
              f"artifact can define the release identity", file=sys.stderr)
        return 1

    fingerprint = signature.fingerprints[0]
    subject = signature.signers[0] if signature.signers else ""
    current = signing.read_pin(pin_file)

    if current.recorded and signing.normalize_fingerprint(current.sha256) == fingerprint:
        print(f"already pinned: {fingerprint}")
        return 0
    if current.recorded and not rotate:
        print("ERROR: a different fingerprint is already pinned "
              f"({current.sha256}).\nRotating the release key STRANDS every "
              "existing install. If that is understood and deliberate, "
              "re-run with --rotate.", file=sys.stderr)
        return 1
    if current.recorded and rotate and not assume_yes:
        answer = input(
            "Rotate the pinned release key? Existing installs will NOT accept "
            "updates signed with the new key. Type 'yes' to proceed: "
        )
        if answer.strip().lower() != "yes":
            print("aborted")
            return 1

    signing.write_pin(
        pin_file, fingerprint, alias="", subject=subject,
        rotated_from=current.sha256 if current.recorded else "",
    )
    print(f"pinned: {fingerprint}")
    print(f"  in {pin_file}")
    print("  commit this file — it is public information and the build "
          "refuses a mismatched key from now on.")
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
    verify_p.add_argument(
        "--pin", metavar="FILE",
        help="release-key pin file; a signed release must match it",
    )

    pin_p = sub.add_parser("pin", help="record the release-key fingerprint")
    pin_p.add_argument("--pin-file", metavar="FILE", required=True)
    pin_p.add_argument("--from", dest="source", metavar="ARTIFACT", required=True,
                       help="a signed release APK/AAB to read the fingerprint from")
    pin_p.add_argument("--rotate", action="store_true",
                       help="replace an existing, different pin (dangerous)")
    pin_p.add_argument("--yes", action="store_true",
                       help="skip the interactive rotation confirmation")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse(argv if argv is not None else sys.argv[1:])
    if args.action == "status":
        return status(Path(args.gen).expanduser())
    if args.action == "verify":
        target = Path(args.gen).expanduser() if args.gen else Path(args.artifact).expanduser()
        pin_file = Path(args.pin).expanduser() if args.pin else None
        return verify(target, args.build_type, args.allow_unsigned, pin_file)
    if args.action == "pin":
        return pin_action(
            Path(args.pin_file).expanduser(), Path(args.source).expanduser(),
            args.rotate, args.yes,
        )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
