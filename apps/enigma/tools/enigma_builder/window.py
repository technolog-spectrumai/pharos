"""Main window: header, theme toggle, tab assembly, and the shared refresh.

One ConfigModel is created here and handed to every tab, and every tab is
refreshed from the model's ``changed`` signal — so editing a gate on Features
updates the Expert preview and the Build tab's validation banner in the same
pass, with no tab owning a private copy of the config.
"""

from __future__ import annotations

from string import Template

from PyQt6.QtCore import QSettings, Qt
from PyQt6.QtGui import QCloseEvent, QFont
from PyQt6.QtWidgets import (
    QApplication,
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


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.settings = QSettings()
        saved = self.settings.value(SETTINGS_THEME_KEY, "")
        self.theme = saved if saved in THEMES else detect_system_theme()

        self.model = ConfigModel(self)
        self._seed_identity_from_conf()

        self.setWindowTitle(paths.APP_NAME)
        self.setMinimumSize(860, 700)
        self.resize(1020, 940)

        self._build_ui()
        self._apply_theme(self.theme)
        self.theme_button.clicked.connect(self._toggle_theme)
        self.model.changed.connect(self._on_model_changed)
        self._on_model_changed()
        self._report_missing_files()

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

        self.tabs.addTab(self.features_tab, TAB_TITLES[0])
        self.tabs.addTab(self.identity_tab, TAB_TITLES[1])
        self.tabs.addTab(self.expert_tab, TAB_TITLES[2])
        self.tabs.addTab(self.build_tab, TAB_TITLES[3])

        root_layout.addWidget(self.tabs, 1)
        self.setCentralWidget(root)

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
        blocking = error_issues(issues)
        owners = {
            0: ("cloud", "p2p", "dht", "calls", "contacts", "calendar", "peers", "maps", "devices", "features"),
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
