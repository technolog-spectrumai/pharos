"""The single source of truth for the config being edited.

Holds one nested dict shaped exactly like ``build_config.yaml`` and emits
``changed`` whenever any leaf moves. Every tab reads and writes through here,
so the YAML preview, the validation banner and the Build tab can never show
three different versions of the same config.

Preset values are read from the checked-in edition files at runtime, never
hardcoded: a comment drifting from a value has happened before in the edition
files, so the files' VALUES are the only
trustworthy source.
"""

from __future__ import annotations

import copy
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import yaml
from PyQt6.QtCore import QObject, pyqtSignal

import paths
import yaml_gen
from validation import (
    FEATURE_GATES,
    RUNTIME_DEFAULTS,
    Issue,
    get_path,
    set_path,
    validate_config,
)

# What a preset defines. Deliberately excludes crypto / settings / network:
# those are byte-identical across all three editions (a Light peer has to share
# rooms with a Pro peer), so applying a preset must not silently undo the
# user's expert edits. Identity is excluded for the same reason.
PRESET_PATHS: tuple[str, ...] = tuple(path for path, _ in FEATURE_GATES) + RUNTIME_DEFAULTS


def load_yaml(path: Path) -> dict[str, Any]:
    """Parse a build config. Returns {} for a missing or unreadable file."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def merge_known(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Overlay only the leaves ``base`` already defines.

    Keeps a stale ``build_config.custom.yaml`` loadable after a schema change:
    unknown keys are dropped and new keys keep their canonical value, so the
    next generation emits a config build.rs will accept.
    """
    merged = copy.deepcopy(base)
    for path in yaml_gen.leaf_paths(base):
        value = get_path(overlay, path)
        if value is not None and type(value) is type(get_path(base, path)):
            set_path(merged, path, value)
    return merged


