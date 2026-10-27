#!/bin/bash
# Installed root-owned. No arguments, environment secrets or shell interpolation.
set -euo pipefail
[[ $# == 0 && $EUID == 0 ]] || exit 64
exec 9>/run/lock/oi-station-maintenance.lock
flock --shared --nonblock 9 || exit 75
systemctl is-active --quiet oi-station.service || exit 69
exec 8<&0
unit="oi-station-mcp-$(cat /proc/sys/kernel/random/uuid)"
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
# A transient service gives even nested policy/MCP processes a cgroup. PartOf
# stops all agent clients with the station; Requisite never auto-starts it.
systemd-run --quiet --pipe --wait --collect --service-type=exec --unit="$unit" \
  --property=User=oi-station --property=Group=oi-station \
  --property=Requisite=oi-station.service --property=After=oi-station.service \
  --property=PartOf=oi-station.service --property=KillMode=control-group \
  --property=TimeoutStopSec=20 --property=UMask=0077 \
  --property=NoNewPrivileges=yes --property=ProtectSystem=strict \
  --property=ReadWritePaths=/var/lib/oi-station --property=ProtectHome=yes \
  --property=PrivateTmp=yes --working-directory=/opt/oi-station/app \
  --setenv=PATH=/opt/oi-station/node/bin:/usr/bin:/bin \
  --setenv=PYTHONDONTWRITEBYTECODE=1 --setenv=OPENBLAS_NUM_THREADS=1 \
  /opt/oi-station/venv/bin/python -m oi_vision.demo_cli mcp --state-dir /var/lib/oi-station/state <&8 &
client_pid=$!
# Waiting on a background child lets Bash handle SSH disconnect signals immediately
# instead of deferring traps until a foreground systemd-run has already exited.
wait "$client_pid"
