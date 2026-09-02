#!/usr/bin/env bash
#
# Put the deployed plant behind a named Cloudflare Tunnel.
#
#   stream.divagr.com  ->  the CDN edge, which serves the HLS
#   trace.divagr.com   ->  the agent's trace UI
#
# A named tunnel rather than a quick one: the hostname has to survive a judging
# window that runs for weeks, and a trycloudflare.com name rotates whenever the
# process restarts.
#
# Once this is running the origin no longer needs to be reachable at all, so
# deploy.sh's public firewall rule is withdrawn. Nothing inbound reaches the VM;
# cloudflared holds an outbound connection and Cloudflare terminates TLS. That
# is strictly better than the bare HTTP on a raw IP it replaces.
#
# Prerequisites, done once on the workstation:
#   cloudflared tunnel login
#   cloudflared tunnel create adbreak
#   cloudflared tunnel route dns adbreak stream.divagr.com
#   cloudflared tunnel route dns adbreak trace.divagr.com
#
#   ./deploy/tunnel.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:-adbreak-hack-2026}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM="${VM_NAME:-adbreak}"
TUNNEL="${TUNNEL_NAME:-adbreak}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

native() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }
say() { printf '\n=== %s\n' "$*"; }

CF_DIR="${HOME}/.cloudflared"
TUNNEL_ID="$(ls "${CF_DIR}"/*.json 2>/dev/null | head -1 | xargs -n1 basename | sed 's/\.json$//')"
[ -n "${TUNNEL_ID}" ] || { echo "no tunnel credentials in ${CF_DIR}; run cloudflared tunnel create ${TUNNEL}" >&2; exit 1; }
say "tunnel ${TUNNEL} (${TUNNEL_ID})"

# --- the tunnel's own config, written on the VM ------------------------------
# ingress rules are ordered and the last must be a catch-all, or cloudflared
# refuses to start.
cat > /tmp/adbreak-tunnel.yml <<YAML
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/${TUNNEL_ID}.json
originRequest:
  connectTimeout: 30s
  # HLS segments are a few hundred KB and the fleet keeps connections warm.
  keepAliveConnections: 32

ingress:
  - hostname: stream.divagr.com
    service: http://localhost:8084
  - hostname: trace.divagr.com
    service: http://localhost:8090
  - service: http_status:404
YAML

say "installing cloudflared on the VM"
gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap --command '
  set -e
  if ! command -v cloudflared >/dev/null; then
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
      -o /tmp/cloudflared.deb
    sudo dpkg -i /tmp/cloudflared.deb
  fi
  sudo mkdir -p /etc/cloudflared
'

say "shipping credentials and config"
gcloud compute scp "$(native "${CF_DIR}/${TUNNEL_ID}.json")" "${VM}:cf-creds.json" \
  --zone "${ZONE}" --tunnel-through-iap
gcloud compute scp "$(native /tmp/adbreak-tunnel.yml)" "${VM}:cf-config.yml" \
  --zone "${ZONE}" --tunnel-through-iap

say "starting cloudflared as a service"
gcloud compute ssh "${VM}" --zone "${ZONE}" --tunnel-through-iap --command "
  set -e
  sudo mv ~/cf-creds.json /etc/cloudflared/${TUNNEL_ID}.json
  sudo mv ~/cf-config.yml /etc/cloudflared/config.yml
  sudo chmod 600 /etc/cloudflared/${TUNNEL_ID}.json
  sudo cloudflared --config /etc/cloudflared/config.yml service install 2>/dev/null || true
  sudo systemctl enable --now cloudflared
  sleep 5
  sudo systemctl is-active cloudflared
"

# --- close the origin --------------------------------------------------------
# The tunnel is outbound-only, so the ports opened by deploy.sh are no longer
# needed. Leaving them open would keep an unauthenticated origin on the public
# internet for no benefit.
if gcloud compute firewall-rules describe adbreak-public >/dev/null 2>&1; then
  say "withdrawing the public firewall rule — the tunnel is the only way in now"
  gcloud compute firewall-rules delete adbreak-public --quiet
fi

say "done"
cat <<EOF

  HLS stream     https://stream.divagr.com/session/demo/playlist.m3u8?device_class=web&region=us-east&cdn=cdn-east
  Agent traces   https://trace.divagr.com/trace

Both are HTTPS, terminated by Cloudflare, with no inbound port open on the VM.
EOF
