#!/usr/bin/env bash
# Runs only on a disposable Ubuntu CI host; no cloud services or Caddy required.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Requires a disposable CI runner' >&2; exit 1; }
sudo ln -sf "$(command -v node)" /usr/local/bin/node
sudo python3 scripts/install_local_runtime.py --source "$PWD"
ready() {
  for attempt in {1..30}; do
    if python3 scripts/runtime_health.py http://127.0.0.1:4193; then return; fi
    sleep 1
  done
  return 1
}
ready
sudo systemctl is-enabled oi-local
# Inspect identity and resources through the real authenticated API, without logging credentials.
sudo python3 - <<'PY'
import json, urllib.request
from pathlib import Path
config = json.loads(Path('/var/lib/open-industries/local-lab/client.json').read_text())
def read():
    req = urllib.request.Request(config['origin']+'/lab-api/read', headers={'Authorization':'Bearer '+config['token']})
    with urllib.request.urlopen(req) as response: return json.load(response)['snapshot']
Path('/tmp/oi-local-before.json').write_text(json.dumps(read()))
PY
previous_pid=$(sudo systemctl show oi-local --property=MainPID --value)
sudo systemctl kill --kill-whom=main --signal=SIGKILL oi-local
for attempt in {1..30}; do
  current_pid=$(sudo systemctl show oi-local --property=MainPID --value)
  if [[ "$current_pid" != 0 && "$current_pid" != "$previous_pid" ]]; then break; fi
  sleep 1
done
[[ "$current_pid" != 0 && "$current_pid" != "$previous_pid" ]]
ready
sudo systemctl restart oi-local
ready
sudo python3 - <<'PY'
import json, urllib.request
from pathlib import Path
config = json.loads(Path('/var/lib/open-industries/local-lab/client.json').read_text())
req = urllib.request.Request(config['origin']+'/lab-api/read', headers={'Authorization':'Bearer '+config['token']})
with urllib.request.urlopen(req) as response: after = json.load(response)['snapshot']
before = json.loads(Path('/tmp/oi-local-before.json').read_text())
assert after['instance_id'] == before['instance_id']
assert after['jobs'][0]['progress_ms'] >= before['jobs'][0]['progress_ms']
print('Installed service retained instance and progress after SIGKILL and restart.')
PY
