#!/bin/sh
# Bring up only the awg-hermes-workspace compose project, then add the Angie route.
# Refuses to reload Angie while an eIPP code snapshot is running.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ENV_FILE=${HERMES_WORKSPACE_ENV_FILE:?set HERMES_WORKSPACE_ENV_FILE}
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

stamp_before=$(mktemp)
cleanup() { rm -f "$stamp_before"; }
trap cleanup EXIT

record_started() {
  for name in awg-llm llama awg-llm-confluence-worker hermes-bare; do
    if docker inspect -f '{{.State.StartedAt}}' "$name" >/dev/null 2>&1; then
      printf '%s %s\n' "$name" "$(docker inspect -f '{{.State.StartedAt}}' "$name")"
    fi
  done
}

record_started > "$stamp_before"
before_health=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health || echo err)
export HERMES_DASHBOARD_OPTIONAL=1
export EIPP_GUARD_MODE=graceful-reload
EIPP_SKIP_DOCKER=1 node "$ROOT/agent-preflight.mjs"
docker compose -p awg-hermes-workspace -f "$ROOT/compose.yaml" up -d --pull missing
sh "$ROOT/angie-route.sh" install --config "${ANGIE_VHOST:?set ANGIE_VHOST}" ${ANGIE_MAIN_CONFIG:+--main-config "$ANGIE_MAIN_CONFIG"}

stamp_after=$(mktemp)
record_started > "$stamp_after"
if ! cmp -s "$stamp_before" "$stamp_after"; then
  echo 'Open WebUI or llama container start time changed; investigate before continuing' >&2
  exit 1
fi
after_health=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health || echo err)
if [ "$before_health" != 200 ] || [ "$after_health" != 200 ]; then
  echo "Open WebUI health changed: ${before_health} -> ${after_health}" >&2
  exit 1
fi
rm -f "$stamp_after"
echo rollout-ok
