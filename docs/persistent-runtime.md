# Local persistent runtime

Run FIELD-LAB on your own computer. The worker, built 3D viewer and MCP bridge share
one authoritative SQLite instance. AWS, cloud accounts, public DNS, public TLS and
model-provider credentials are **not required**. Internet access is needed to obtain
the source and npm dependencies; normal modeled execution runs locally afterward.

## Install on Linux

The first service target is Ubuntu 24.04 with systemd 245+, Python 3.10+, Git, npm and
Node 22.16+ installed in `/usr/bin` or `/usr/local/bin`. A home-directory nvm install
is not accessible to the hardened service. Use a local filesystem, not NFS/SMB.
Run from a clean checkout of a reviewed commit:

```bash
npm ci
npm run test:local-runtime
sudo python3 scripts/install_local_runtime.py --source "$PWD"
python3 scripts/runtime_health.py http://127.0.0.1:4193
```

Open **http://127.0.0.1:4193/** and click Connect / reconnect. Installation explicitly
creates the baseline automatic simulated task once. Opening/reopening the page does
not initialize anything. Missing identity, database or assets produces an actionable
startup failure instead of silently replacing your work. The foreground developer
command remains `npm run field-lab:viewer`; its default state is now
`~/.local/share/open-industries/field-lab`, separate from the installed service.
To reopen a preexisting checkout-local save, set `FIELD_LAB_VIEWER_STATE_DIR` explicitly.

The installer copies a pinned release into `/opt/open-industries/local-releases/<sha>`
and selects `/opt/open-industries/local-current`. It creates the unprivileged
`oi-runtime` account, enables `oi-local.service` for host startup and starts it now.
Closing the installation terminal has no effect on systemd. No browser or agent is
required to drive ticks. A failed process restarts after five seconds, with a bounded
restart rate; SIGTERM closes HTTP and SQLite gracefully. A kernel file lock prevents
two installed service processes from owning the same station.

| Operation | Command |
| --- | --- |
| Start / stop | `sudo systemctl start oi-local` / `sudo systemctl stop oi-local` |
| Status / PID | `sudo systemctl status oi-local --no-pager` |
| Readiness | `python3 scripts/runtime_health.py http://127.0.0.1:4193` |
| Logs | `sudo journalctl --namespace=oi-local -u oi-local -n 100 --no-pager` |
| Follow logs | `sudo journalctl --namespace=oi-local -u oi-local -f` |
| Retry after fixing failure | `sudo systemctl reset-failed oi-local && sudo systemctl start oi-local` |
| Disable host startup | `sudo systemctl disable --now oi-local` |

The dedicated journal is capped at 100 MiB persistent / 32 MiB volatile with 14-day
retention and rate-limited service output. `/health` checks the stored worker heartbeat;
a stale heartbeat yields 503. Storage/worker failure exits nonzero for supervisor
recovery. Port conflicts, absent builds, incompatible saves and missing assets fail
startup. Inspect the journal; do not delete state to make a failure disappear.

## State, access and MCP

`/var/lib/open-industries/local-lab` is private (0700), outside every release. Keep
`lab.sqlite`, WAL/SHM, `operator.json`, `session.json`, `client.json` and `assets/`
together. SQLite retains transactional commands, resource accounting, receipts and
retained history. Assets are frozen at explicit initialization and preserved on upgrades.
The service renews its database session after unattended expiry.

HTTP binds only to `127.0.0.1:4193`. The local browser is an operator surface: a person
or process on this computer can open it. It is not multi-user isolation from other
local OS users. Strict Host/Origin checks reject foreign browser requests and control
POSTs require same-origin JSON. No account passwords or bearer tokens enter browser
storage. Do not expose this port through a public proxy. Remote access is a separate
[optional deployment](remote-runtime.md).

The MCP bridge authenticates with a private capability file, and cannot select another
instance or create a new task. Copy the client capability to your own private config:

```bash
install -d -m 0700 "$HOME/.config/open-industries"
sudo install -m 0600 -o "$(id -un)" -g "$(id -gn)" \
  /var/lib/open-industries/local-lab/client.json "$HOME/.config/open-industries/client.json"
```

Configure your MCP client with absolute paths (replace `/home/YOU`; use
`/usr/local/bin/node` if that is where your supported Node is installed):

```json
{
  "mcpServers": {
    "oi-local": {
      "command": "/usr/bin/node",
      "args": ["/opt/open-industries/local-current/server/astra-mcp.mjs"],
      "env": {"OI_LOCAL_CLIENT_FILE": "/home/YOU/.config/open-industries/client.json"}
    }
  }
}
```

Use `astra.local_lab_read`, `astra.local_lab_history` and `astra.local_lab_command`.
Read first, then send a pause/resume/fail/cancel command with the current revision,
job ID and a unique command ID. Reuse the exact command after an uncertain response;
receipts prevent duplicate spending. Closing MCP stops only its transport process.
General chat planning and device execution remain #54 and #56.

