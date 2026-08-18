"""Android release signing: the keystore.properties contract and the debug-key guard.

The failure these pin is a quiet one. Before this existed, `tauri android build
--apk` on release produced `app-universal-release-unsigned.apk` — twenty
minutes of Rust for an artifact installable nowhere — and the only clue was the
filename. The second failure is quieter still: signing a release with
`~/.android/debug.keystore` produces an APK that *installs*, so it looks fine,
while being signed by a key whose password is published in the SDK.

`gen/android/app/build.gradle.kts` is the authority; `signing.py` mirrors it.
These tests drive the mirror, and one of them reads the real gradle file so the
mirror cannot drift into describing a file that no longer does any of this.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

import paths
import signing

# Every SDK-generated debug certificate carries this common name; apksigner
# prints the rest of the DN in whatever order it likes.
DEBUG_DN = "C=US, O=Android, CN=Android Debug"

#: Captured at import — before conftest's autouse fixture redirects HOME — so
#: it names the machine's REAL SDK debug keystore. Only ever read, and only to
#: prove that the thing gets refused.
REAL_DEBUG_KEYSTORE = Path(os.path.expanduser("~/.android/debug.keystore"))


# ----- fixtures -------------------------------------------------------------


@pytest.fixture
def gen_android(tmp_path: Path) -> Path:
    """A gen/android tree carrying the repo's real app/build.gradle.kts.

    Copied rather than invented: a test that wrote its own gradle text would
    pass while the shipped file said something else entirely.
    """
    root = tmp_path / "gen" / "android"
    (root / "app").mkdir(parents=True)
    real = paths.ANDROID_GEN / "app" / "build.gradle.kts"
    (root / "app" / "build.gradle.kts").write_text(
        real.read_text(encoding="utf-8"), encoding="utf-8"
    )
    return root


def write_properties(root: Path, **values: str) -> Path:
    path = root / signing.KEYSTORE_PROPERTIES
    path.write_text(
        "\n".join(f"{k}={v}" for k, v in values.items()) + "\n", encoding="utf-8"
    )
    return path


def make_keystore(path: Path, alias: str = "enigma", password: str = "pw12345") -> Path:
    """A real RSA keystore via keytool, or skip — nothing here is faked."""
    keytool = shutil.which("keytool")
    if keytool is None:
        pytest.skip("keytool not on PATH (needs a JDK); cannot make a real keystore")
    subprocess.run(
        [
            keytool, "-genkeypair", "-keystore", str(path),
            "-storepass", password, "-keypass", password,
            "-alias", alias, "-keyalg", "RSA", "-keysize", "2048",
            "-validity", "30", "-dname", "CN=Enigma Release Test, O=Enigma",
        ],
        capture_output=True,
        check=True,
    )
    return path


# ----- missing signing configuration ----------------------------------------


def test_a_tree_with_no_keystore_properties_is_reported(gen_android):
    """The state the repo shipped in: nothing configured, nothing said."""
    status = signing.inspect(gen_android)

    assert not status.configured
    assert not status.signed_release
    assert status.has(signing.NO_PROPERTIES)

    # The error has to be actionable on its own: the file, and the four keys.
    message = status.report()
    assert signing.KEYSTORE_PROPERTIES in message
    assert signing.EXAMPLE_PROPERTIES in message
    for key in signing.REQUIRED_KEYS:
        assert key in message


def test_an_incomplete_properties_file_is_not_good_enough(gen_android, tmp_path):
    """Three of four keys is an unsigned build, not a partially signed one."""
    store = make_keystore(tmp_path / "release.jks")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="pw12345",
        keyAlias="enigma",
        # keyPassword deliberately absent
    )
    status = signing.inspect(gen_android)

    assert status.configured  # the file exists...
    assert not status.signed_release  # ...and still will not sign
    assert status.has(signing.INCOMPLETE)
    assert "keyPassword" in status.report()


def test_a_named_keystore_that_is_not_on_disk_is_reported(gen_android, tmp_path):
    write_properties(
        gen_android,
        storeFile=str(tmp_path / "typo.jks"),
        storePassword="pw12345",
        keyAlias="enigma",
        keyPassword="pw12345",
    )
    status = signing.inspect(gen_android)
    assert status.has(signing.STORE_MISSING)
    assert not status.signed_release


def test_a_regenerated_gradle_file_loses_signing_and_is_caught(gen_android, tmp_path):
    """`tauri android init` overwrites app/build.gradle.kts.

    A perfectly good keystore.properties beside a regenerated gradle file is
    still an unsigned build, and that is exactly the combination nobody checks.
    """
    store = make_keystore(tmp_path / "release.jks")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="pw12345",
        keyAlias="enigma",
        keyPassword="pw12345",
    )
    (gen_android / "app" / "build.gradle.kts").write_text(
        """
        android {
            buildTypes {
                getByName("release") {
                    isMinifyEnabled = true
                }
            }
        }
        """,
        encoding="utf-8",
    )
    status = signing.inspect(gen_android)
    assert status.has(signing.NO_GRADLE_CONFIG)
    assert not status.signed_release


def test_the_repo_gradle_file_wires_release_signing():
    """The shipped file, not a fixture — the mirror must not outlive it."""
    text = (paths.ANDROID_GEN / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    assert signing.check_gradle(text) == []


def test_the_real_filename_stays_gitignored():
    """Credentials must not be committable; the template must be."""
    def ignored(name: str) -> bool:
        result = subprocess.run(
            ["git", "check-ignore", "-q", str(paths.ANDROID_GEN / name)],
            cwd=paths.REPO_ROOT,
            capture_output=True,
        )
        return result.returncode == 0

    if subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=paths.REPO_ROOT,
        capture_output=True,
    ).returncode != 0:
        pytest.skip("not a git checkout; nothing to ask git about")

    assert ignored(signing.KEYSTORE_PROPERTIES)
    assert not ignored(signing.EXAMPLE_PROPERTIES)
    assert (paths.ANDROID_GEN / signing.EXAMPLE_PROPERTIES).is_file()


def test_signing_material_is_ignored_repo_wide():
    """A keystore anywhere in the repo — not just under gen/android — must be
    uncommittable, while the committed fingerprint pin file must not be caught
    by the same patterns (it is deliberately named to dodge them)."""
    def ignored(rel: str) -> bool:
        result = subprocess.run(
            ["git", "check-ignore", "-q", rel],
            cwd=paths.REPO_ROOT,
            capture_output=True,
        )
        return result.returncode == 0

    if subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=paths.REPO_ROOT,
        capture_output=True,
    ).returncode != 0:
        pytest.skip("not a git checkout; nothing to ask git about")

    for rel in (
        "enigma-release.jks",
        "release.keystore",
        "keystore.properties",
        "apps/enigma/keystore.properties",
        "scripts/signing.properties",
    ):
        assert ignored(rel), f"{rel} is committable — root .gitignore regressed"
    assert not ignored("apps/enigma/deploy/android-release-key.properties")


# ----- a well-formed configuration ------------------------------------------


def test_a_complete_properties_file_yields_a_signed_release(gen_android, tmp_path):
    store = make_keystore(tmp_path / "enigma-release.jks", alias="enigma")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="pw12345",
        keyAlias="enigma",
        keyPassword="pw12345",
    )
    status = signing.inspect(gen_android)

    assert status.signed_release
    assert status.problems == ()
    assert status.store_file == store
    assert status.key_alias == "enigma"
    assert "SIGNED release" in status.report()


def test_a_relative_store_path_resolves_against_gen_android(gen_android, tmp_path):
    """Relative to the gen/android root, not to the caller's cwd.

    Same rule as the gradle side's `rootProject.file(...)`, so a build from a
    script and a build from Android Studio read the same file.
    """
    make_keystore(gen_android / "local.jks")
    write_properties(
        gen_android,
        storeFile="local.jks",
        storePassword="pw12345",
        keyAlias="enigma",
        keyPassword="pw12345",
    )
    status = signing.inspect(gen_android)
    assert status.signed_release
    assert status.store_file == gen_android / "local.jks"


def test_comments_and_blank_lines_are_ignored(gen_android, tmp_path):
    store = make_keystore(tmp_path / "release.jks")
    (gen_android / signing.KEYSTORE_PROPERTIES).write_text(
        f"# a comment\n\n! another\nstoreFile={store}\n"
        f"storePassword = pw12345 \nkeyAlias=enigma\nkeyPassword=pw12345\n",
        encoding="utf-8",
    )
    assert signing.inspect(gen_android).signed_release


# ----- the debug key is refused ---------------------------------------------


def test_the_sdk_debug_keystore_is_refused_by_path(gen_android, isolate_app_data):
    """~/.android/debug.keystore, named outright."""
    debug_dir = isolate_app_data / ".android"
    debug_dir.mkdir()
    debug_store = make_keystore(
        debug_dir / "debug.keystore", alias="androiddebugkey", password="android"
    )

    write_properties(
        gen_android,
        storeFile=str(debug_store),
        storePassword="android",
        keyAlias="androiddebugkey",
        keyPassword="android",
    )
    status = signing.inspect(gen_android)

    assert not status.signed_release
    assert status.has(signing.DEBUG_KEY)
    assert "publicly known" in status.report()


def test_a_copy_of_the_debug_keystore_is_refused_too(gen_android, tmp_path):
    """Moved out of ~/.android, it is still the same publicly known key."""
    store = make_keystore(tmp_path / "debug.keystore", alias="mine")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="pw12345",
        keyAlias="mine",
        keyPassword="pw12345",
    )
    assert signing.inspect(gen_android).has(signing.DEBUG_KEY)


def test_the_debug_alias_is_refused_whatever_the_file_is_called(gen_android, tmp_path):
    """Renaming the keystore does not launder the alias inside it."""
    store = make_keystore(tmp_path / "totally-legit.jks", alias="androiddebugkey")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="pw12345",
        keyAlias="androiddebugkey",
        keyPassword="pw12345",
    )
    status = signing.inspect(gen_android)
    assert not status.signed_release
    assert status.has(signing.DEBUG_KEY)


def test_the_gradle_file_carries_the_same_refusal():
    """Python refusing it is worthless if the build itself does not."""
    text = (paths.ANDROID_GEN / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    assert signing.DEBUG_ALIAS in text
    assert signing.DEBUG_KEYSTORE_NAME in text
    assert "releaseSigningProblem" in text
    # The release buildType takes whatever that check produced, and the gate
    # throws when it produced a problem.
    assert 'signingConfig = signingConfigs.findByName("release")' in text
    assert "GradleException" in text


# ----- verifying a real APK -------------------------------------------------


def _apksigner_or_skip() -> Path:
    tool = signing.find_apksigner()
    if tool is None:
        pytest.skip(
            "apksigner not found on PATH or under ANDROID_HOME/ANDROID_SDK_ROOT "
            "build-tools — install the Android build tools to run the signature "
            "verification tests (they are not simulated)"
        )
    return tool


def _fake_apk(path: Path) -> Path:
    """The smallest thing apksigner will treat as an APK: a zip."""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("AndroidManifest.xml", b"placeholder")
        archive.writestr("classes.dex", b"placeholder")
    return path


def test_verification_reports_the_signer_of_a_signed_apk(tmp_path):
    tool = _apksigner_or_skip()
    store = make_keystore(tmp_path / "release.jks", alias="enigma")
    unsigned = _fake_apk(tmp_path / "app-universal-release-unsigned.apk")
    signed = tmp_path / "app-universal-release.apk"

    subprocess.run(
        [
            str(tool), "sign", "--ks", str(store),
            "--ks-pass", "pass:pw12345", "--key-pass", "pass:pw12345",
            "--ks-key-alias", "enigma", "--min-sdk-version", "24",
            "--out", str(signed), str(unsigned),
        ],
        capture_output=True,
        check=True,
    )

    signature = signing.verify_apk(signed, apksigner=tool)
    assert signature.verified
    assert any("CN=Enigma Release Test" in s for s in signature.signers)
    assert not signature.debug_signed


def test_verification_refuses_an_unsigned_apk(tmp_path):
    """The artifact the repo used to produce: apksigner must not bless it."""
    tool = _apksigner_or_skip()
    unsigned = _fake_apk(tmp_path / "app-universal-release-unsigned.apk")

    signature = signing.verify_apk(unsigned, apksigner=tool)
    assert not signature.verified
    assert signature.signers == ()


def test_an_apk_signed_with_the_real_debug_key_is_flagged(tmp_path):
    """The trap, end to end: a debug-signed APK verifies and installs fine.

    Signed here with this machine's actual ~/.android/debug.keystore — the
    exact key that must never reach a release — because a keytool-minted
    imitation would prove nothing about the SDK certificate the check keys on.
    """
    tool = _apksigner_or_skip()
    if not REAL_DEBUG_KEYSTORE.is_file():
        pytest.skip(f"no {REAL_DEBUG_KEYSTORE} on this machine to test against")

    assert signing.is_debug_keystore(REAL_DEBUG_KEYSTORE)

    signed = tmp_path / "app-universal-release.apk"
    subprocess.run(
        [
            str(tool), "sign", "--ks", str(REAL_DEBUG_KEYSTORE),
            "--ks-pass", "pass:android", "--key-pass", "pass:android",
            "--ks-key-alias", signing.DEBUG_ALIAS, "--min-sdk-version", "24",
            "--out", str(signed), str(_fake_apk(tmp_path / "app.apk")),
        ],
        capture_output=True,
        check=True,
    )

    signature = signing.verify_apk(signed, apksigner=tool)
    assert signature.verified  # it verifies, and it would install...
    assert signature.debug_signed  # ...and it is still the SDK's public key
    assert any(DEBUG_DN in s for s in signature.signers)


def test_verification_without_apksigner_raises_rather_than_passing(tmp_path, monkeypatch):
    """"Cannot check" must never read as "signed"."""
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)

    with pytest.raises(FileNotFoundError):
        signing.verify_apk(_fake_apk(tmp_path / "app.apk"))


def test_the_newest_build_tools_win_over_a_release_candidate(tmp_path, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    sdk = tmp_path / "Sdk"
    for version in ("35.0.0", "36.0.0", "36.1.0-rc1"):
        directory = sdk / "build-tools" / version
        directory.mkdir(parents=True)
        tool = directory / "apksigner"
        tool.write_text("#!/bin/sh\n", encoding="utf-8")
        tool.chmod(0o755)

    found = signing.find_apksigner(sdk_root=sdk)
    assert found is not None
    assert found.parent.name == "36.0.0"


# ----- credential precedence (env vars / local config / placeholders) -------


def _complete_env(store: Path) -> dict[str, str]:
    return {
        "ENIGMA_KEYSTORE_FILE": str(store),
        "ENIGMA_KEYSTORE_PASSWORD": "env-store-pass",
        "ENIGMA_KEY_ALIAS": "enigma",
        "ENIGMA_KEY_PASSWORD": "env-key-pass",
    }


def test_env_variables_alone_are_a_complete_configuration(gen_android, tmp_path):
    """No keystore.properties at all — CI's whole setup is four env vars."""
    store = make_keystore(tmp_path / "release.jks")
    status = signing.inspect(
        gen_android, environ=_complete_env(store), local_path=tmp_path / "absent"
    )
    assert status.signed_release, status.report()
    assert dict(status.sources)["storePassword"] == "$ENIGMA_KEYSTORE_PASSWORD"