class ConfigModel(QObject):
    changed = pyqtSignal()

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._depth = 0
        self._dirty = False
        self.canonical: dict[str, Any] = {}
        self._presets: dict[str, dict[str, Any]] = {}
        self._cfg: dict[str, Any] = {}
        self.resumed_from_custom = False
        self.reload()

    def reload(self) -> None:
        """Re-read the configs from the current repo root.

        Called at construction and again whenever the user repoints the tool at
        a different checkout — the model is rebuilt in place so the tabs keep
        their widgets and simply refresh.
        """
        self.canonical = load_yaml(paths.CANONICAL_YAML)
        self._presets = {}

        stored = load_yaml(paths.CUSTOM_YAML)
        self.resumed_from_custom = bool(stored)
        self._cfg = (
            merge_known(self.canonical, stored)
            if stored
            else copy.deepcopy(self.canonical)
        )
        self.changed.emit()

    @property
    def ready(self) -> bool:
        """False when no canonical config could be read — no repo, or a broken one."""
        return bool(self.canonical)

    # ----- reading --------------------------------------------------------

    @property
    def config(self) -> dict[str, Any]:
        """The live config. Treat as read-only; write through ``set``."""
        return self._cfg

    def get(self, path: str) -> Any:
        return get_path(self._cfg, path)

    def canonical_get(self, path: str) -> Any:
        return get_path(self.canonical, path)

    def preset(self, edition: str) -> dict[str, Any]:
        if edition not in self._presets:
            self._presets[edition] = load_yaml(paths.preset_yaml(edition))
        return self._presets[edition]

    # ----- writing --------------------------------------------------------

    @contextmanager
    def batch(self) -> Iterator[None]:
        """Coalesce many writes into one ``changed`` emission."""
        self._depth += 1
        try:
            yield
        finally:
            self._depth -= 1
            if self._depth == 0 and self._dirty:
                self._dirty = False
                self.changed.emit()

    def set(self, path: str, value: Any) -> None:
        if get_path(self._cfg, path) == value:
            return
        set_path(self._cfg, path, value)
        if self._depth:
            self._dirty = True
        else:
            self.changed.emit()

    def reset_to_canonical(self, *prefixes: str) -> None:
        """Restore every leaf under ``prefixes`` to the canonical config."""
        with self.batch():
            for path in yaml_gen.leaf_paths(self.canonical):
                if any(path == p or path.startswith(f"{p}.") for p in prefixes):
                    self.set(path, get_path(self.canonical, path))

    # ----- presets --------------------------------------------------------

    def apply_preset(self, edition: str) -> bool:
        """Copy an edition's feature gates and runtime defaults into the form.

        Returns False when the edition file could not be read, so the caller
        can say so rather than silently doing nothing.
        """
        source = self.preset(edition)
        if not source:
            return False
        with self.batch():
            for path in PRESET_PATHS:
                value = get_path(source, path)
                if value is not None:
                    self.set(path, value)
        return True

    def detect_preset(self) -> str | None:
        """Which edition the current gates match, or None for a custom mix."""
        for edition in paths.PRESETS:
            source = self.preset(edition)
            if not source:
                continue
            if all(
                get_path(source, path) == get_path(self._cfg, path)
                for path in PRESET_PATHS
            ):
                return edition
        return None

    def provenance(self) -> str:
        edition = self.detect_preset()
        return f"{edition} (unmodified gates)" if edition else "custom selection"

    # ----- output ---------------------------------------------------------

    def validate(self, tauri_conf: dict[str, Any] | None = None) -> list[Issue]:
        return validate_config(self._cfg, tauri_conf, self.canonical)

    def render(self) -> str:
        return yaml_gen.render(self._cfg, self.provenance())

    def write_custom_yaml(self) -> Path:
        """Write ``configs/build_config.custom.yaml``. Returns the path."""
        text = self.render()
        paths.CUSTOM_YAML.parent.mkdir(parents=True, exist_ok=True)
        paths.CUSTOM_YAML.write_text(text, encoding="utf-8")
        return paths.CUSTOM_YAML

    # ----- product configs (the Config Builder's saved artefact) ----------
    #
    # A product config IS the build-config YAML — same schema, same renderer,
    # so build.rs and yaml_gen never grow a second dialect — plus, optionally,
    # a Builder-owned `branding:` block that materialisation strips (build.rs
    # parses with deny_unknown_fields, so the block must never reach an
    # ENIGMA_EDITION file). The checked-in presets are product configs with no
    # branding block. Deterministic by construction: yaml_gen renders from a
    # fixed template, so save → load → save is byte-identical and diffs stay
    # meaningful in git.

    PRODUCT_HEADER = "# product-config v1"

    def save_product(self, path: Path, icon: Path | None = None) -> Path:
        """Write the live config (and optional branding) as a product file.

        Refuses a gate set that matches no edition: the product line is the
        three presets, and a fourth ad-hoc feature set is not a product. The
        same refusal guards load_product and (through it) every build.
        """
        if self.detect_preset() is None:
            raise ValueError(
                "this feature set matches no edition — a product config must "
                "carry exactly Basic, Standard or Professional"
            )
        text = f"{self.PRODUCT_HEADER}\n" + self.render()
        if icon is not None:
            text += (
                "\n# ── product-config extras (Builder-owned; stripped from "
                "the build config) ──\n"
                f"branding:\n  icon: {icon}\n"
            )
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def load_product(self, path: Path) -> str | None:
        """Load a product file into the model; returns branding.icon if any.

        Tolerant on purpose: a bare edition YAML (no header, no branding) is a
        valid product config — the presets are exactly that. Unknown keys are
        dropped by merge_known, so a `branding:` block never leaks into the
        build config.
        """
        data = load_yaml(Path(path))
        if not data:
            raise ValueError(f"{path} is not a readable product config")
        with self.batch():
            merged = merge_known(self.canonical, data)
            for key in self._cfg:
                if key in merged:
                    self._cfg[key] = merged[key]
        self.changed.emit()
        if self.detect_preset() is None:
            raise ValueError(
                f"{path} carries a hand-edited feature set that matches no "
                f"edition (Basic / Standard / Professional). Custom feature "
                f"sets are not buildable products — re-save it from the "
                f"Config Builder after picking an edition."
            )
        branding = data.get("branding")
        if isinstance(branding, dict) and branding.get("icon"):
            return str(branding["icon"])
        return None
