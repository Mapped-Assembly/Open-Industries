# Optional remote work-cell deployment

This deployment runs the existing **work-cell** service under systemd, with Caddy
terminating HTTPS. Jobs advance with no browser or MCP client connected. SQLite state
lives outside the release checkout and survives process restarts and compatible redeploys.
This is a deployment recipe, not evidence that a public server has been provisioned.
This optional remote deployment is not a completion gate for #52. For the default local
FIELD-LAB service, use [local persistent runtime](persistent-runtime.md).

## Host and storage

Use one Linux machine with systemd 245+, Node 22.16+ installed system-wide, npm, Python
3.10+, Git, and Caddy 2. A local machine must stay powered on and connected. A cloud VM
needs a persistent **local filesystem** (not a shared/network SQLite volume). No GPU is
needed for the supplied modeled work-cell. Capacity must be measured with your workload;
this does not promise a particular memory size or number of concurrent simulations.

| Item | Location / status |
| --- | --- |
| Host/provider, region and monthly cost | Not selected; record VM, disk, backup and egress costs before provisioning |
| DNS | Replace `runtime.example.com` with a domain pointing to the selected host |
| Immutable releases | `/opt/open-industries/releases/<commit>` |
| Active release symlink | `/opt/open-industries/current` |
| Runtime account | `oi-runtime` (no login shell) |
| Database, WAL, SHM and future runtime assets | `/var/lib/open-industries/` (private, persistent) |
| Server configuration | `/etc/open-industries/runtime.env` (root-owned, mode 0600) |
| Backups | `/var/backups/open-industries/`; additionally copy encrypted backups off host |
| Runtime logs | Journal namespace `oi-runtime`, capped at 100 MiB persistent / 32 MiB volatile, 14 days |

Only one service owns each database. Keep releases root-owned and read-only to the
runtime account. Do not put provider keys or runtime session tokens in `VITE_*` variables,
Git, browser storage, logs, or shell history. No provider keys are needed for this fixture.

## Install a pinned release

Run these commands on the selected host. Install Node/npm and Caddy through their official
installation instructions first; Node must resolve through `/usr/local/bin:/usr/bin:/bin`
for the service (a user-only nvm installation will not work).

```bash
sudo useradd --system --home-dir /var/lib/open-industries --shell /usr/sbin/nologin oi-runtime
sudo install -d -m 0755 /opt/open-industries/releases
sudo install -d -m 0700 /etc/open-industries
sudo install -d -m 0700 -o oi-runtime -g oi-runtime /var/lib/open-industries /var/backups/open-industries

# Set this to the reviewed full commit SHA, not a moving branch.
OI_RELEASE='<full-commit-sha>'
git clone https://github.com/Mapped-Assembly/Open-Industries.git oi-release
cd oi-release
git checkout --detach "$OI_RELEASE"
npm ci
npm run test:runtime-deployment
sudo cp -a . "/opt/open-industries/releases/$OI_RELEASE"
sudo chown -R root:root "/opt/open-industries/releases/$OI_RELEASE"
sudo ln -s "/opt/open-industries/releases/$OI_RELEASE" /opt/open-industries/current
sudo install -m 0600 deploy/runtime/runtime.env.example /etc/open-industries/runtime.env
sudo install -m 0644 deploy/runtime/oi-runtime.service deploy/runtime/oi-runtime-health.service deploy/runtime/oi-runtime-health.timer /etc/systemd/system/
sudo install -d -m 0755 /etc/systemd/journald@oi-runtime.conf.d
sudo install -m 0644 deploy/runtime/journald.conf /etc/systemd/journald@oi-runtime.conf.d/limits.conf
sudo systemctl daemon-reload
sudo systemctl enable --now oi-runtime.service oi-runtime-health.timer
python3 scripts/runtime_health.py http://127.0.0.1:8791
```

`StateDirectory` and the explicit absolute database path prevent redeploys from creating a
fresh database accidentally. The service receives SIGTERM directly, closes its worker and
database, and restarts on failure after five seconds. Repeated startup failures are bounded;
inspect logs and use `systemctl reset-failed oi-runtime` after fixing configuration.

## Provision an account, then enable HTTPS

