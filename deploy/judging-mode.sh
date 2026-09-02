#!/usr/bin/env bash
#
# Hand the deployed plant over for judging.
#
# Both plants ship the same metric names to one Grafana Cloud stack, and the
# agent's PromQL does not filter on the `env` label Alloy stamps. So exactly one
# plant may be live at a time, or each agent reasons over the other's telemetry:
# the deployed agent spent an afternoon diagnosing faults injected on a laptop,
# which is harmless - it only ever remediates its own SSAI - but produces a run
# history that describes a plant nobody can see.
#
# This is that handover, made executable rather than left as a paragraph in the
# README for someone to follow correctly at midnight.
#
#   ./deploy/judging-mode.sh          # VM live, local silenced
#   ./deploy/judging-mode.sh local    # the reverse, to get back to developing
#
set -euo pipefail

ZONE="${GCP_ZONE:-us-central1-a}"
VM="${VM_NAME:-adbreak}"
MODE="${1:-judging}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE='sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml'

say() { printf '\n=== %s\n' "$*"; }
onvm() { gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap --command "cd ~/adbreak && $1"; }

if [ "${MODE}" = "local" ]; then
  say "handing the Grafana stack back to the local plant"
  onvm "${COMPOSE} stop alloy" >/dev/null
  curl -sf -X POST -H 'content-type: application/json' -d '{"enabled":false}' \
    https://trace.divagr.com/admin/polling >/dev/null || true
  say "starting local Alloy"
  (cd "${REPO_ROOT}" && docker compose up -d alloy >/dev/null 2>&1)
  curl -sf -X POST -H 'content-type: application/json' -d '{"enabled":true}' \
    http://localhost:8090/admin/polling >/dev/null || true
  echo "local plant is the only shipper; the deployed agent is paused."
  exit 0
fi

say "silencing the local plant"
# Only Alloy needs to stop - the local plant can keep running, it just stops
# shipping. Its agent is paused so it does not reason over the VM's telemetry.
(cd "${REPO_ROOT}" && docker compose stop alloy >/dev/null 2>&1) || true
curl -sf -X POST -H 'content-type: application/json' -d '{"enabled":false}' \
  http://localhost:8090/admin/polling >/dev/null 2>&1 || true

say "clearing the deployed agent's run history"
# Those runs were produced while it was reading another plant's telemetry. They
# are real records of real reasoning, but they describe incidents that never
# happened on this machine, and presenting them as its own would be misleading.
onvm "sudo rm -f agent-data/agent-runs/*.json" >/dev/null

say "starting the VM's Alloy and resuming its agent"
onvm "${COMPOSE} up -d alloy" >/dev/null
onvm "${COMPOSE} restart agent" >/dev/null
sleep 20
curl -sf -X POST -H 'content-type: application/json' -d '{"enabled":true}' \
  https://trace.divagr.com/admin/polling >/dev/null || true

say "handed over"
cat <<'EOF'

  HLS stream     https://stream.divagr.com/session/demo/playlist.m3u8?device_class=web&region=us-east&cdn=cdn-east
  Agent traces   https://trace.divagr.com/trace

The SLO is computed over 15 minutes, so give it that long before the dashboards
mean anything. To inject a fault for a live demonstration (the injector is not
reachable from the internet, by design):

  gcloud compute ssh adbreak --zone us-central1-a --tunnel-through-iap \
    --command 'curl -sX POST localhost:8086/inject -H "content-type: application/json" \
      -d "{\"fault\":\"F07\",\"params\":{\"device_class\":\"roku\"},\"duration_s\":900}"'
EOF
