"""Android release signing — the ``keystore.properties`` contract, in Python.

``gen/android/app/build.gradle.kts`` is the authority: it loads
``keystore.properties`` from the gen/android root, refuses to produce a release
artifact when that file is missing or incomplete, and refuses outright when the
key it points at is the Android SDK's debug key. This module mirrors those
rules so the Builder (and its test suite) can say *before* a build what a
release would produce, and so the two stay in lockstep — like
:mod:`validation` mirrors ``build.rs``.

Two things make the mirror worth having rather than a duplicate:

- ``tauri android init`` regenerates ``app/build.gradle.kts``. A regenerated
  file silently loses the signing block, and the only symptom is an
  ``-unsigned.apk`` at the end of a twenty-minute build. :func:`inspect` reads
  the gradle file and reports that as a problem in its own right.
- The debug keystore is shipped with the SDK and its password is public
  (``android``/``androiddebugkey``). An APK signed with it is not a release; it
  can never be updated by a real release, and anyone can forge an update for
  it. Both halves — this and the gradle file — refuse it explicitly rather than
  trusting the developer to notice.

Pure functions over paths and strings; no Qt, no gradle invocation.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

#: Read from the gen/android root (``rootProject.file(...)`` in gradle terms).
KEYSTORE_PROPERTIES = "keystore.properties"

#: Checked in beside it; carries the key names and nothing secret.
EXAMPLE_PROPERTIES = "keystore.properties.example"

#: The four keys the gradle signingConfig needs. Order is the documented one.
REQUIRED_KEYS: tuple[str, ...] = (
    "storeFile",
    "storePassword",
    "keyAlias",
    "keyPassword",
)

#: The alias inside the SDK's debug keystore, and the keystore's own filename.
DEBUG_ALIAS = "androiddebugkey"
DEBUG_KEYSTORE_NAME = "debug.keystore"

#: Common name on every SDK-generated debug certificate — how an already-built
#: APK is recognised as debug-signed, whatever the keystore was called.
DEBUG_CN = "CN=Android Debug"

# Problem codes. Stable strings so callers (and tests) can branch on them
# without matching prose.
NO_PROPERTIES = "no-properties"
INCOMPLETE = "incomplete"
STORE_MISSING = "store-missing"
DEBUG_KEY = "debug-key"
NO_GRADLE_CONFIG = "no-gradle-config"

DEBUG_KEY_MESSAGE = (
    "refuses the Android debug key: it ships with the SDK, its password is "
    "publicly known, and an APK signed with it can never be updated by a real "
    "release — anyone can forge an update for it. Generate a release keystore "
    "with keytool and point storeFile at that instead."
)


@dataclass(frozen=True)
class Problem:
    """One reason a release build would not produce a properly signed artifact."""

    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(frozen=True)
class SigningStatus:
    """What a release build of ``android_gen`` would do about signing."""

    android_gen: Path
    properties_file: Path
    problems: tuple[Problem, ...] = ()
    store_file: Path | None = None
    key_alias: str = ""

    @property
    def signed_release(self) -> bool:
        """True when a release build would emit a signed artifact."""
        return not self.problems

    @property
    def configured(self) -> bool:
        """True when a ``keystore.properties`` exists at all."""
        return self.properties_file.is_file()

    def has(self, code: str) -> bool:
        return any(p.code == code for p in self.problems)

    def report(self) -> str:
        """A human-readable summary, for a build log or the GUI."""
        if self.signed_release:
            return (
                f"SIGNED release: {self.store_file}, alias '{self.key_alias}' "
                f"(from {self.properties_file})"
            )
        lines = ["UNSIGNED release — a release build will fail:"]
        lines += [f"  - {p.message}" for p in self.problems]
        return "\n".join(lines)


# ----- keystore.properties --------------------------------------------------


def read_properties(path: Path) -> dict[str, str]:
    """Parse the subset of java.util.Properties gradle actually writes here.

    ``#``/``!`` comments, ``key=value`` or ``key:value``, surrounding
    whitespace stripped. A missing file reads as empty rather than raising:
    "absent" and "empty" are the same failure to the caller.
    """
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return {}

    props: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in "#!":
            continue
        key, sep, value = line.partition("=")
        if not sep:
            key, sep, value = line.partition(":")
        if not sep:
            continue
        props[key.strip()] = value.strip()
    return props


def resolve_store_file(raw: str, base: Path) -> Path:
    """Resolve ``storeFile`` the way the gradle script does.

    ``~`` is expanded, an absolute path is taken as is, and anything else is
    relative to the gen/android root — not to the app module and not to the
    working directory, so the same file works from a script and from the IDE.
    """
    raw = raw.strip()
    expanded = Path(raw).expanduser()
    if expanded.is_absolute():
        return expanded
    return Path(base) / raw


def is_debug_keystore(store: Path) -> bool:
    """True for the SDK's debug keystore, by identity or by name.

    ``~/.android/debug.keystore`` is the one the SDK generates, but a copy
    carried into a repo under the same name is the same publicly known key, so
    the filename is refused too.
    """
    store = Path(store)
    if store.name == DEBUG_KEYSTORE_NAME:
        return True
    default = Path.home() / ".android" / DEBUG_KEYSTORE_NAME
    try:
        return store.resolve() == default.resolve()
    except OSError:
        return False


def check_properties(props: dict[str, str], base: Path) -> list[Problem]:
    """Validate a parsed ``keystore.properties``. Empty list means usable."""
    problems: list[Problem] = []

    missing = [k for k in REQUIRED_KEYS if not props.get(k, "").strip()]
    if missing:
        problems.append(
            Problem(
                INCOMPLETE,
                f"{KEYSTORE_PROPERTIES} is missing "
                f"{', '.join(missing)} — all of "
                f"{', '.join(REQUIRED_KEYS)} are required",
            )
        )

    alias = props.get("keyAlias", "").strip()
    raw_store = props.get("storeFile", "").strip()
    store = resolve_store_file(raw_store, base) if raw_store else None

    if alias == DEBUG_ALIAS or (store is not None and is_debug_keystore(store)):
        problems.append(
            Problem(
                DEBUG_KEY,
                f"{KEYSTORE_PROPERTIES} points at the Android debug key "
                f"(storeFile '{raw_store}', keyAlias '{alias}'). Enigma "
                f"{DEBUG_KEY_MESSAGE}",
            )
        )
        # No point also complaining that the debug keystore is where it is.
        return problems

    if store is not None and not store.is_file():
        problems.append(
            Problem(
                STORE_MISSING,
                f"storeFile '{raw_store}' does not exist (resolved to {store})",
            )
        )

    return problems


# ----- the gradle side ------------------------------------------------------


def _block(text: str, opener: str) -> str | None:
    """The brace-balanced block that follows ``opener``, or None."""
    start = text.find(opener)
    if start < 0:
        return None
    brace = text.find("{", start)
    if brace < 0:
        return None
    depth = 0
    for index in range(brace, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[brace : index + 1]
    return None


def check_gradle(text: str) -> list[Problem]:
    """Validate ``app/build.gradle.kts``'s release signing wiring.

    ``tauri android init`` overwrites this file; when it does, the release
    buildType goes back to having no signingConfig and the build silently
    produces ``app-universal-release-unsigned.apk``. That is the failure this
    catches.
    """
    problems: list[Problem] = []
    release = _block(text, 'getByName("release")')
    if release is None or "signingConfig" not in release:
        problems.append(
            Problem(
                NO_GRADLE_CONFIG,
                "app/build.gradle.kts release buildType has no signingConfig — "
                "the build would emit an unsigned APK. Was gen/android "
                "regenerated by `tauri android init`?",
            )
        )
        return problems

    if KEYSTORE_PROPERTIES not in text:
        problems.append(
            Problem(
                NO_GRADLE_CONFIG,
                f"app/build.gradle.kts never reads {KEYSTORE_PROPERTIES} — "
                f"its signing config comes from somewhere unaudited",
            )
        )
    if DEBUG_ALIAS not in text:
        problems.append(
            Problem(
                NO_GRADLE_CONFIG,
                f"app/build.gradle.kts has no debug-key guard (it never "
                f"mentions '{DEBUG_ALIAS}') — an accidental debug key would "
                f"sign a release",
            )
        )
    return problems


# ----- the whole picture ----------------------------------------------------


def inspect(android_gen: Path) -> SigningStatus:
    """What a release build under ``android_gen`` would do about signing."""
    android_gen = Path(android_gen)
    properties_file = android_gen / KEYSTORE_PROPERTIES
    gradle_file = android_gen / "app" / "build.gradle.kts"

    problems: list[Problem] = []

    if gradle_file.is_file():
        problems += check_gradle(gradle_file.read_text(encoding="utf-8"))
    else:
        problems.append(
            Problem(
                NO_GRADLE_CONFIG,
                f"{gradle_file} does not exist — run `tauri android init` "
                f"first, then restore the signing block",
            )
        )

    props: dict[str, str] = {}
    if properties_file.is_file():
        props = read_properties(properties_file)
        problems += check_properties(props, android_gen)
    else:
        problems.append(
            Problem(
                NO_PROPERTIES,
                f"{properties_file} does not exist. Copy "
                f"{EXAMPLE_PROPERTIES} to {KEYSTORE_PROPERTIES} and fill in "
                f"{', '.join(REQUIRED_KEYS)}. It is gitignored — never commit "
                f"it or the keystore it names.",
            )
        )

    raw_store = props.get("storeFile", "").strip()
    return SigningStatus(
        android_gen=android_gen,
        properties_file=properties_file,
        problems=tuple(problems),
        store_file=resolve_store_file(raw_store, android_gen) if raw_store else None,
        key_alias=props.get("keyAlias", "").strip(),
    )


# ----- verifying what was actually produced ---------------------------------


def _build_tools_key(name: str) -> tuple:
    """Sort key for a build-tools directory.

    Stable releases outrank every pre-release, then newest version wins: an
    SDK carrying both ``36.0.0`` and ``36.1.0-rc1`` should sign with the
    stable one. A pre-release is only picked when it is all there is.
    """
    head, _, suffix = name.partition("-")
    parts = tuple(int(p) if p.isdigit() else 0 for p in head.split("."))
    return (0 if suffix else 1,) + parts


def find_apksigner(sdk_root: Path | None = None) -> Path | None:
    """``apksigner`` from PATH, else the newest build-tools in the SDK.

    Returns None when it is nowhere to be found — callers must treat that as
    "cannot verify", never as "verified".
    """
    on_path = shutil.which("apksigner")
    if on_path:
        return Path(on_path)

    roots: list[Path] = []
    if sdk_root is not None:
        roots.append(Path(sdk_root))
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.environ.get(var, "").strip()
        if value:
            roots.append(Path(value))

    for root in roots:
        build_tools = root / "build-tools"
        if not build_tools.is_dir():
            continue
        for directory in sorted(
            (d for d in build_tools.iterdir() if d.is_dir()),
            key=lambda d: _build_tools_key(d.name),
            reverse=True,
        ):
            candidate = directory / "apksigner"
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return candidate
    return None


@dataclass(frozen=True)
class Signature:
    """What ``apksigner verify`` said about one APK."""

    verified: bool
    signers: tuple[str, ...] = ()
    output: str = ""

    @property
    def debug_signed(self) -> bool:
        """True when a signer is the SDK debug certificate.

        Its common name is fixed — the SDK generates every debug keystore with
        ``CN=Android Debug, O=Android, C=US`` — but the DN's field order in
        apksigner's output is not, so only the CN is matched.
        """
        return any(DEBUG_CN in s for s in self.signers)


_SIGNER_DN = re.compile(r"^Signer #\d+ certificate DN:\s*(.+)$", re.MULTILINE)


def verify_apk(
    apk: Path, apksigner: Path | None = None, min_sdk: int = 24
) -> Signature:
    """Run ``apksigner verify --print-certs`` and report the signer(s).

    Raises FileNotFoundError when apksigner cannot be located — "no verifier"
    must never quietly read as "signed".
    """
    tool = apksigner or find_apksigner()
    if tool is None:
        raise FileNotFoundError(
            "apksigner not found on PATH or under ANDROID_HOME/build-tools"
        )

    result = subprocess.run(
        [
            str(tool),
            "verify",
            "--print-certs",
            "--min-sdk-version",
            str(min_sdk),
            str(apk),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    output = (result.stdout or "") + (result.stderr or "")
    signers = tuple(m.group(1).strip() for m in _SIGNER_DN.finditer(output))
    return Signature(
        verified=result.returncode == 0 and bool(signers),
        signers=signers,
        output=output.strip(),
    )
