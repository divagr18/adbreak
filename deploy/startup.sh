#!/usr/bin/env bash
# GCE startup script: install Docker and nothing else. The stack itself is
# started by deploy.sh once the repo has been copied across.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg |
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# The plant runs 200 synthetic sessions against a local edge; the default file
# descriptor limit is not enough for that many concurrent sockets.
echo 'fs.file-max = 200000' >> /etc/sysctl.conf
sysctl -p

systemctl enable --now docker