def test_a_placeholder_redirects_to_its_variable(gen_android, tmp_path):
    store = make_keystore(tmp_path / "release.jks")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="${MY_STORE_SECRET}",
        keyAlias="enigma",
        keyPassword="literal-key-pass",
    )
    environ = {"MY_STORE_SECRET": "from-my-var",
               # The generic var is ALSO set: the placeholder must win.
               "ENIGMA_KEYSTORE_PASSWORD": "should-not-be-used"}
    status = signing.inspect(gen_android, environ=environ, local_path=tmp_path / "absent")
    assert status.signed_release, status.report()
    assert dict(status.sources)["storePassword"] == "$MY_STORE_SECRET (via placeholder)"


def test_an_unset_placeholder_names_the_variable(gen_android, tmp_path):
    store = make_keystore(tmp_path / "release.jks")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="${NOT_EXPORTED}",
        keyAlias="enigma",
        keyPassword="x",
    )
    status = signing.inspect(gen_android, environ={}, local_path=tmp_path / "absent")
    assert status.has(signing.ENV_MISSING)
    assert "$NOT_EXPORTED" in status.report()


def test_env_beats_a_literal_in_the_file(gen_android, tmp_path):
    store = make_keystore(tmp_path / "release.jks")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="stale-literal",
        keyAlias="enigma",
        keyPassword="k",
    )
    creds, problems, _ = signing.resolve_credentials(
        signing.read_properties(gen_android / signing.KEYSTORE_PROPERTIES),
        environ={"ENIGMA_KEYSTORE_PASSWORD": "fresh-from-env"},
        local_path=tmp_path / "absent",
    )
    assert not problems
    assert creds["storePassword"].value == "fresh-from-env"
    assert creds["storePassword"].source == "$ENIGMA_KEYSTORE_PASSWORD"


