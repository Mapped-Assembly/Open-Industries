#!/usr/bin/env bash
# CI-only integration on a disposable systemd host. Never run on an existing deployment.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  echo 'This installation smoke test requires a disposable GitHub Actions runner.' >&2
  exit 1
fi
sudo useradd --system --home-dir /var/lib/open-industries --shell /usr/sbin/nologin oi-runtime
sudo install -d /opt/open-industries/current
# Copy instead of linking: ProtectHome must not expose /home/runner to the service.
sudo cp -a server node_modules packages scripts benchmarks /opt/open-industries/current/
sudo cp package.json tsconfig.json /opt/open-industries/current/
sudo ln -sf "$(command -v node)" /usr/local/bin/node
sudo install -d -m 0700 /etc/open-industries
sudo install -m 0600 deploy/runtime/runtime.env.example /etc/open-industries/runtime.env
sudo install -m 0644 deploy/runtime/oi-runtime*.service deploy/runtime/oi-runtime-health.timer /etc/systemd/system/
sudo install -d /etc/systemd/journald@oi-runtime.conf.d
sudo install -m 0644 deploy/runtime/journald.conf /etc/systemd/journald@oi-runtime.conf.d/limits.conf
sudo systemctl daemon-reload
sudo systemctl enable --now oi-runtime.service oi-runtime-health.timer
for attempt in {1..20}; do
  if python3 scripts/runtime_health.py http://127.0.0.1:8791; then break; fi
  sleep 1
done
python3 scripts/runtime_health.py http://127.0.0.1:8791
sudo systemctl start oi-runtime-health.service
sudo systemctl is-enabled oi-runtime.service

# A new PID plus successful readiness proves Restart=on-failure is effective.
previous_pid=$(sudo systemctl show oi-runtime --property=MainPID --value)
sudo systemctl kill --kill-whom=main --signal=SIGKILL oi-runtime.service
for attempt in {1..20}; do
  current_pid=$(sudo systemctl show oi-runtime --property=MainPID --value)
  if [[ "$current_pid" != 0 && "$current_pid" != "$previous_pid" ]] && python3 scripts/runtime_health.py http://127.0.0.1:8791; then break; fi
  sleep 1
done
[[ "$current_pid" != 0 && "$current_pid" != "$previous_pid" ]]
python3 scripts/runtime_health.py http://127.0.0.1:8791
sudo test -f /var/lib/open-industries/work-cell.sqlite
sudo systemctl restart oi-runtime.service
for attempt in {1..20}; do
  if python3 scripts/runtime_health.py http://127.0.0.1:8791; then break; fi
  sleep 1
done
python3 scripts/runtime_health.py http://127.0.0.1:8791

# Exercise the identical route policy over local HTTP. Real TLS needs real DNS.
sed 's/runtime.example.com/http:\/\/127.0.0.1:18891/' deploy/runtime/Caddyfile > /tmp/oi-Caddyfile
sudo install -m 0644 /tmp/oi-Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
python3 scripts/runtime_health.py http://127.0.0.1:18891
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18891/auth/register)" == 404 ]]
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"instance_id":"unknown"}' http://127.0.0.1:18891/simulation/read)" == 401 ]]
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://example.com' http://127.0.0.1:18891/health)" == 400 ]]
