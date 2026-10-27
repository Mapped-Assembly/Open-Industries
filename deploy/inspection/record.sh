#!/bin/bash
# Host-side deterministic evidence sequence. Does not choose or invoke an LLM.
set -euo pipefail
[[ $EUID == 0 && $# == 2 ]] || exit 64
export PATH=/opt/oi-station/node/bin:/usr/bin:/bin
python=/opt/oi-station/venv/bin/python
case "$1" in
  before-reboot)
    "$python" -m oi_vision.station_evidence exercise --aws --output "$2" --mcp-wrapper /usr/local/bin/oi-station-mcp
    systemctl restart oi-station.service
    "$python" -m oi_vision.station_evidence verify --kind restart --output "$2" --mcp-wrapper /usr/local/bin/oi-station-mcp
    echo 'Now reboot the host, reconnect via SSH, then run record.sh after-reboot with the same output directory.'
    ;;
  after-reboot)
    "$python" -m oi_vision.station_evidence verify --kind reboot --output "$2" --mcp-wrapper /usr/local/bin/oi-station-mcp
    ;;
  *) exit 64 ;;
esac
