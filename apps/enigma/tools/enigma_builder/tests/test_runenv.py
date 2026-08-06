"""The scrubbed environment a test run launches the app with.

The poisoning is real: launched from VS Code's snap, the inherited
LD_LIBRARY_PATH made the app die at exec with
``symbol lookup error: __libc_pthread_init``.
"""

from __future__ import annotations

import runenv


def test_snap_entries_are_filtered_from_path_lists():
    env = runenv.clean_env(
        {"LD_LIBRARY_PATH": "/snap/core20/x/lib:/usr/lib", "HOME": "/home/x"}
    )
    assert env["LD_LIBRARY_PATH"] == "/usr/lib"


def test_a_fully_snap_path_list_is_dropped_entirely():
    env = runenv.clean_env({"GTK_PATH": "/snap/code/253/usr/lib/gtk"})
    assert "GTK_PATH" not in env


def test_snap_single_paths_are_dropped():
    env = runenv.clean_env(
        {"GDK_PIXBUF_MODULE_FILE": "/snap/core20/x/cache", "GTK_EXE_PREFIX": "/usr"}
    )
    assert "GDK_PIXBUF_MODULE_FILE" not in env
    assert env["GTK_EXE_PREFIX"] == "/usr"


def test_a_sandboxed_data_home_is_unset():
    env = runenv.clean_env({"XDG_DATA_HOME": "/home/x/snap/code/253/.local/share"})
    assert "XDG_DATA_HOME" not in env


def test_a_real_data_home_survives():
    env = runenv.clean_env({"XDG_DATA_HOME": "/home/x/.local/share"})
    assert env["XDG_DATA_HOME"] == "/home/x/.local/share"


def test_pyinstaller_original_wins():
    env = runenv.clean_env(
        {
            "LD_LIBRARY_PATH": "/tmp/_MEIxyz/lib",
            "LD_LIBRARY_PATH_ORIG": "/opt/lib",
        }
    )
    assert env["LD_LIBRARY_PATH"] == "/opt/lib"


def test_unrelated_variables_pass_through():
    env = runenv.clean_env({"RUST_LOG": "debug", "PATH": "/usr/bin:/bin"})
    assert env["RUST_LOG"] == "debug"
    assert env["PATH"] == "/usr/bin:/bin"
