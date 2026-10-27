#!/bin/bash
# Run as root on Ubuntu 24.04 amd64. Never move the launcher-bound app path.
set -euo pipefail
[[ $EUID == 0 && $# -ge 1 && $# -le 2 && $1 =~ ^[0-9a-f]{40}$ ]] || exit 64
[[ $# == 1 || $2 == --no-start ]] || exit 64
start=true
if [[ $# == 2 ]]; then start=false; fi
release=$1
app=/opt/oi-station/app
[[ $(uname -m) == x86_64 && $(realpath "$app") == "$app" ]]
[[ $(git -C "$app" rev-parse HEAD) == "$release" ]]
[[ -z $(git -C "$app" status --porcelain --untracked-files=no) ]]
exec 9>/run/lock/oi-station-maintenance.lock
flock --exclusive --nonblock 9
if systemctl is-active --quiet oi-station.service; then
  echo 'Stop and back up the station before installation.' >&2
  exit 1
fi
python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12)'
id oi-station >/dev/null 2>&1 || useradd --system --home-dir /var/lib/oi-station --shell /usr/sbin/nologin oi-station
install -d -m 0700 -o oi-station -g oi-station /var/lib/oi-station
install -d -m 0700 /var/backups/oi-station
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
curl --fail --silent --show-error --location https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz -o "$temporary/node.tar.xz"
echo "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce  $temporary/node.tar.xz" | sha256sum --check
install -d -m 0755 /opt/oi-station/node
tar -xJf "$temporary/node.tar.xz" -C /opt/oi-station/node --strip-components=1
export PATH=/opt/oi-station/node/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd "$app"
npm ci --ignore-scripts
node scripts/prepare-vendor.mjs
python3.12 -m venv /opt/oi-station/venv
/opt/oi-station/venv/bin/python -m pip install --require-hashes -r deploy/inspection/requirements.lock
/opt/oi-station/venv/bin/python -m pip install --no-build-isolation --no-deps ./services/vision
/opt/oi-station/venv/bin/python -m pip check
chown -R root:root /opt/oi-station
install -m 0755 deploy/inspection/mcp.sh /usr/local/bin/oi-station-mcp
install -m 0644 deploy/inspection/oi-station*.service deploy/inspection/oi-station*.timer /etc/systemd/system/
install -d -m 0755 /etc/systemd/journald@oi-station.conf.d
install -m 0644 deploy/inspection/journald.conf /etc/systemd/journald@oi-station.conf.d/limits.conf
# Ubuntu's administrative account retains its normal privileges; this also makes
# the exact stdio entry point available noninteractively without passing tokens.
printf 'ubuntu ALL=(root) NOPASSWD: /usr/local/bin/oi-station-mcp ""\n' > "$temporary/sudoers"
visudo -cf "$temporary/sudoers"
install -m 0440 "$temporary/sudoers" /etc/sudoers.d/oi-station-mcp
{ printf 'ApplicationCommit=%s\n' "$release"; node --version; python3.12 --version; /opt/oi-station/venv/bin/python -m pip freeze; } > /opt/oi-station/installed.txt
systemctl daemon-reload
systemctl enable oi-station.service oi-station-health.timer
if $start; then systemctl start oi-station.service oi-station-health.timer; fi
