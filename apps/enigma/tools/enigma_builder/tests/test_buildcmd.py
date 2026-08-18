"""The unsigned-release escape hatch: argv assembly and the structural
guarantees that keep it from ever becoming a default or changing which key
signs. These tests read the REAL gradle and bash files — the point is that a
future edit to either cannot silently reopen the hole."""

from __future__ import annotations

import pytest

import buildcmd
import paths
import signing

GRADLE = paths.ANDROID_GEN / "app" / "build.gradle.kts"
SCRIPT = paths.REPO_ROOT / "scripts" / "build_android.sh"
PROPERTY = "enigmaAllowUnsignedRelease"


# ----- argv assembly --------------------------------------------------------


def test_the_default_is_a_plain_signed_build():
    command = buildcmd.android("enigma", "release", "aarch64")
    assert command == ["bash", str(paths.BUILD_ANDROID_SH), "enigma", "release", "aarch64"]
    assert "--allow-unsigned-release" not in command


def test_unsigned_is_explicit_and_release_only():
    command = buildcmd.android("enigma", "release", "all", allow_unsigned=True)
    assert command[-1] == "--allow-unsigned-release"
    with pytest.raises(ValueError):
        buildcmd.android("enigma", "debug", "aarch64", allow_unsigned=True)
    with pytest.raises(ValueError):
        buildcmd.android("enigma", "nightly", "aarch64")


def test_the_gui_launches_the_same_argv(app, window):
    """One assembler: the Build tab's android command must be byte-identical
    to what `enigma-builder build android` would run for the same options."""
    tab = window.build_tab
    tab.platform_buttons["android"].setChecked(True)
    tab.release_button.setChecked(True)
    assert tab.command() == buildcmd.android(paths.APP_SLUG, "release", tab.abi_spec)


# ----- the structural guarantees --------------------------------------------


def test_the_property_cannot_reach_the_signing_config():
    """The escape hatch may waive the gate, never choose a key: the property
    name must not appear inside the signingConfigs block, and must appear in
    the whenReady gate."""
    text = GRADLE.read_text(encoding="utf-8")
    signing_block = signing._block(text, "signingConfigs")
    assert signing_block is not None, "signingConfigs block missing entirely"
    assert PROPERTY not in signing_block
    assert PROPERTY in text  # …but the gate does read it


def test_the_debug_key_refusal_survives_the_flag():
    """Inside the gate, the unsigned waiver must exclude the debug-key case —
    the flag waives *unsigned*, never *debug-signed*."""
    text = GRADLE.read_text(encoding="utf-8")
    assert 'problem.contains("DEBUG key")' in text


def test_bash_unsets_the_property_after_sourcing_bashrc():
    """build_android.sh sources ~/.bashrc; a stray export there must never
    disarm the gate. The unset must come after the source and before the
    build. A reorder during a future edit is exactly how the ambient-env hole
    would reopen."""
    text = SCRIPT.read_text(encoding="utf-8")
    source_at = text.index('source "${HOME}/.bashrc"')
    unset_at = text.index(f"unset ORG_GRADLE_PROJECT_{PROPERTY}")
    build_at = text.index("npx tauri android build")
    assert source_at < unset_at < build_at


def test_bash_and_gradle_agree_on_the_property_name():
    bash = SCRIPT.read_text(encoding="utf-8")
    gradle = GRADLE.read_text(encoding="utf-8")
    assert f"ORG_GRADLE_PROJECT_{PROPERTY}=true" in bash
    assert f'findProperty("{PROPERTY}")' in gradle