## Complete backup, isolated restore, upgrade and rollback

Back up while the service is running using SQLite's online backup API. Do not copy
only the main database file while WAL mode is active. Do not rotate identity/assets
concurrently with a backup. The destination must not exist and its parent must exist:

```bash
sudo install -d -m 0700 /var/backups/open-industries
sudo python3 scripts/local_runtime_backup.py /var/lib/open-industries/local-lab \
  /var/backups/open-industries/local-before-upgrade
sudo python3 scripts/local_runtime_backup.py /var/backups/open-industries/local-before-upgrade \
  /var/lib/open-industries/local-restored
sudo chown -R oi-runtime:oi-runtime /var/lib/open-industries/local-restored
```

This validates schema 101, SQLite integrity and the bound instance, and includes
credentials, configuration and frozen scene assets. Protect backups like credentials.
Record the active release SHA (`cat /opt/open-industries/local-current/RELEASE`) beside
the backup. Test the restored copy without touching the original, using another port:

```bash
cd /opt/open-industries/local-current
sudo -u oi-runtime env FIELD_LAB_INSTALLED=true \
  FIELD_LAB_VIEWER_STATE_DIR=/var/lib/open-industries/local-restored FIELD_LAB_VIEWER_PORT=4196 \
  /usr/bin/flock --no-fork --nonblock /var/lib/open-industries/local-restored/service.lock \
  /usr/bin/env node --import tsx scripts/field-lab-viewer.ts
```

Open `http://127.0.0.1:4196/`, compare instance ID, jobs, resources and history, then
Ctrl-C. To test MCP against this copy, make a separate private copy of its `client.json`
and change only `origin` to port 4196; never edit the original client's config.

For a compatible upgrade, make the backup above, check out the reviewed new commit,
run `npm ci && npm run test:local-runtime`, then rerun the installer. It preserves
state and receipts, changes the release symlink and restarts the service. No schema
migration or destructive conversion is performed. The runtime rejects incompatible
save versions. To roll back a compatible build:

```bash
sudo systemctl stop oi-local
sudo ln -s /opt/open-industries/local-releases/PRIOR_SHA /opt/open-industries/local-rollback
sudo mv -Tf /opt/open-industries/local-rollback /opt/open-industries/local-current
sudo systemctl start oi-local
python3 scripts/runtime_health.py http://127.0.0.1:4193
```

For an incompatible save, stop first and restore the **complete** backup under a new
directory using its matching release. Preserve the failed save. Change the unit's
state-directory environment and lock path together through a systemd override; run
`daemon-reload` and start. Never run two workers against the same database or replace
live WAL/SHM files. Reinstalling an already-copied SHA reuses its immutable release and saved state.

## Host lifecycle and WSL2

The service is enabled for Linux boot; the computer must be running and awake to
execute. Sleep, power-off and a stopped WSL distro stop execution. On resume, existing
FIELD-LAB modeled catch-up rules apply. These simulated elapsed-time calculations
never establish that a physical action occurred. The fixture has 32 fifteen-minute
slots (eight modeled hours), finite resources and jobs; it does not generate endless
work. The database caps history at 64 events / 2 MiB per instance plus a checkpoint;
older individual events become unavailable. The installed bridge binds one instance;
underlying limits are six instances per account, 256 command receipts per instance,
1,000 accounts and 16 active sessions per account.

WSL2 requires systemd enabled in `/etc/wsl.conf` (`[boot]` then `systemd=true`), followed
by `wsl --shutdown` from Windows and a distro restart. Run the Linux installation
inside that distro on its Linux filesystem. An enabled Linux unit starts when the
distro boots; it does **not** guarantee Windows launches that distro at login, prevent
Windows sleep or guarantee WSL stays running. Windows startup integration is not
installed by this script. If continuous operation is required, use a native awake
Linux host until your WSL lifecycle has passed these checks.

Before claiming host-lifecycle acceptance, record the instance/progress, disconnect
all clients, close the terminal, reopen and compare; kill the unit's main PID with
`sudo systemctl kill --kill-whom=main --signal=SIGKILL oi-local` and confirm a new PID
and intact receipts; reboot Linux and verify readiness and instance identity. For
WSL, separately test `wsl --shutdown` plus distro relaunch and a full Windows reboot,
recording whether manual distro launch was necessary. macOS/Windows native background
installation is not implemented by this service target.

## Verification status

See [local runtime evidence](evidence/local-runtime/README.md). Automated process,
backup, browser and runtime tests are software evidence. CI installs the actual
systemd unit on Ubuntu and checks crash restart. A CI service restart is not evidence
of a machine reboot. #52 stays open until real host-reboot evidence (and the explicit
WSL lifecycle checks if claiming WSL support) is recorded. Cloud provisioning is not
a prerequisite for any of these checks.