Leave the Caddy site disabled until initial provisioning is complete. The API listens on
loopback only. Temporarily set `ASTRA_SIMULATION_ALLOW_SIGNUP=true` in the root-owned env
file, restart `oi-runtime`, and run the following **on the server**, or through an SSH
session. It reads the password without echoing and does not print the session token:

```bash
python3 - <<'PY'
import getpass, json, urllib.request
body = json.dumps({"username": input("Username: "), "password": getpass.getpass("Password (12+ characters): ")}).encode()
request = urllib.request.Request("http://127.0.0.1:8791/auth/register", data=body, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(request, timeout=10) as response:
    session = json.load(response)
request = urllib.request.Request("http://127.0.0.1:8791/auth/logout", data=b"{}", headers={"Content-Type": "application/json", "Authorization": "Bearer " + session["token"]})
with urllib.request.urlopen(request, timeout=10):
    print("Account provisioned; provisioning session revoked.")
PY
```

Set signup back to `false` and restart. Confirm `/health` reports
`registration_enabled: false`. Provision later accounts through the same private process.

Replace the example hostname in `deploy/runtime/Caddyfile`, then add that site block to
the host's existing Caddy configuration (do not overwrite other sites). On a dedicated
new host, it can be installed as `/etc/caddy/Caddyfile`. Allow inbound TCP 80/443 for HTTPS
and the certificate challenge, plus restricted administrative SSH access. Do not expose
8791, 8792 or database files. Validate before reloading:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
python3 scripts/runtime_health.py https://runtime.example.com
```

Caddy always blocks public `/auth/register`; it preserves Origin and Authorization headers.
The runtime continues to reject browser Origins, query strings, invalid bodies and invalid
sessions. Caddy does not retry mutation requests. Login throttling currently groups proxied
requests under the loopback address (30 attempts/minute total); do not trust arbitrary
forwarded-IP headers to bypass it. This is a small deployment, not a public identity service.

## Connect an application or agent

An application backend logs in via `POST /auth/login` with JSON username/password and keeps
the returned session private. Sessions expire after eight hours: reauthenticate on expiry;
do not resubmit an uncertain command with a new command ID. Exact retries use the original
ID, expected revision and payload. A new browser session should retrieve the saved instance
through its application backend. Browser-to-runtime authentication/proxy UI is not added here.

For the existing MCP work-cell adapter, configure its **server-side** environment:

```text
ASTRA_SIMULATION_TOOLS_ENABLED=true
ASTRA_SIMULATION_SERVICE_URL=https://runtime.example.com
ASTRA_SIMULATION_SESSION=<token returned by server-side login>
```

Use `astra.simulation_create_work_cell`, `astra.simulation_read`,
`astra.simulation_command` and `astra.simulation_history`. The adapter's session must be
renewed on expiry. See [shared runtime adoption](architecture/shared-runtime-adoption.md)
for full HTTP request shapes and finite limits (three instances/account, eight retained
jobs/instance, 256 normal receipts). This fixture is intentionally finite, not an unlimited
production workflow. History cursors can expire; get a fresh snapshot in that case.

## Health and logs

`GET /health` returns 200 only while the database heartbeat is fresh; a stale heartbeat
returns 503. Storage/read failures also return 503. Worker failure and recovery transitions
are logged without raw exceptions or credentials. Caddy checks readiness every ten seconds;
a systemd timer independently checks every thirty seconds. The timer reports failure; it
does not silently reset a database or restart a persistently broken worker.

```bash
sudo systemctl status oi-runtime oi-runtime-health.timer oi-runtime-health.service
sudo journalctl --namespace=oi-runtime -u oi-runtime -u oi-runtime-health --since '1 hour ago'
sudo journalctl --namespace=oi-runtime --disk-usage
df -h /var/lib/open-industries /var/backups/open-industries
```

Connect these checks to the host's alerting system. No notification provider is provisioned
by this recipe. A green process alone is not proof of worker readiness.

## Backup, restore and upgrades

The Python standard-library tool uses SQLite's online backup API, including committed WAL
content, checks integrity, and creates a private standalone database. It refuses an existing
destination and bounds lock waits. Do not copy a live `.sqlite` file without its WAL.

```bash
OI_BACKUP="/var/backups/open-industries/work-cell-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sudo -u oi-runtime python3 /opt/open-industries/current/scripts/runtime_backup.py \
  /var/lib/open-industries/work-cell.sqlite "$OI_BACKUP"
