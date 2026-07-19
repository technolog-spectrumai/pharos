"""The Package tab: source → area → zooms → one .pmtiles + .manifest.json.

Workers follow the video_tools DownloadThread pattern: QThread subclasses with
pyqtSignals; extraction cancels through a threading.Event checked per tile.
The produced package is exactly what the Enigma app's Maps → Regions → Import
verifies (BLAKE3 + manifest sidecar, auto-detected by filename).
"""
from __future__ import annotations

import threading
from pathlib import Path

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from geocode import DEFAULT_ENDPOINT, TownHit, search_town
from manifest import build_manifest, write_sidecar
from pm_source import CachingSource, ExtractCancelled, HttpRangeSource, extract, source_info
from tile_math import bbox_tile_count, validate_bbox
from utils import human_bytes, safe_filename

# Soft ceiling for one package — mirrors the spirit of the app's old in-app cap
# and keeps accidental "download the planet at z14" runs from starting.
TILE_SOFT_CAP = 200_000

WORLD_PRESET = ((-180.0, -85.0, 180.0, 85.0), 0, 5)


class SourceInfoWorker(QThread):
    """Fetch the remote archive's header (a few range requests)."""

    info_ready = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(self, url: str) -> None:
        super().__init__()
        self.url = url

    def run(self) -> None:
        try:
            src = HttpRangeSource(self.url)
            try:
                self.info_ready.emit(source_info(src))
            finally:
                src.close()
        except Exception as exc:  # noqa: BLE001 — surfaced verbatim in the UI
            self.failed.emit(str(exc))


class LookupWorker(QThread):
    """One Nominatim query off the UI thread."""

    results_ready = pyqtSignal(list)
    failed = pyqtSignal(str)

    def __init__(self, query: str, endpoint: str) -> None:
        super().__init__()
        self.query = query
        self.endpoint = endpoint

    def run(self) -> None:
        try:
            self.results_ready.emit(search_town(self.query, endpoint=self.endpoint))
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))