def test_a_literal_password_earns_a_note_but_still_works(gen_android, tmp_path):
    store = make_keystore(tmp_path / "release.jks")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="pw",
        keyAlias="enigma",
        keyPassword="pw",
    )
    status = signing.inspect(gen_android, environ={}, local_path=tmp_path / "absent")
    assert status.signed_release
    assert any("literal" in n for n in status.notes)


def test_the_local_config_is_the_last_resort(gen_android, tmp_path):
    store = make_keystore(tmp_path / "release.jks")
    local = tmp_path / "signing.properties"
    local.write_text(
        f"storeFile={store}\nstorePassword=pw\nkeyAlias=enigma\nkeyPassword=pw\n",
        encoding="utf-8",
    )
    local.chmod(0o600)
    status = signing.inspect(gen_android, environ={}, local_path=local)
    assert status.signed_release, status.report()
    assert dict(status.sources)["storePassword"] == str(local)


def test_a_lax_local_config_is_refused_with_the_chmod_line(gen_android, tmp_path):
    local = tmp_path / "signing.properties"
    local.write_text("storePassword=pw\n", encoding="utf-8")
    local.chmod(0o644)
    status = signing.inspect(gen_android, environ={}, local_path=local)
    assert status.has(signing.LOCAL_CONFIG_MODE)
    assert f"chmod 600 {local}" in status.report()


