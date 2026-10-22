# The runner behind every repo's tests.sh.
#
# Sourced after lib.sh. A tests.sh is then just its list of steps:
#
#   tests_step js   "frontend tests"  'npm run test --workspaces --if-present'
#   tests_step rust "app crate"       'cargo test --manifest-path apps/x/src-tauri/Cargo.toml'
#   tests_main "$@"
#
# Each step is a group, a title and one command line, run with bash from the
# repo root. EVERY selected step runs even when an earlier one fails — this is
# the long run you start and walk away from, and coming back to "stopped at
# step 2" would waste it. The table at the end says what passed, what failed
# and how long each took; the exit status is non-zero if anything failed.

# Named tests_step, not step: lib.sh already has a `step` that prints a
# heading, and ensure_deps calls it.
TESTS_GROUPS=()
TESTS_TITLES=()
TESTS_COMMANDS=()

tests_step() {
  TESTS_GROUPS+=("$1")
  TESTS_TITLES+=("$2")
  TESTS_COMMANDS+=("$3")
}

tests_usage() {
  echo "Run this repo's full test suite."
  echo
  echo "  ./tests.sh              every step"
  echo "  ./tests.sh GROUP...     only the steps in these groups"
  echo "  ./tests.sh --list       show the steps and their groups, run nothing"
  echo
  echo "Every selected step runs even if an earlier one fails. Each step's output"
  echo "is also saved under test-results/tests/."
}

tests_list() {
  local i
  for i in "${!TESTS_TITLES[@]}"; do
    printf '%-8s %s\n         %s\n' "${TESTS_GROUPS[$i]}" "${TESTS_TITLES[$i]}" "${TESTS_COMMANDS[$i]}"
  done
}

# Handles --help and --list, which must work with nothing installed. Returns 0
# when it answered the request (the caller should exit), 1 to carry on.
tests_answered() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -h|--help) tests_usage; return 0 ;;
      --list)    tests_list; return 0 ;;
    esac
  done
  return 1
}

tests_main() {
  local wanted=() arg i g known
  for arg in "$@"; do
    case "$arg" in
      -*) echo "unknown option: $arg (try --help)" >&2; return 2 ;;
      *)  wanted+=("$arg") ;;
    esac
  done

  # A mistyped group must not look like a clean run of nothing.
  for arg in "${wanted[@]+"${wanted[@]}"}"; do
    known=0
    for g in "${TESTS_GROUPS[@]}"; do [ "$g" = "$arg" ] && known=1; done
    if [ "$known" -eq 0 ]; then
      echo "no group '$arg' (have: $(printf '%s\n' "${TESTS_GROUPS[@]}" | sort -u | tr '\n' ' '))" >&2
      return 2
    fi
  done

  local logs="$REPO_ROOT/test-results/tests"
  mkdir -p "$logs"

  # Piped through tee, nothing sees a terminal; say so explicitly or the long
  # run is monochrome.
  if [ -t 1 ]; then export FORCE_COLOR=1 CARGO_TERM_COLOR=always; fi

  local results=() durations=() ran=() failed=0 started status log selected
  for i in "${!TESTS_TITLES[@]}"; do
    selected=1
    if [ "${#wanted[@]}" -gt 0 ]; then
      selected=0
      for arg in "${wanted[@]}"; do [ "${TESTS_GROUPS[$i]}" = "$arg" ] && selected=1; done
    fi
    [ "$selected" -eq 1 ] || continue

    printf '\n\033[1;36m==> [%s] %s\033[0m\n    %s\n' \
      "${TESTS_GROUPS[$i]}" "${TESTS_TITLES[$i]}" "${TESTS_COMMANDS[$i]}"
    log="$logs/$(printf '%02d' "$((i + 1))")-${TESTS_GROUPS[$i]}.log"
    started=$SECONDS
    status=0
    ( cd "$REPO_ROOT" && bash -o pipefail -c "${TESTS_COMMANDS[$i]}" ) 2>&1 | tee "$log" || status=$?
    ran+=("$i")
    durations+=("$((SECONDS - started))")
    if [ "$status" -eq 0 ]; then
      results+=(ok)
    else
      results+=(FAILED)
      failed=$((failed + 1))
    fi
  done

  local n
  printf '\n\033[1m%-8s %-7s %6s  %s\033[0m\n' GROUP RESULT TIME STEP
  for n in "${!ran[@]}"; do
    i="${ran[$n]}"
    if [ "${results[$n]}" = ok ]; then printf '\033[32m'; else printf '\033[1;31m'; fi
    printf '%-8s %-7s %5ss  %s\033[0m\n' \
      "${TESTS_GROUPS[$i]}" "${results[$n]}" "${durations[$n]}" "${TESTS_TITLES[$i]}"
  done
  printf '\nlogs: %s\n' "$logs"

  if [ "$failed" -gt 0 ]; then
    printf '\033[1;31m%s of %s steps failed\033[0m\n' "$failed" "${#ran[@]}"
    return 1
  fi
  printf '\033[1;32mall %s steps passed\033[0m\n' "${#ran[@]}"
}
