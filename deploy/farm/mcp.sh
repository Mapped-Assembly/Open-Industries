#!/bin/bash
set -euo pipefail
[[ $# == 0 && $EUID == 0 ]] || exit 64
exec 9>/run/lock/oi-farm-maintenance.lock
flock --shared --nonblock 9 || exit 75
systemctl is-active --quiet oi-farm.service || exit 69
exec 8<&0
unit="oi-farm-mcp-$(cat /proc/sys/kernel/random/uuid)"
client_pid=
cleanup() {
  systemctl stop "$unit.service" >/dev/null 2>&1 || true
  if [[ -n $client_pid ]]; then
    kill "$client_pid" >/dev/null 2>&1 || true
    wait "$client_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' HUP TERM
trap 'exit 130' INT
systemd-run --quiet --pipe --wait --collect --service-type=exec --unit="$unit" \
  --property=User=oi-farm --property=Group=oi-farm \
  --property=Requisite=oi-farm.service --property=After=oi-farm.service \
  --property=PartOf=oi-farm.service --property=KillMode=control-group \
  --property=TimeoutStopSec=20 --property=UMask=0077 \
  --property=NoNewPrivileges=yes --property=ProtectSystem=strict \
  --property=ProtectHome=yes --property=PrivateTmp=yes \
  --working-directory=/opt/oi-farm/app \
  --setenv=PATH=/opt/oi-station/node/bin:/usr/bin:/bin \
  --setenv=PYTHONDONTWRITEBYTECODE=1 --setenv=OPENBLAS_NUM_THREADS=1 \
  /opt/oi-farm/venv/bin/python -m oi_vision.farm_cli mcp \
  --state-dir /var/lib/oi-farm/state --root /opt/oi-farm/app <&8 &
client_pid=$!
wait "$client_pid"
