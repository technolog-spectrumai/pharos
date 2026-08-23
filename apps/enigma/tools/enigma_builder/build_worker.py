"""Run a build script off the GUI thread and stream its output.

Same shape as the video_tools ffmpeg worker (QThread + pyqtSignals +
threading.Event cancel), with one important difference: these scripts spawn
npm, cargo, gradle and tauri as children, so the process gets its own session
and cancellation signals the whole group. A plain terminate() on the bash
process would leave a multi-gigabyte cargo build running unattended.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from PyQt6.QtCore import QThread, pyqtSignal

# How long the process group gets to exit on SIGTERM before SIGKILL. cargo and
# gradle both need a moment to tear down their own children.
GRACE_SECONDS = 10.0
# Lines of tail kept for the failure dialog.
ERROR_TAIL = 25


class BuildWorker(QThread):
    """Run one command, line-streaming stdout+stderr into the log."""

    status_changed = pyqtSignal(str)
    log_message = pyqtSignal(str)
    job_finished = pyqtSignal()
    job_failed = pyqtSignal(str)
    job_cancelled = pyqtSignal()

    def __init__(
        self,
        *,
        command: list[str],
        cwd: Path,
        env: dict[str, str],
        label: str = "Building",
    ) -> None:
        super().__init__()
        self.command = command
        self.cwd = cwd
        self.env = env
        self.label = label
        self._cancel_event = threading.Event()
        self._process: subprocess.Popen[str] | None = None

    # ----- cancellation ---------------------------------------------------

    def request_cancel(self) -> None:
        self._cancel_event.set()
        self.status_changed.emit("Cancelling…")
        self._signal_group(signal.SIGTERM)
        # Escalate from here rather than from the reader loop: a build that is
        # wedged emits no further lines, so a loop-driven timer would never
        # fire.
        threading.Thread(target=self._kill_group_after_grace, daemon=True).start()

    def _signal_group(self, sig: int) -> None:
        process = self._process
        if process is None or process.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(process.pid), sig)
        except (ProcessLookupError, PermissionError):
            # Already gone, or the group leader died and took the id with it.
            try:
                process.send_signal(sig)
            except (ProcessLookupError, OSError):
                pass

    def _kill_group_after_grace(self) -> None:
        deadline = time.monotonic() + GRACE_SECONDS
        while time.monotonic() < deadline:
            if self._process is None or self._process.poll() is not None:
                return
            time.sleep(0.2)
        self.log_message.emit(
            f"Still running after {GRACE_SECONDS:.0f}s — sending SIGKILL."
        )
        self._signal_group(signal.SIGKILL)

    # ----- run ------------------------------------------------------------

    def run(self) -> None:
        tail: list[str] = []
        try:
            self.status_changed.emit(f"{self.label}…")
            # stderr merged into stdout: a single reader cannot deadlock on a
            # full unread pipe. start_new_session makes bash the group leader
            # so cancellation reaches every child it spawns.
            env = dict(self.env)
            # cargo/rustc only print per-crate progress and coloured diagnostics
            # to a terminal. Through a pipe they go quiet for the whole link —
            # minutes of nothing, which reads as a hang. Ask for the output a
            # terminal would get; colour codes are stripped by the log pane.
            env.setdefault("CARGO_TERM_PROGRESS_WHEN", "always")
            env.setdefault("CARGO_TERM_PROGRESS_WIDTH", "60")
            env.setdefault("CARGO_TERM_COLOR", "never")
            # Gradle likewise: plain console, per-task lines.
            env.setdefault("TERM", "dumb")
            self._process = subprocess.Popen(
                self.command,
                cwd=str(self.cwd),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                start_new_session=True,
            )
            assert self._process.stdout is not None

            for raw_line in self._process.stdout:
                # Compilers redraw progress in place with carriage returns
                # ("Compiling 41/120 … \r"); universal-newline mode flattens
                # those onto one line, so take only the final frame of each.
                line = raw_line.rstrip().split("\r")[-1].strip()
                if line:
                    self.log_message.emit(line)
                    tail.append(line)
                    del tail[:-ERROR_TAIL]

            return_code = self._process.wait()

            if self._cancel_event.is_set():
                self._signal_group(signal.SIGKILL)
                self.job_cancelled.emit()
            elif return_code == 0:
                self.job_finished.emit()
            else:
                self.job_failed.emit(
                    "\n".join(tail) or f"the build exited with code {return_code}."
                )

        except FileNotFoundError as exc:
            self.job_failed.emit(f"cannot run the build script: {exc}")
        except Exception as exc:  # keep GUI errors readable
            if self._cancel_event.is_set():
                self.job_cancelled.emit()
            else:
                self.job_failed.emit(f"{type(exc).__name__}: {exc}")
        finally:
            if self._process and self._process.poll() is None:
                self._signal_group(signal.SIGKILL)
                self._process.wait()