def test_a_relative_store_from_the_environment_is_refused(gen_android, tmp_path):
    environ = _complete_env(Path("relative/path.jks"))
    environ["ENIGMA_KEYSTORE_FILE"] = "relative/path.jks"
    status = signing.inspect(gen_android, environ=environ, local_path=tmp_path / "absent")
    assert status.has(signing.RELATIVE_STORE)


def test_the_debug_keystore_via_env_is_still_the_debug_key(gen_android, tmp_path):
    environ = _complete_env(Path.home() / ".android" / "debug.keystore")
    status = signing.inspect(gen_android, environ=environ, local_path=tmp_path / "absent")
    assert status.has(signing.DEBUG_KEY)


def test_no_report_ever_contains_a_secret(gen_android, tmp_path):
    """The one invariant that matters most: values never reach the report."""
    store = make_keystore(tmp_path / "release.jks", password="sekrit-store-pw")
    write_properties(
        gen_android,
        storeFile=str(store),
        storePassword="sekrit-store-pw",
        keyAlias="enigma",
        keyPassword="sekrit-key-pw",
    )
    local = tmp_path / "signing.properties"
    local.write_text("keyPassword=sekrit-local-pw\n", encoding="utf-8")
    local.chmod(0o600)
    status = signing.inspect(
        gen_android,
        environ={"ENIGMA_KEY_PASSWORD": "sekrit-env-pw"},
        local_path=local,
    )
    report = status.report()
    for secret in ("sekrit-store-pw", "sekrit-key-pw", "sekrit-env-pw", "sekrit-local-pw"):
        assert secret not in report
