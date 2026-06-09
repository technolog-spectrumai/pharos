#!/usr/bin/env bash
# End-to-end test: bring up the studio onion stack (HTTPS + WSS, served as a Tor v3
# hidden service), seed a chat channel, then run the Rust harness against the
# transport matrix:
#   - clearnet TLS : https://127.0.0.1:8443     (no Tor needed)
#   - TLS onion    : https://<onion>            (real Tor; https+wss over the circuit)
#
# The harness (src-tauri/src/onion_e2e.rs) uses the SAME transport code the app uses.
#
# Usage:   bash enigma/enigma/scripts/onion_e2e.sh
# Env:     SKIP_ONION=1   run only the clearnet row (skip the real-Tor row)
#          KEEP_UP=1      leave the stack running on exit (don't tear down)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
CFG=deployment/portal_onion_studio_tls.yaml
NAME=onion_studio_tls
COMPOSE=.compose/$NAME/docker-compose.yaml
ENVFILE=.env.$NAME
ADMIN_PASS=test1234
CHANNEL=e2e
HTTPS=https://127.0.0.1:8443

dc() { docker compose --env-file "$ENVFILE" -f "$COMPOSE" -p "$NAME" "$@"; }
log() { printf '\n\033[1;36m[e2e] %s\033[0m\n' "$*"; }

teardown() {
  if [ "${KEEP_UP:-0}" = "1" ]; then log "KEEP_UP=1 — leaving stack running"; return; fi
  log "tearing down stack ($NAME)…"
  dc down -v --remove-orphans 2>/dev/null || true
}
trap teardown EXIT

log "building + starting the TLS studio onion stack (first build is slow)…"
python portal/scripts/deploy.py "$CFG" up -d --service --admin-password "$ADMIN_PASS"

log "waiting for migrations + admin seed (poll the login API until it returns a token)…"
for i in $(seq 1 150); do
  resp=$(curl -sk -X POST "$HTTPS/telegraph/api/login/" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}" 2>/dev/null || true)
  printf '%s' "$resp" | grep -q '"token"' && { log "login API works — DB ready"; break; }
  [ "$i" = "150" ] && { log "login never succeeded"; dc ps; dc logs --tail=120 "web_$NAME"; exit 1; }
  sleep 4
done

log "seeding chat channel '$CHANNEL' + admin membership…"
dc exec -T "web_$NAME" python manage.py shell -c '
from django.contrib.auth import get_user_model
from toto.telegraph.models import TelegraphChannel, TelegraphMember
from toto.people.models import Person
U = get_user_model()
u = U.objects.filter(username="admin").first()
p = Person.objects.filter(user=u).first() if u else None
ch, _ = TelegraphChannel.objects.get_or_create(slug="e2e", defaults={"name": "E2E Channel", "created_by": u})
if p:
    TelegraphMember.objects.get_or_create(channel=ch, person=p, defaults={"is_active": True})
print("CHANNEL_OK", ch.slug, "person=", bool(p))
'

run_row() {  # name  base  is_onion
  local label="$1" base="$2" is_onion="$3"
  log "ROW: $label  ($base)"
  ( cd enigma/enigma/src-tauri && \
    ENIGMA_E2E=1 ENIGMA_E2E_BASE="$base" ENIGMA_E2E_IS_ONION="$is_onion" \
    ENIGMA_E2E_USER=admin ENIGMA_E2E_PASS="$ADMIN_PASS" ENIGMA_E2E_CHANNEL="$CHANNEL" \
    cargo test --lib -- --ignored --nocapture onion_full_flow )
}

RESULTS=()

# Row 1 — clearnet TLS (no Tor): proves https + wss + image end-to-end.
if run_row "clearnet TLS (https+wss)" "$HTTPS" 0; then RESULTS+=("clearnet-TLS: PASS"); else RESULTS+=("clearnet-TLS: FAIL"); fi

# Row 2 — TLS onion over real Tor.
if [ "${SKIP_ONION:-0}" != "1" ]; then
  log "fetching the .onion address…"
  ONION=$(python portal/scripts/deploy.py "$CFG" onion --service 2>/dev/null | tr -d '[:space:]' | grep -oE '[a-z2-7]{56}\.onion' || true)
  if [ -n "$ONION" ]; then
    log "onion address: $ONION — waiting ~60s for it to publish to the Tor network…"
    sleep 60
    if run_row "TLS onion (https+wss over Tor)" "https://$ONION" 1; then RESULTS+=("TLS-onion: PASS"); else RESULTS+=("TLS-onion: FAIL"); fi
  else
    RESULTS+=("TLS-onion: SKIP (no onion address)")
  fi
else
  RESULTS+=("TLS-onion: SKIP (SKIP_ONION=1)")
fi

log "================ SUMMARY ================"
for r in "${RESULTS[@]}"; do printf '  • %s\n' "$r"; done
case " ${RESULTS[*]} " in *FAIL*) exit 1;; esac