readlink -f /opt/open-industries/current
```

Record that exact release path/commit with the backup. Back up before each deployment and
regularly according to your required recovery window. Keep at least one tested copy off-host;
monitor disk usage and apply an explicit retention policy (for example 14 daily copies).
This PR does not schedule backup deletion or configure off-host credentials.

Test restores into a **new isolated directory**, using the exact matching release and a
separate loopback port. Copy with the same backup tool and start with signup disabled:

```bash
sudo -u oi-runtime mkdir -m 0700 /var/lib/open-industries/restore-check
sudo -u oi-runtime python3 /opt/open-industries/current/scripts/runtime_backup.py \
  "$OI_BACKUP" /var/lib/open-industries/restore-check/work-cell.sqlite
cd /opt/open-industries/current
sudo -u oi-runtime env ASTRA_SIMULATION_DB=/var/lib/open-industries/restore-check/work-cell.sqlite \
  ASTRA_SIMULATION_PORT=18791 ASTRA_SIMULATION_ALLOW_SIGNUP=false \
  /usr/bin/env node --import tsx server/simulation-service.ts
```

Log in and read a known instance, history and resource balance. Catch-up may advance modeled
jobs on startup; compare terminal state or account for elapsed time. The automated deployment
test proves restored terminal results and command receipts. Do not connect an isolated
restore to physical equipment or external side-effect consumers.

For a production restore, stop the service first. Move the complete current DB/WAL/SHM set
to a private quarantine directory, then restore the backup to the now-unused configured DB
path. Keep ownership `oi-runtime:oi-runtime` and mode 0600. Never merge tables, newer receipts
or old resource balances. Verify the matching release before starting. Restoration discards
work after the backup.

For an upgrade, prepare and test a new immutable release, stop the service, take a complete
backup, and switch `current` atomically using a temporary symlink and `mv -Tf` on Linux.
Start and check readiness plus a known instance. If incompatible, stop again and restore
both the old binary and its full compatible backup. Unknown schema/module pins must fail
closed. Never run old and new services against the same database during an upgrade.

## Other domains

The supplied unit proves work-cell deployment. FIELD-LAB can use a separate copy of the
unit with `ExecStart` pointing to `server/field-lab-service.ts`, its own env file, and
`ASTRA_FIELD_LAB_DB`, `ASTRA_FIELD_LAB_PORT` (8792) and
`ASTRA_FIELD_LAB_ALLOW_SIGNUP=false`. Give it a separate health unit/timer and HTTPS hostname
pointing to its port. Its schema 101 database must never be shared with work-cell schema 100.
The game has its own `server/game-service.mjs` entry point and configuration documented in
[mcp-game-runtime.md](mcp-game-runtime.md); do not assume its transport/schema is interchangeable.
These alternate deployment configurations are not exercised by the work-cell deployment test.

Garden behavior, robot control and live scene synchronization are separate domain work.
Simulation catch-up cannot stand for physical actions performed while equipment was offline.

## Live acceptance record (fill in on the selected host)

- [ ] Record host, region, monthly cost, DNS, release SHA, storage and backup destination.
- [ ] Create an instance/job; disconnect all clients and verify independent progression.
- [ ] Reconnect with a fresh login; check the same instance, balances and history.
- [ ] Kill the process; verify systemd restarts it and results/spending are not duplicated.
- [ ] Reboot the host; verify enabled service startup, HTTPS and preserved state.
- [ ] Redeploy a compatible release; verify existing state and immutable command retries.
- [ ] Restore a complete backup into an isolated service and verify a known instance.
- [ ] Reject unauthenticated and cross-account reads; verify public signup remains blocked.
- [ ] Exercise failed health monitoring and check logs, disk limits and off-host recovery.

Local/CI process tests cannot substitute for host reboot, real certificate issuance,
provider billing, firewall configuration, or an actual off-host backup. These checks apply
only when choosing remote hosting; they are not requirements for local issue #52.

References: [systemd service options](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Python SQLite backup](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup).
