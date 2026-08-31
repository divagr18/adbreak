#!/usr/bin/env bash
#
# Put AdBreak on a single GCE VM.
#
# The whole plant is one docker-compose stack, so it deploys as one machine
# rather than being split across managed services. That keeps the topology the
# same as the one every gate was run against - a plant whose deployed shape
# differs from the tested shape is a plant nobody has tested.
#
# The agent authenticates to Vertex through the VM's attached service account,
# not a mounted key: there is no credential file to leak, and nothing to rotate.
#
#   ./deploy/deploy.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:-adbreak-hack-2026}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM="${VM_NAME:-adbreak}"
SA="adbreak-agent"
MACHINE="${MACHINE_TYPE:-e2-standard-4}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n=== %s\n' "$*"; }

say "project ${PROJECT}, zone ${ZONE}, vm ${VM}"
gcloud config set project "${PROJECT}" >/dev/null 2>&1

# --- service account: Vertex only, nothing else -----------------------------
if ! gcloud iam service-accounts describe "${SA}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1; then
  say "creating service account ${SA}"
  gcloud iam service-accounts create "${SA}" \
    --display-name "AdBreak agent (Vertex AI only)"
fi
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member "serviceAccount:${SA}@${PROJECT}.iam.gserviceaccount.com" \
  --role roles/aiplatform.user --condition=None >/dev/null

# --- firewall: the two ports a judge actually needs -------------------------
# 8084 is the CDN edge, which serves the HLS the demo plays.
# 8090 is the agent's own trace UI, where its reasoning is readable.
if ! gcloud compute firewall-rules describe adbreak-public >/dev/null 2>&1; then
  say "opening 8084 (edge/HLS) and 8090 (agent trace UI)"
  gcloud compute firewall-rules create adbreak-public \
    --allow tcp:8084,tcp:8090 \
    --target-tags adbreak \
    --description "AdBreak: HLS edge and agent trace UI"
fi

# --- the VM -----------------------------------------------------------------
if ! gcloud compute instances describe "${VM}" --zone "${ZONE}" >/dev/null 2>&1; then
  say "creating ${MACHINE} instance ${VM}"
  gcloud compute instances create "${VM}" \
    --zone "${ZONE}" \
    --machine-type "${MACHINE}" \
    --image-family debian-12 \
    --image-project debian-cloud \
    --boot-disk-size 60GB \
    --boot-disk-type pd-balanced \
    --tags adbreak \
    --service-account "${SA}@${PROJECT}.iam.gserviceaccount.com" \
    --scopes https://www.googleapis.com/auth/cloud-platform \
    --metadata-from-file startup-script="${REPO_ROOT}/deploy/startup.sh"
  say "waiting for docker to finish installing (startup script)"
  for _ in $(seq 1 40); do
    if gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap \
        --command 'docker --version' >/dev/null 2>&1; then
      break
    fi
    sleep 15
  done
fi

# --- ship the repo ----------------------------------------------------------
# node_modules and the local run history stay behind; data/ must NOT go either,
# because it holds ground-truth.jsonl - the answer key the agent is graded
# against and must never be able to read.
say "copying the repo (excluding node_modules, agent-data, data)"
gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap \
  --command 'mkdir -p ~/adbreak' >/dev/null

tar --exclude=node_modules --exclude=.git --exclude=agent-data --exclude=data \
    --exclude=hls --exclude='*.log' \
    -czf /tmp/adbreak.tar.gz -C "${REPO_ROOT}" .
gcloud compute scp /tmp/adbreak.tar.gz "${VM}:~/adbreak.tar.gz" \
  --zone "${ZONE}" --tunnel-through-iap
gcloud compute scp "${REPO_ROOT}/.env" "${VM}:~/adbreak/.env" \
  --zone "${ZONE}" --tunnel-through-iap

say "building and starting the stack"
gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap --command '
  set -e
  cd ~/adbreak
  tar xzf ~/adbreak.tar.gz
  # data/ is deliberately not shipped: it holds the ground-truth ledger, which
  # is the answer key the agent is graded against. The VM writes its own as
  # chaos is injected there. The directory must exist for the collector and
  # injector mounts, but it starts empty.
  mkdir -p agent-data/agent-runs data
  sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
'

IP="$(gcloud compute instances describe "${VM}" --zone "${ZONE}" \
        --format 'value(networkInterfaces[0].accessConfigs[0].natIP)')"

say "deployed"
cat <<EOF

  HLS playlist   http://${IP}:8084/session/demo/playlist.m3u8?device_class=web&region=us-east&cdn=cdn-east
  Agent traces   http://${IP}:8090/trace

Grafana dashboards are already hosted; share those links from the Grafana Cloud
stack rather than from here.

Give the plant ten minutes before judging anything by it: the SLO is computed
over a 15 minute window and reads nonsense until one has elapsed.
EOF
