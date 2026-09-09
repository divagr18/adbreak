#!/usr/bin/env bash
#
# Install a self-heal timer on the deployed VM.
#
# Judging runs for three weeks and nobody will be watching. On 9 September the
# VM's network stack died - it could not reach the metadata server at
# 169.254.169.254, so SSH was refused and cloudflared could not dial out - and
# after the reset it came back with eleven of thirteen containers running.
# redis and origin had no restart policy, so the cue bus was down and the plant
# signalled no ad breaks at all while every remaining service reported healthy.
#
# `docker compose up -d` is idempotent: it starts what is missing and leaves
# what is running alone. Every five minutes is enough to close the gap between
# a reboot and someone noticing, without fighting a deliberate `compose stop`
# for more than one interval.
#
#   ./deploy/selfheal.sh
#
set -euo pipefail

ZONE="${GCP_ZONE:-us-central1-a}"
VM="${VM_NAME:-adbreak}"

gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap --command '
set -e
sudo tee /etc/systemd/system/adbreak-heal.service >/dev/null <<UNIT
[Unit]
Description=Bring any missing AdBreak container back up
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/home/'"$(whoami)"'/adbreak
ExecStart=/usr/bin/docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d
UNIT

sudo tee /etc/systemd/system/adbreak-heal.timer >/dev/null <<UNIT
[Unit]
Description=Check every five minutes that the whole plant is up

[Timer]
OnBootSec=90s
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now adbreak-heal.timer
sudo systemctl list-timers adbreak-heal.timer --no-pager | head -3
'
