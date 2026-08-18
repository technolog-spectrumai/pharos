"""Product configs: the Config Builder's saved artefact (B2).

One schema, not two: a product config is the build-config YAML rendered by
yaml_gen, optionally extended with a Builder-owned `branding:` block that must
NEVER reach an ENIGMA_EDITION file (build.rs parses with deny_unknown_fields).
The checked-in presets are product configs with no branding block.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

import paths
from config_model import ConfigModel


def test_save_load_save_is_byte_identical(tmp_path):
    """Deterministic output is what makes the file git-friendly: a reordered
    key would turn every save into a spurious diff."""
    model = ConfigModel()
    model.apply_preset("standard")
    first = model.save_product(tmp_path / "p.yaml", icon=Path("art/icon.png"))
    text1 = first.read_text(encoding="utf-8")

    again = ConfigModel()
    icon = again.load_product(first)
    assert icon == "art/icon.png"
    text2 = again.save_product(tmp_path / "q.yaml", icon=Path(icon)).read_text(
        encoding="utf-8"
    )
    assert text1 == text2


def test_the_header_and_branding_are_present(tmp_path):
    model = ConfigModel()
    saved = model.save_product(tmp_path / "p.yaml", icon=Path("i.png"))
    text = saved.read_text(encoding="utf-8")
    assert text.startswith(ConfigModel.PRODUCT_HEADER)
    assert "branding:" in text and "icon: i.png" in text


def test_branding_never_leaks_into_the_build_config(tmp_path):
    """The materialised custom.yaml must stay build.rs-parseable
    (deny_unknown_fields would fail the whole build on a `branding:` key)."""
    model = ConfigModel()
    saved = model.save_product(tmp_path / "p.yaml", icon=Path("i.png"))

    consumer = ConfigModel()
    consumer.load_product(saved)
    rendered = consumer.render()
    assert "branding" not in rendered
    assert "branding" not in consumer.config


def test_a_bare_edition_yaml_is_a_valid_product_config():
    """The presets ARE product configs — no header, no branding, still load."""
    model = ConfigModel()
    icon = model.load_product(paths.preset_yaml("basic"))
    assert icon is None
    assert model.get("maps.enabled") is False
    assert model.get("contacts.enabled") is True
    assert model.detect_preset() == "basic"


def test_identity_rides_the_product_file(tmp_path):
    model = ConfigModel()
    model.set("app.name", "Acme Secure")
    model.set("app.identifier", "com.acme.secure")
    saved = model.save_product(tmp_path / "acme.yaml")

    other = ConfigModel()
    other.load_product(saved)
    assert other.get("app.name") == "Acme Secure"
    assert other.get("app.identifier") == "com.acme.secure"


def test_an_unreadable_product_config_is_a_loud_error(tmp_path):
    model = ConfigModel()
    with pytest.raises(ValueError):
        model.load_product(tmp_path / "missing.yaml")


def test_the_saved_file_parses_as_plain_yaml(tmp_path):
    """Git tooling, CI, and build.rs-adjacent scripts all read it with a stock
    YAML parser — the branding block must not require anything special."""
    model = ConfigModel()
    saved = model.save_product(tmp_path / "p.yaml", icon=Path("i.png"))
    data = yaml.safe_load(saved.read_text(encoding="utf-8"))
    assert data["branding"]["icon"] == "i.png"
    assert "app" in data and "crypto" in data


def test_a_custom_feature_set_is_refused_at_save(tmp_path):
    """There is no fourth product: a gate set matching no edition cannot be
    saved as a product config."""
    model = ConfigModel()
    model.set("contacts.enabled", False)  # no edition ships without contacts
    with pytest.raises(ValueError, match="matches no edition"):
        model.save_product(tmp_path / "franken.yaml")


def test_a_hand_edited_custom_file_is_refused_at_load(tmp_path):
    """...and one written by hand is refused on the way in — which also makes
    it unbuildable, since productbuild loads through the same gate."""
    model = ConfigModel()
    model.apply_preset("professional")
    text = model.render().replace(
        "  enabled: true", "  enabled: false", 1
    )  # first gate flipped by hand → off every preset
    franken = tmp_path / "franken.yaml"
    franken.write_text(text, encoding="utf-8")
    victim = ConfigModel()
    with pytest.raises(ValueError, match="hand-edited feature set"):
        victim.load_product(franken)
