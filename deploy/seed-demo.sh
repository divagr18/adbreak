#!/usr/bin/env bash
#
# Put real incidents on the deployed trace page.
#
# The handover clears the run history, because those runs were made while the
# deployed agent was reading another plant's telemetry. That leaves the page
# empty, which is a worse first impression than a slightly odd one - so this
# injects three faults and lets the agent find them on its own.
#
# Deliberately NOT through the alert webhook. The gates trigger that way for
# timing determinism, but here the point is that a judge sees incidents the
# agent detected by itself, from its own polling, exactly as it would in
# production.
#
# The three are chosen to show the three things it can do:
#   F07  a beacon blackhole      -> it fixes this alone
#   F08  a regional CDN outage   -> nothing safe is mapped, so it escalates
#   F04  the ad server empties   -> channel-wide, so it stops and asks a human
#
# F04 runs last on purpose: it ends sitting at awaiting_approval, so whoever
# opens the page finds a button they can actually press.
#
#   ./deploy/seed-demo.sh
#
set -euo pipefail

ZONE="${GCP_ZONE:-us-central1-a}"
VM="${VM_NAME:-adbreak}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACE="https://trace.divagr.com"

say() { printf '\n=== %s\n' "$*"; }
onvm() { gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap --command "$1" 2>/dev/null; }

inject() { # fault, params-json, seconds
  onvm "curl -sX POST localhost:8086/inject -H 'content-type: application/json' -d '{\"fault\":\"$1\",\"params\":$2,\"duration_s\":$3}'" >/dev/null
}
clear_faults() { onvm "curl -sX DELETE localhost:8086/inject" >/dev/null; }
# Wait for a run the agent OPENED after a given moment.
#
# Counting completed runs does not work: a run that began before the injection
# and finished after it makes the count rise, and the caller concludes its own
# fault was found. That happened on the first attempt here - F07 was reverted
# after 75 seconds because a run started 39 seconds earlier had just been
# written - and it is the same mistake the gates made before they learned to
# compare detectedAt rather than tally rows.
await_run() { # label, ISO instant to beat, minutes
  local since="$2" waited=0 found
  printf '  waiting for the agent to notice'
  while [ "${waited}" -lt "$(( $3 * 60 ))" ]; do
    sleep 20; waited=$(( waited + 20 ))
    found="$(curl -s --max-time 20 "${TRACE}/runs" | python -c "
import sys, json
since = sys.argv[1]
mine = [r for r in json.load(sys.stdin) if r['detectedAt'] > since]
print(mine[-1]['runId'] if mine else '')
" "${since}" 2>/dev/null || true)"
    if [ -n "${found}" ]; then
      printf ' %s after %ss
' "${found}" "${waited}"
      return 0
    fi
    printf '.'
  done
  printf '
  gave up after %s minutes - %s produced no run
' "$3" "$1"
  return 1
}

say "waiting for the SLO window to fill before injecting anything"
# The alert is computed over 15 minutes and reads nonsense until one has
# elapsed; injecting into that would have the agent reason about noise.
(cd "${REPO_ROOT}" && npx tsx scripts/q.ts wait 3 30) || echo "  proceeding anyway"

clear_faults

say "clearing the runs made while the plant was still settling after its reset"
# Three of them, each correctly declining to act on a plant that was merely
# recovering. Right behaviour, but not what anyone should land on.
onvm "sudo rm -f ~/adbreak/agent-data/agent-runs/*.json" >/dev/null

say "1/3  beacon blackhole on roku — the agent should fix this alone"
since="$(date -u +%Y-%m-%dT%H:%M:%S)"
inject F07 '{"device_class":"roku"}' 1200
await_run "F07" "${since}" 12 || true
clear_faults
say "letting the plant recover"
sleep 300

say "2/3  regional CDN failure — nothing safe is mapped, so it should escalate"
since="$(date -u +%Y-%m-%dT%H:%M:%S)"
inject F08 '{"cdn":"cdn-west"}' 900
await_run "F08" "${since}" 12 || true
clear_faults
say "letting the plant recover"
sleep 300

say "3/3  ad server returning nothing — channel-wide, so it should stop and ask"
since="$(date -u +%Y-%m-%dT%H:%M:%S)"
# Left injected: the plan waits for a human, and the fault should still be live
# when they approve it, so the recovery they watch is real.
inject F04 '{}' 3600
await_run "F04" "${since}" 12 || true

say "seeded"
curl -s --max-time 20 "${TRACE}/runs" |
  python -c "
import sys, json
for r in json.load(sys.stdin):
    print(f\"  {r['runId']}  {r.get('failureClass','?'):5}  {r['outcome']}\")
" 2>/dev/null || true
cat <<EOF

  ${TRACE}/trace

The F04 incident is left sitting at awaiting_approval with the fault still
injected, so approving it from the page performs a real repair on a live fault.
EOF