class PackageWorker(QThread):
    """Extract bbox/zooms from the source and write the verified package."""

    progress_changed = pyqtSignal(int, int)
    status_changed = pyqtSignal(str)
    finished_ok = pyqtSignal(str, str, dict)
    failed = pyqtSignal(str)
    cancelled = pyqtSignal()

    def __init__(
        self,
        url: str,
        out_dir: Path,
        name: str,
        bbox: tuple[float, float, float, float],
        min_zoom: int,
        max_zoom: int,
    ) -> None:
        super().__init__()
        self.url = url
        self.out_dir = out_dir
        self.name = name
        self.bbox = bbox
        self.min_zoom = min_zoom
        self.max_zoom = max_zoom
        self.cancel_event = threading.Event()

    def request_cancel(self) -> None:
        self.cancel_event.set()

    def run(self) -> None:
        archive = self.out_dir / f"{safe_filename(self.name)}.pmtiles"
        http = HttpRangeSource(self.url)
        source = CachingSource(http)
        try:
            self.status_changed.emit("Extracting tiles…")
            stats = extract(
                source,
                archive,
                self.bbox,
                self.min_zoom,
                self.max_zoom,
                progress=self._on_progress,
                cancel=self.cancel_event,
                metadata_name=self.name,
            )
            self.status_changed.emit("Hashing + writing manifest…")
            manifest = build_manifest(
                archive, self.name, self.bbox, self.min_zoom, self.max_zoom, self.url
            )
            sidecar = write_sidecar(archive, manifest)
            self.finished_ok.emit(str(archive), str(sidecar), stats)
        except ExtractCancelled:
            archive.unlink(missing_ok=True)
            self.cancelled.emit()
        except Exception as exc:  # noqa: BLE001
            archive.unlink(missing_ok=True)
            self.failed.emit(str(exc))
        finally:
            http.close()

    def _on_progress(self, done: int, total: int) -> None:
        # ~1% granularity keeps the signal queue tiny on 100k-tile runs.
        if done == total or done % max(1, total // 100) == 0:
            self.progress_changed.emit(done, total)


class PackageTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.worker: PackageWorker | None = None
        self.info_worker: SourceInfoWorker | None = None
        self.lookup_worker: LookupWorker | None = None
        self.source_zoom_range: tuple[int, int] | None = None
        self._build_ui()
        self._refresh_estimate()

    # ── UI assembly ──────────────────────────────────────────────────────────
    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 16, 0, 0)
        layout.setSpacing(14)

        card = QFrame()
        card.setObjectName("card")
        form = QGridLayout(card)
        form.setContentsMargins(20, 18, 20, 18)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(10)

        # Source archive.
        self.url_edit = QLineEdit()
        self.url_edit.setPlaceholderText("https://example.org/planet.pmtiles — the .pmtiles archive to extract from")
        self.check_button = QPushButton("Check source")
        self.source_label = QLabel("Source not checked yet — Check fetches only the header (a few KB).")
        self.source_label.setObjectName("details")
        self.source_label.setWordWrap(True)
        form.addWidget(QLabel("Source URL"), 0, 0)
        form.addWidget(self.url_edit, 0, 1, 1, 3)
        form.addWidget(self.check_button, 0, 4)
        form.addWidget(self.source_label, 1, 1, 1, 4)

        # Town lookup (optional, explicit).
        self.town_edit = QLineEdit()
        self.town_edit.setPlaceholderText("Town or area name (optional — fills the box below)")
        self.lookup_button = QPushButton("Look up")
        self.results_combo = QComboBox()
        self.results_combo.setVisible(False)
        form.addWidget(QLabel("Find area"), 2, 0)
        form.addWidget(self.town_edit, 2, 1, 1, 3)
        form.addWidget(self.lookup_button, 2, 4)
        form.addWidget(self.results_combo, 3, 1, 1, 4)

        # bbox W/S/E/N.
        def coord(minimum: float, maximum: float, value: float) -> QDoubleSpinBox:
            box = QDoubleSpinBox()
            box.setRange(minimum, maximum)
            box.setDecimals(4)
            box.setValue(value)
            box.setSingleStep(0.05)
            return box

        self.west = coord(-180.0, 180.0, 16.80)
        self.south = coord(-90.0, 90.0, 52.30)
        self.east = coord(-180.0, 180.0, 17.10)
        self.north = coord(-90.0, 90.0, 52.50)
        bbox_row = QHBoxLayout()
        for label, box in (("W", self.west), ("S", self.south), ("E", self.east), ("N", self.north)):
            bbox_row.addWidget(QLabel(label))
            bbox_row.addWidget(box, 1)
        form.addWidget(QLabel("Area (degrees)"), 4, 0)
        form.addLayout(bbox_row, 4, 1, 1, 4)

        # Zoom range + estimate.
        self.zoom_min = QSpinBox(); self.zoom_min.setRange(0, 22); self.zoom_min.setValue(0)
        self.zoom_max = QSpinBox(); self.zoom_max.setRange(0, 22); self.zoom_max.setValue(12)
        self.estimate_label = QLabel("")
        self.estimate_label.setObjectName("details")
        zoom_row = QHBoxLayout()
        zoom_row.addWidget(QLabel("min"))
        zoom_row.addWidget(self.zoom_min)
        zoom_row.addWidget(QLabel("max"))
        zoom_row.addWidget(self.zoom_max)
        zoom_row.addWidget(self.estimate_label, 1)
        form.addWidget(QLabel("Zoom levels"), 5, 0)
        form.addLayout(zoom_row, 5, 1, 1, 4)

        # Name + output dir + world preset.
        self.name_edit = QLineEdit()
        self.name_edit.setPlaceholderText("Region name shown in the app (e.g. Poznań centrum)")
        self.out_edit = QLineEdit(str(Path.home() / "Documents"))
        self.browse_button = QPushButton("Browse…")
        self.world_button = QPushButton("Coarse world (z0–5) preset")
        form.addWidget(QLabel("Name"), 6, 0)
        form.addWidget(self.name_edit, 6, 1, 1, 4)
        form.addWidget(QLabel("Output folder"), 7, 0)
        form.addWidget(self.out_edit, 7, 1, 1, 3)
        form.addWidget(self.browse_button, 7, 4)
        form.addWidget(self.world_button, 8, 1, 1, 2)

        layout.addWidget(card)

        # Nominatim endpoint (self-hosting friendly).
        endpoint_row = QHBoxLayout()
        endpoint_label = QLabel("Lookup endpoint")
        endpoint_label.setObjectName("details")
        self.endpoint_edit = QLineEdit(DEFAULT_ENDPOINT)
        endpoint_row.addWidget(endpoint_label)
        endpoint_row.addWidget(self.endpoint_edit, 1)
        layout.addLayout(endpoint_row)

        # Action row + progress + log.
        self.package_button = QPushButton("Package region")
        self.package_button.setObjectName("primaryButton")
        self.cancel_button = QPushButton("Cancel")
        self.cancel_button.setObjectName("secondaryButton")
        self.cancel_button.setEnabled(False)
        action_row = QHBoxLayout()
        action_row.addWidget(self.package_button)
        action_row.addWidget(self.cancel_button)
        action_row.addStretch()
        layout.addLayout(action_row)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.status_label = QLabel("Idle.")
        self.status_label.setObjectName("status")
        layout.addWidget(self.progress)
        layout.addWidget(self.status_label)

        self.log = QPlainTextEdit()
        self.log.setObjectName("log")
        self.log.setReadOnly(True)
        layout.addWidget(self.log, 1)

        # Wiring.
        self.check_button.clicked.connect(self._check_source)
        self.lookup_button.clicked.connect(self._lookup_town)
        self.town_edit.returnPressed.connect(self._lookup_town)
        self.results_combo.activated.connect(self._apply_hit)
        self.world_button.clicked.connect(self._apply_world_preset)
        self.browse_button.clicked.connect(self._pick_out_dir)
        self.package_button.clicked.connect(self._start_package)
        self.cancel_button.clicked.connect(self.request_cancel)
        for box in (self.west, self.south, self.east, self.north):
            box.valueChanged.connect(self._refresh_estimate)
        self.zoom_min.valueChanged.connect(self._refresh_estimate)
        self.zoom_max.valueChanged.connect(self._refresh_estimate)

    # ── helpers ──────────────────────────────────────────────────────────────
    def is_busy(self) -> bool:
        return self.worker is not None and self.worker.isRunning()

    def request_cancel(self) -> None:
        if self.worker is not None:
            self.worker.request_cancel()
            self.status_label.setText("Cancelling…")

    def _bbox(self) -> tuple[float, float, float, float]:
        return (self.west.value(), self.south.value(), self.east.value(), self.north.value())

    def _append_log(self, line: str) -> None:
        self.log.appendPlainText(line)

    def _refresh_estimate(self) -> None:
        bbox = self._bbox()
        if not validate_bbox(bbox) or self.zoom_min.value() > self.zoom_max.value():
            self.estimate_label.setText("Invalid area/zoom range (needs W<E, S<N, min≤max).")
            self.package_button.setEnabled(False)
            return
        tiles = bbox_tile_count(bbox, self.zoom_min.value(), self.zoom_max.value())
        over = tiles > TILE_SOFT_CAP
        self.estimate_label.setText(
            f"≈ {tiles:,} tiles" + (f" — over the {TILE_SOFT_CAP:,} cap; shrink the area or zooms" if over else "")
        )
        self.package_button.setEnabled(not over and not self.is_busy())

    # ── source check ─────────────────────────────────────────────────────────
    def _check_source(self) -> None:
        url = self.url_edit.text().strip()
        if not url.startswith(("http://", "https://")):
            self.source_label.setText("Enter an http(s):// URL of a .pmtiles archive first.")
            return
        self.check_button.setEnabled(False)
        self.info_worker = SourceInfoWorker(url)
        self.info_worker.info_ready.connect(self._on_source_info)
        self.info_worker.failed.connect(self._on_source_failed)
        self.info_worker.finished.connect(lambda: self.check_button.setEnabled(True))
        self.info_worker.start()

    def _on_source_info(self, header: dict) -> None:
        self.source_zoom_range = (header["min_zoom"], header["max_zoom"])
        self.zoom_min.setValue(max(self.zoom_min.value(), header["min_zoom"]))
        self.zoom_max.setValue(min(self.zoom_max.value(), header["max_zoom"]))
        self.source_label.setText(
            f"OK — z{header['min_zoom']}–z{header['max_zoom']}, "
            f"bbox {header['min_lon_e7'] / 1e7:.1f},{header['min_lat_e7'] / 1e7:.1f} → "
            f"{header['max_lon_e7'] / 1e7:.1f},{header['max_lat_e7'] / 1e7:.1f}. "
            "Range requests supported."
        )
        self._append_log(f"Source OK: z{header['min_zoom']}–z{header['max_zoom']}.")

    def _on_source_failed(self, message: str) -> None:
        self.source_zoom_range = None
        self.source_label.setText(f"Source check failed: {message}")

    # ── town lookup ──────────────────────────────────────────────────────────
    def _lookup_town(self) -> None:
        query = self.town_edit.text().strip()
        if not query:
            return
        self.lookup_button.setEnabled(False)
        self.lookup_worker = LookupWorker(query, self.endpoint_edit.text().strip())
        self.lookup_worker.results_ready.connect(self._on_lookup_results)
        self.lookup_worker.failed.connect(
            lambda msg: self._append_log(f"Lookup failed: {msg}")
        )
        self.lookup_worker.finished.connect(lambda: self.lookup_button.setEnabled(True))
        self.lookup_worker.start()

    def _on_lookup_results(self, hits: list) -> None:
        self.results_combo.clear()
        if not hits:
            self._append_log("Lookup: no results.")
            self.results_combo.setVisible(False)
            return
        self._hits: list[TownHit] = hits
        for hit in hits:
            self.results_combo.addItem(hit.display_name)
        self.results_combo.setVisible(True)
        self._apply_hit(0)

    def _apply_hit(self, index: int) -> None:
        hit = self._hits[index]
        west, south, east, north = hit.bbox
        self.west.setValue(west)
        self.south.setValue(south)
        self.east.setValue(east)
        self.north.setValue(north)
        if not self.name_edit.text().strip():
            self.name_edit.setText(hit.display_name.split(",")[0])
        self._append_log(f"Area set from: {hit.display_name}")

    # ── presets / pickers ────────────────────────────────────────────────────
    def _apply_world_preset(self) -> None:
        (west, south, east, north), zmin, zmax = WORLD_PRESET
        self.west.setValue(west); self.south.setValue(south)
        self.east.setValue(east); self.north.setValue(north)
        self.zoom_min.setValue(zmin); self.zoom_max.setValue(zmax)
        if not self.name_edit.text().strip():
            self.name_edit.setText("World overview")

    def _pick_out_dir(self) -> None:
        chosen = QFileDialog.getExistingDirectory(self, "Output folder", self.out_edit.text())
        if chosen:
            self.out_edit.setText(chosen)

    # ── packaging ────────────────────────────────────────────────────────────
    def _start_package(self) -> None:
        url = self.url_edit.text().strip()
        name = self.name_edit.text().strip()
        out_dir = Path(self.out_edit.text().strip()).expanduser()
        bbox = self._bbox()
        if not url.startswith(("http://", "https://")):
            self.status_label.setText("Enter a source URL (and Check it) first.")
            return
        if not name:
            self.status_label.setText("Name the region — the app shows this name.")
            return
        if not out_dir.is_dir():
            self.status_label.setText("Output folder does not exist.")
            return
        if self.source_zoom_range is not None:
            zmin, zmax = self.source_zoom_range
            if self.zoom_min.value() < zmin or self.zoom_max.value() > zmax:
                self.status_label.setText(f"Source only has z{zmin}–z{zmax}.")
                return

        self.progress.setValue(0)
        self.package_button.setEnabled(False)
        self.cancel_button.setEnabled(True)
        self._append_log(f"Packaging '{name}' from {url}")
        self.worker = PackageWorker(
            url, out_dir, name, bbox, self.zoom_min.value(), self.zoom_max.value()
        )
        self.worker.progress_changed.connect(self._on_progress)
        self.worker.status_changed.connect(self.status_label.setText)
        self.worker.finished_ok.connect(self._on_finished)
        self.worker.failed.connect(self._on_failed)
        self.worker.cancelled.connect(self._on_cancelled)
        self.worker.finished.connect(self._on_worker_done)
        self.worker.start()

    def _on_progress(self, done: int, total: int) -> None:
        self.progress.setValue(round(done / total * 100) if total else 0)
        self.status_label.setText(f"Extracting tiles… {done:,} / {total:,}")

    def _on_finished(self, archive: str, sidecar: str, stats: dict) -> None:
        size = Path(archive).stat().st_size
        self.progress.setValue(100)
        self.status_label.setText("Done.")
        self._append_log(
            f"Done: {stats['tiles']:,} tiles ({stats['skipped']:,} empty skipped, "
            f"{stats['requests']:,} range requests), {human_bytes(size)}."
        )
        self._append_log(f"  → {archive}")
        self._append_log(f"  → {sidecar}")
        self._append_log("Copy BOTH files to the device and import the .pmtiles in Enigma → Map → Regions.")

    def _on_failed(self, message: str) -> None:
        self.status_label.setText("Failed.")
        self._append_log(f"Failed: {message}")

    def _on_cancelled(self) -> None:
        self.status_label.setText("Cancelled — partial file removed.")
        self._append_log("Cancelled.")

    def _on_worker_done(self) -> None:
        self.package_button.setEnabled(True)
        self.cancel_button.setEnabled(False)
        self._refresh_estimate()
