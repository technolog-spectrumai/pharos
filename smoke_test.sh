#!/usr/bin/env bash
# The smoke checks: ./smoke_test.sh [enigma]  →  the app's component smoke test
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" && exec npm run smoke -w apps/enigma
