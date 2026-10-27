#!/bin/bash
# Install on the existing Ubuntu 24.04 inspection host using its pinned Node binary.
set -euo pipefail
[[ $EUID == 0 && $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || exit 64
export PATH=/opt/oi-station/node/bin:/usr/sbin:/usr/bin:/sbin:/bin
app=/opt/oi-farm/app
source=/opt/oi-farm/source
release=$1
[[ $(realpath "$app") == "$app" && $(git -C "$app" rev-parse HEAD) == "$release" ]]
exec 9>/run/lock/oi-farm-maintenance.lock
flock --exclusive --nonblock 9
if systemctl is-active --quiet oi-farm.service; then
  echo 'Stop and back up the farm before installing.' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y libegl1 libgl1 libegl-mesa0 libgl1-mesa-dri python3.12-venv
id oi-farm >/dev/null 2>&1 || useradd --system --home-dir /var/lib/oi-farm --shell /usr/sbin/nologin oi-farm
install -d -m 0700 -o oi-farm -g oi-farm /var/lib/oi-farm
if [[ ! -d $source/.git ]]; then
  git clone https://github.com/isayahc/Spooky-Civic-AI-Hackathon.git "$source"
fi
git -C "$source" checkout --detach 523d1f5a54b5b279d6d2ae9fcb8b5315b15573aa
cd "$app"
npm ci --ignore-scripts
python3.12 -m venv /opt/oi-farm/venv
/opt/oi-farm/venv/bin/python -m pip install --require-hashes -r deploy/farm/requirements.lock
/opt/oi-farm/venv/bin/python -m pip install --no-build-isolation --no-deps ./services/vision
/opt/oi-farm/venv/bin/python -m pip check
chown -R root:root /opt/oi-farm
install -m 0644 deploy/farm/oi-farm.service /etc/systemd/system/
install -m 0755 deploy/farm/mcp.sh /usr/local/bin/oi-farm-mcp
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT
printf 'ubuntu ALL=(root) NOPASSWD: /usr/local/bin/oi-farm-mcp ""\n' > "$temporary"
visudo -cf "$temporary"
install -m 0440 "$temporary" /etc/sudoers.d/oi-farm-mcp
systemctl daemon-reload
systemctl enable --now oi-farm.service
for attempt in {1..60}; do
  if curl --fail --silent http://127.0.0.1:8794/health; then exit 0; fi
  sleep 1
done
exit 1
