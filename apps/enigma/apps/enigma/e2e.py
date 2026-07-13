#!/usr/bin/env python3
"""End-to-end test runner for the Enigma app (serverless P2P chat).

The app has no backend, so there is nothing to spin up or seed: this simply
runs the stubbed Playwright smoke tier (see playwright.config). CI/CD
friendly: non-zero exit on failure.

Usage (from anywhere):
    python apps/enigma/e2e.py
"""
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

if __name__ == "__main__":
    raise SystemExit(subprocess.call(["npx", "playwright", "test"], cwd=HERE))
