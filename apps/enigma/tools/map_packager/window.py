"""Main application window: header, theme toggle, and the Package tab."""

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

from packager import PackageTab
from theme import (
    QSS_TEMPLATE,
    SETTINGS_THEME_KEY,
    THEMES,
    build_palette,
    detect_system_theme,
)
from utils import APP_NAME


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.settings = QSettings()
        saved = self.settings.value(SETTINGS_THEME_KEY, "")
        self.theme = saved if saved in THEMES else detect_system_theme()

        self.setWindowTitle(APP_NAME)
        self.setMinimumSize(720, 680)
        self.resize(860, 760)

        self._build_ui()
        self._apply_theme(self.theme)
        self.theme_button.clicked.connect(self._toggle_theme)

    def _build_ui(self) -> None:
        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(28, 24, 28, 24)
        root_layout.setSpacing(16)

        title = QLabel(APP_NAME)
        title.setObjectName("title")
        title.setFont(QFont(title.font().family(), 21, QFont.Weight.Bold))

        subtitle = QLabel(
            "Extract offline map regions from a PMTiles archive into "
            "Enigma-ready packages (.pmtiles + .manifest.json). The app itself "
            "never talks to tile servers — this tool does, on your terms."
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
        self.package_tab = PackageTab()
        self.tabs.addTab(self.package_tab, "Package")

        root_layout.addWidget(self.tabs, 1)
        self.setCentralWidget(root)

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

    def closeEvent(self, event: QCloseEvent) -> None:
        if not self.package_tab.is_busy():
            event.accept()
            return
        answer = QMessageBox.question(
            self,
            APP_NAME,
            "A package is still being written. Cancel it and close?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer == QMessageBox.StandardButton.No:
            event.ignore()
            return
        self.package_tab.request_cancel()
        if self.package_tab.worker is not None:
            self.package_tab.worker.wait(5000)
        event.accept()
