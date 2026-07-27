"""The worker drives real subprocesses, so these tests use real ones.

The cancellation path is the reason this file exists: the build scripts spawn
npm, cargo, tauri and gradle, and a cancel that only reaches bash would leave a
multi-gigabyte compile running with nothing attached to it.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from build_worker import BuildWorker


def pump_until(app, predicate, timeout: float = 30.0) -> bool:
    """Spin the event loop until ``predicate`` holds.

    The worker emits from its own thread, so the signals arrive as queued
    events for the main thread — blocking on QThread.wait() would deliver
    none of them, which is also why the GUI must never block on a build.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        app.processEvents()
        if predicate():
            return True
        time.sleep(0.01)
    return False


def run_worker(app, tmp_path: Path, script: str, cancel_after: str | None = None):
    """Run a script to completion, optionally cancelling once it logs a marker."""
    path = tmp_path / "job.sh"
    path.write_text(script, encoding="utf-8")

    worker = BuildWorker(
        command=["bash", str(path)], cwd=tmp_path, env=os.environ.copy()
    )
    return drive(app, worker, lines_marker=cancel_after)


def drive(app, worker: BuildWorker, lines_marker: str | None = None):
    events: list[tuple[str, str]] = []
    lines: list[str] = []
    worker.log_message.connect(lines.append)
    worker.job_finished.connect(lambda: events.append(("finished", "")))
    worker.job_failed.connect(lambda message: events.append(("failed", message)))
    worker.job_cancelled.connect(lambda: events.append(("cancelled", "")))
    worker.start()

    if lines_marker is not None:
        seen = pump_until(
            app, lambda: any(line.startswith(lines_marker) for line in lines), 10
        )
        if not seen:
            worker.request_cancel()
            pump_until(app, worker.isFinished, 15)
            pytest.fail(f"marker {lines_marker!r} never appeared; got {lines}")
        worker.request_cancel()

    assert pump_until(app, worker.isFinished, 30), "worker did not finish in time"
    app.processEvents()  # drain the terminal signal
    return events, lines


def test_success_reports_finished(app, tmp_path):
    events, lines = run_worker(app, tmp_path, "echo hello\n")
    assert events == [("finished", "")]
    assert "hello" in lines


def test_stderr_is_merged_into_the_log(app, tmp_path):
    events, lines = run_worker(app, tmp_path, "echo oops >&2\n")
    assert events == [("finished", "")]
    assert "oops" in lines


def test_failure_reports_the_output_tail(app, tmp_path):
    events, _ = run_worker(app, tmp_path, "echo something broke\nexit 3\n")
    assert len(events) == 1
    kind, message = events[0]
    assert kind == "failed"
    assert "something broke" in message


def test_exit_code_is_reported_when_there_is_no_output(app, tmp_path):
    events, _ = run_worker(app, tmp_path, "exit 7\n")
    assert events[0][0] == "failed"
    assert "7" in events[0][1]


def test_missing_command_fails_without_raising(app):
    worker = BuildWorker(
        command=["definitely-not-a-real-binary"],
        cwd=Path.cwd(),
        env=os.environ.copy(),
    )
    events, _ = drive(app, worker)
    assert events[0][0] == "failed"
    assert "cannot run" in events[0][1]


def test_cancel_kills_the_whole_process_group(app, tmp_path):
    """A grandchild of the script must not survive the cancel.

    `sleep` here stands in for cargo: bash forks it, so signalling only the
    bash pid would leave it running.
    """
    script = "sleep 120 &\n" "echo child $!\n" "wait\n"
    events, lines = run_worker(app, tmp_path, script, cancel_after="child ")

    assert events == [("cancelled", "")]
    child_pid = int(next(line for line in lines if line.startswith("child ")).split()[1])

    for _ in range(50):
        try:
            os.kill(child_pid, 0)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.1)
    pytest.fail(f"grandchild {child_pid} survived the cancel")


def test_cancel_escalates_when_sigterm_is_ignored(app, tmp_path):
    """A build that traps SIGTERM still dies, after the grace period."""
    script = "trap '' TERM\n" "sleep 120 &\n" "echo child $!\n" "wait\n"
    started = time.monotonic()
    events, _ = run_worker(app, tmp_path, script, cancel_after="child ")
    elapsed = time.monotonic() - started

    assert events == [("cancelled", "")]
    # The SIGKILL follows the grace period, so this cannot have been prompt.
    assert elapsed >= 9, f"cancel returned in {elapsed:.1f}s — grace never elapsed"
