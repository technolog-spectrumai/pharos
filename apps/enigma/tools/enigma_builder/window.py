"""Main window: header, theme toggle, tab assembly, and the shared refresh.

One ConfigModel is created here and handed to every tab, and every tab is
refreshed from the model's ``changed`` signal — so editing a gate on Features
updates the Expert preview and the Build tab's validation banner in the same
pass, with no tab owning a private copy of the config.
"""

from __future__ import annotations

from string import Template

from pathlib import Path

from PyQt6.QtCore import QSettings, Qt
from PyQt6.QtGui import QCloseEvent, QFont
from PyQt6.QtWidgets import (
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

import identity as identity_mod
import paths
from build_tab import BuildTab
from config_model import ConfigModel
from expert_tab import ExpertTab
from features_tab import FeaturesTab
from identity_tab import IdentityTab
from theme import (
    QSS_TEMPLATE,
    SETTINGS_THEME_KEY,
    THEMES,
    build_palette,
    detect_system_theme,
)
from validation import errors as error_issues

TAB_TITLES = ("Features", "Identity", "Expert", "Build")

SETTINGS_REPO_KEY = "repo/root"
SETTINGS_OUTPUT_KEY = "build/output_dir"


class MainWindow(QMainWindow):
    """One window class, three launch modes.

    - "full"   — the classic combined tool (bare `enigma-builder`).
    - "config" — the Config Builder: define the product, save a deterministic
      product-config file for git. No Build tab; it cannot start a build.
    - "build"  — the Builder: consumes one product config read-only and runs
      builds. No editing tabs; identity and gates come from the file.

    The boundary the split enforces: config mode never invokes a build script,
    and build mode never offers an editing surface — product decisions travel
    only through the saved file.
    """

    def __init__(
        self,
        repo_override: Path | None = None,
        mode: str = "config",
        product_file: Path | None = None,
    ) -> None:
        super().__init__()
        self.mode = mode
        self.product_file = product_file
        self._product_dirty = False
        self._loading_product = False
        self.settings = QSettings()
        saved = self.settings.value(SETTINGS_THEME_KEY, "")
        self.theme = saved if saved in THEMES else detect_system_theme()

        self._restore_repo_root(repo_override)

        self.model = ConfigModel(self)
        self._seed_identity_from_conf()

        self.setWindowTitle(paths.APP_NAME)
        self.setMinimumSize(860, 700)
        self.resize(1020, 940)

        self._build_ui()
        self._apply_theme(self.theme)
        self.theme_button.clicked.connect(self._toggle_theme)
        self.model.changed.connect(self._on_model_changed)
        self.build_tab.repo_root_changed.connect(self.set_repo_root)
        self.build_tab.output_dir_changed.connect(
            lambda path: self.settings.setValue(SETTINGS_OUTPUT_KEY, path)
        )
        self.build_tab.set_output_dir(
            str(self.settings.value(SETTINGS_OUTPUT_KEY, "") or "")
            or str(paths.default_output_dir())
        )
        self._on_model_changed()

        if self.mode == "build" and self.product_file is not None:
            if not self.load_product_readonly(self.product_file):
                # The window still opens, showing the error state — closing it
                # from the constructor would strand the caller.
                pass
        if self.mode == "config":
            self.setWindowTitle(f"{paths.APP_NAME} — Config")
            if self.product_file is not None:
                self.load_product(self.product_file)
            self._refresh_product_label()

        if paths.have_repo():
            self._report_missing_files()
        else:
            self._prompt_for_repo()

    # ----- repository ------------------------------------------------------

    def _restore_repo_root(self, override: Path | None) -> None:
        """Choose the checkout: --repo, then the remembered one, then detection.

        A standalone binary has no repo anywhere near it, so the saved choice
        is the only thing that makes the second launch as good as the first.
        """
        if override is not None:
            paths.set_repo_root(override)
            return
        saved = str(self.settings.value(SETTINGS_REPO_KEY, "") or "")
        if saved and paths.is_repo(Path(saved)):
            paths.set_repo_root(Path(saved))

    def set_repo_root(self, root: Path) -> None:
        """Repoint the tool at another checkout and rebuild all tab state."""
        paths.set_repo_root(root)
        self.settings.setValue(SETTINGS_REPO_KEY, str(paths.REPO_ROOT))

        self.model.reload()
        self._seed_identity_from_conf()
        self.identity_tab.reload_repo_identity()
        # An output folder inside the old checkout would silently keep
        # collecting there, so fall back to the new repo's default.
        stored = str(self.settings.value(SETTINGS_OUTPUT_KEY, "") or "")
        if not stored or not Path(stored).is_absolute():
            self.build_tab.set_output_dir(str(paths.default_output_dir()))
        self._on_model_changed()
        self._report_missing_files()

    def _prompt_for_repo(self) -> None:
        """First run of a standalone binary: ask where the checkout is."""
        QMessageBox.information(
            self,
            paths.APP_NAME,
            "No Enigma checkout was found next to this program.\n\nChoose the "
            "repository you want to configure and build — the folder "
            f"containing {paths.MARKER.parts[0]}/.",
        )
        chosen = QFileDialog.getExistingDirectory(
            self, "Choose an Enigma checkout", str(Path.home())
        )
        if chosen and paths.is_repo(Path(chosen)):
            self.set_repo_root(Path(chosen))
        elif chosen:
            QMessageBox.warning(
                self,
                paths.APP_NAME,
                f"{chosen}\n\nis not an Enigma checkout — expected to find\n"
                f"{paths.MARKER} inside it.\n\nYou can set the path on the "
                "Build tab at any time.",
            )

    def _seed_identity_from_conf(self) -> None:
        """tauri.conf.json is authoritative, so the form starts from it.

        Without this a resumed custom config could disagree with the JSON and
        the tool would open showing an equality error nobody introduced.
        """
        conf = identity_mod.read_conf()
        if not conf:
            return
        with self.model.batch():
            for field, value in identity_mod.Identity.from_conf(
                conf
            ).as_app_section().items():
                self.model.set(f"app.{field}", value)

    # ----- construction ---------------------------------------------------

    def _build_ui(self) -> None:
        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(28, 24, 28, 24)
        root_layout.setSpacing(16)

        title = QLabel(paths.APP_NAME)
        title.setObjectName("title")
        title.setFont(QFont(title.font().family(), 21, QFont.Weight.Bold))

        subtitle = QLabel(
            "Choose the features to compile in, write "
            "configs/build_config.custom.yaml, and build the desktop or Android "
            "app with ENIGMA_EDITION=custom."
        )
        subtitle.setObjectName("subtitle")
        subtitle.setWordWrap(True)

        self.theme_button = QPushButton()
        self.theme_button.setObjectName("themeToggle")
        self.theme_button.setFlat(True)
        self.theme_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.theme_button.setFocusPolicy(Qt.FocusPolicy.NoFocus)

        header_row = QHBoxLayout()
        header_row.addWidget(title)
        header_row.addStretch()
        header_row.addWidget(self.theme_button, alignment=Qt.AlignmentFlag.AlignTop)

        root_layout.addLayout(header_row)
        root_layout.addWidget(subtitle)

        self.tabs = QTabWidget()
        self.features_tab = FeaturesTab(self.model)
        self.identity_tab = IdentityTab(self.model)
        self.expert_tab = ExpertTab(self.model)
        self.build_tab = BuildTab(self.model, self.identity_tab)

        if self.mode == "config":
            # No Build tab: this mode's output is a file, never an artifact.
            root_layout.addLayout(self._build_product_bar())
            self.tabs.addTab(self.features_tab, TAB_TITLES[0])
            self.tabs.addTab(self.identity_tab, TAB_TITLES[1])
            self.tabs.addTab(self.expert_tab, TAB_TITLES[2])
            self.build_tab.hide()
        elif self.mode == "build":
            # Only the Build tab: the product is decided; the editing tabs are
            # constructed (BuildTab reads identity through them) but never shown.
            self.tabs.addTab(self.build_tab, "Build")
            for tab in (self.features_tab, self.identity_tab, self.expert_tab):
                tab.hide()
        else:  # pragma: no cover — the combined mode is gone; config is default
            raise ValueError(f"unknown Builder mode {self.mode!r}")

        root_layout.addWidget(self.tabs, 1)
        self.setCentralWidget(root)

    def load_product_readonly(self, path: Path) -> bool:
        """Build mode: consume the config; the editing surface stays hidden."""
        try:
            icon = self.model.load_product(path)
        except (ValueError, OSError) as exc:
            QMessageBox.critical(
                self, paths.APP_NAME,
                f"Cannot load the product config:\n{exc}"
            )
            return False
        if icon and hasattr(self.identity_tab, "icon_edit"):
            self.identity_tab.icon_edit.setText(str(Path(path).parent / icon))
        self.setWindowTitle(f"{paths.APP_NAME} — Build: {Path(path).name}")
        return True

    def _build_product_bar(self):
        """Open / Save / Save As / Build — the Config Builder's file row."""
        from PyQt6.QtWidgets import QHBoxLayout, QPushButton

        row = QHBoxLayout()
        row.setSpacing(8)
        self.product_label = QLabel("(unsaved product config)")
        self.product_label.setObjectName("details")
        row.addWidget(self.product_label, 1)

        open_button = QPushButton("Open…")
        open_button.clicked.connect(self._open_product)
        save_button = QPushButton("Save")
        save_button.clicked.connect(self._save_product)
        save_as_button = QPushButton("Save As…")
        save_as_button.clicked.connect(lambda: self._save_product(ask=True))
        build_button = QPushButton("Build this config…")
        build_button.setObjectName("primaryButton")
        build_button.clicked.connect(self._launch_builder)
        for button in (open_button, save_button, save_as_button, build_button):
            row.addWidget(button)
        return row

    def _refresh_product_label(self) -> None:
        if self.mode != "config":
            return
        name = str(self.product_file) if self.product_file else "(unsaved product config)"
        star = " *" if self._product_dirty else ""
        self.product_label.setText(f"{name}{star}")
        self.setWindowTitle(f"{paths.APP_NAME} — Config{star}")

    def _open_product(self) -> None:
        start = str(self.product_file.parent if self.product_file
                    else paths.CONFIGS_DIR if paths.have_repo() else Path.home())
        chosen, _f = QFileDialog.getOpenFileName(
            self, "Open a product config", start, "Product configs (*.yaml *.yml)"
        )
        if not chosen:
            return
        self.load_product(Path(chosen))

    def load_product(self, path: Path) -> bool:
        self._loading_product = True
        try:
            icon = self.model.load_product(path)
        except (ValueError, OSError) as exc:
            QMessageBox.critical(self, paths.APP_NAME, str(exc))
            return False
        finally:
            self._loading_product = False
        if icon and hasattr(self.identity_tab, "icon_edit"):
            # branding.icon is relative to the product file's directory.
            resolved = (Path(path).parent / icon)
            self.identity_tab.icon_edit.setText(str(resolved))
        self.product_file = Path(path)
        self._product_dirty = False
        self._refresh_product_label()
        return True

    def _save_product(self, ask: bool = False) -> Path | None:
        if ask or self.product_file is None:
            start = str(self.product_file or
                        (paths.CONFIGS_DIR / "product.yaml" if paths.have_repo()
                         else Path.home() / "product.yaml"))
            chosen, _f = QFileDialog.getSaveFileName(
                self, "Save the product config", start, "Product configs (*.yaml)"
            )
            if not chosen:
                return None
            self.product_file = Path(chosen)
        icon = self.identity_tab.pending_icon() if hasattr(
            self.identity_tab, "pending_icon") else None
        try:
            saved = self.model.save_product(self.product_file, icon=icon)
        except (ValueError, OSError) as exc:
            QMessageBox.critical(self, paths.APP_NAME, f"Cannot save:\n{exc}")
            return None
        self._product_dirty = False
        self._refresh_product_label()
        return saved

    def _launch_builder(self) -> None:
        """Config mode's one exit into building: through the saved file."""
        saved = self._save_product() if (self._product_dirty or
                                         self.product_file is None) else self.product_file
        if saved is None:
            return
        builder = MainWindow(mode="build", product_file=Path(saved))
        builder.show()
        # Keep a reference or the window is garbage-collected shut.
        self._builder_window = builder

    def _report_missing_files(self) -> None:
        missing = paths.missing_repo_files()
        if not missing:
            return
        QMessageBox.warning(
            self,
            paths.APP_NAME,
            "These repo files are missing, so building will not work:\n\n"
            + "\n".join(f"• {path}" for path in missing)
            + f"\n\nRepo root was resolved as {paths.REPO_ROOT}.",
        )

    # ----- shared refresh -------------------------------------------------

    def _on_model_changed(self) -> None:
        if self.mode == "config" and not self._loading_product:
            self._product_dirty = True
            self._refresh_product_label()
        if not self.model.ready:
            # No readable config: the Build tab explains why and the other tabs
            # have nothing to show, so skip validation rather than flooding
            # every field with "missing".
            if self.mode != "build":
                for index in range(self.tabs.count()):
                    self.tabs.setTabText(index, TAB_TITLES[index])
            self.build_tab.refresh()
            return

        pending = self.identity_tab.pending_identity().as_conf_fields()
        issues = self.model.validate(pending)

        self.features_tab.refresh()
        self.features_tab.set_issues(issues)
        self.identity_tab.refresh()
        self.identity_tab.set_issues(issues)
        self.expert_tab.refresh()
        self.expert_tab.set_issues(issues)
        self.build_tab.refresh()

        self._mark_tabs(issues)

    def _mark_tabs(self, issues) -> None:
        """Flag the tabs holding a blocking error, so nothing hides off-screen."""
        if self.mode == "build":
            # ONE tab; renaming it to "Features" by index is exactly the bug
            # this guard prevents.
            return
        blocking = error_issues(issues)
        owners = {
            0: ("p2p", "dht", "calls", "contacts", "calendar", "maps", "features"),
            1: ("app",),
            2: ("settings", "network", "crypto"),
        }
        for index, prefixes in owners.items():
            has_error = any(
                issue.path.split(".")[0] in prefixes for issue in blocking
            )
            title = TAB_TITLES[index]
            self.tabs.setTabText(index, f"{title} ⚠" if has_error else title)

    # ----- theme ----------------------------------------------------------

    def _apply_theme(self, name: str) -> None:
        self.theme = name
        tokens = THEMES[name]
        self.setStyleSheet(Template(QSS_TEMPLATE).substitute(tokens))
        app = QApplication.instance()
        if app is not None:
            app.setPalette(build_palette(tokens))
        if name == "dark":
            self.theme_button.setText("☀ Light")
            self.theme_button.setToolTip("Switch to the light theme")
        else:
            self.theme_button.setText("☾ Dark")
            self.theme_button.setToolTip("Switch to the dark theme")

    def _toggle_theme(self) -> None:
        self._apply_theme("light" if self.theme == "dark" else "dark")
        self.settings.setValue(SETTINGS_THEME_KEY, self.theme)

    # ----- lifecycle ------------------------------------------------------

    def closeEvent(self, event: QCloseEvent) -> None:
        if not self.build_tab.is_busy():
            event.accept()
            return

        answer = QMessageBox.question(
            self,
            paths.APP_NAME,
            "A build is still running. Cancel it and close?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer == QMessageBox.StandardButton.No:
            event.ignore()
            return

        # cargo/gradle can take seconds to unwind; close once the worker
        # actually reports it has stopped rather than blocking the GUI thread.
        self.build_tab.cancel_for_close(self.close)
        event.ignore()
