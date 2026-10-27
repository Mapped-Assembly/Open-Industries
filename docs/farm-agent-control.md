# Agent control of the sample farm

## One-screen demo

Open the AWS tunnel at **http://127.0.0.1:8795**. Click **New run**, then
**Start harvest**. The deterministic server-owned controller moves through all
three beds, captures fresh OpenCV evidence before each harvest, verifies the
deposits, and returns home. **Pause** and **Resume** persist across service restarts;
closing the browser does not stop the run. Before/after images appear beside the
live 3D view. Allow about 80 seconds for the complete route and captures.

The buttons invoke **automated control, not an LLM**. The separately recorded
model-issued MCP run remains preserved. New run archives the prior run identity
and state in SQLite while retaining all jobs, command receipts and image bytes.
An active run must finish before New run is available. Revision checks reject stale
controls, and request UUIDs make repeated identical submissions idempotent.

Browser controls use a separate random capability, exact loopback Host/Origin
checks and a custom header. The service bearer token is never embedded in HTML.
The original bearer-authenticated MCP operations remain available. Evidence and
run history persist in the same private state directory. The existing station-wide
limits (256 images / 1,000 MCP receipts) still apply; reaching a limit stops automation
for review and never deletes old evidence.

**Live status:** deployed on the existing AWS host. The OpenCode agent directly
completed all three harvests and returned the robot home through the new MCP tools.
[Observed model-issued run, images and restart verification](evidence/farm-agent-aws/README.md).
The `farm` MCP connection is configured in this project's OpenCode configuration.

The original ASTRA quadruped + mounted SO-101 farm is now available through the
Open Industries MCP host. The adapter imports the original MuJoCo model builder,
joint-limited harvest choreography and browser mesh exporter from
`isayahc/Spooky-Civic-AI-Hackathon` commit
`523d1f5a54b5b279d6d2ae9fcb8b5315b15573aa`. It does not depend on that repository's
auto-looping HTTP server, calibration tools, physical arm integration or `.env`.

**This controls the simulated robot, not physical hardware.** The agent selects
bounded movement/harvest segments; the existing inverse-kinematic trajectory performs
the segment. Produce attachment/release is scripted, not contact-validated grasping.
The runtime starts idle, never loops, and cannot accept arbitrary joint angles,
coordinates, URLs, file paths or a caller-specified simulation time.

## Agent workflow

| MCP tool | Purpose |
| --- | --- |
| `astra.farm_read` | Current pose, revision, active job, deposited crops and next action |
| `astra.farm_capture` | Render a bed's actual MuJoCo pixels and analyze the fixed pickup ROI with OpenCV |
| `astra.farm_read_frame` | Read the persisted observation and original PNG as MCP image content |
| `astra.farm_command` | `move_to_next_bed`, `harvest`, `return_home`, `pause`, or `resume` |
| `astra.farm_read_job` | Durable progress, before/after image references and harvest verification |

The bounded route is **bed 2 (carrots), bed 1 (lettuce), bed 0 (tomatoes), home**.
Each move and each harvest needs a separate agent command. The agent may pause or
resume an active job. Starting a viewer or disconnecting MCP neither starts nor
cancels robot work. The demo's New run control retains the previous run and its
evidence; no reset command is exposed through MCP.

Example agent instructions:

> Read the farm. Follow its next action one segment at a time. Before each harvest,
> capture the indicated bed, read the image, and inspect its OpenCV evidence. Use a
> fresh UUID and the current expected_revision for each new command. Reuse the exact
> UUID and payload on an uncertain reply. Poll farm_read_job until completed. Stop
> on needs_review or a failed check; do not issue a replacement job to hide a failure.
> Finish only after all three deposits are verified and the robot returns home.

Example harvest request after moving and capturing:

```json
{
  "command_id": "REPLACE_WITH_NEW_UUID",
  "expected_revision": 2,
  "action": "harvest",
  "observation_id": "REPLACE_WITH_CURRENT_CAPTURE_UUID"
}
```

The service requires evidence from the same bed, stationary pose and revision,
captured within 60 seconds, with sufficient color pixels in the pickup ROI. Old or
missing evidence cannot authorize a harvest. OpenCV detects a **color candidate at a
known simulated location**, not crop identity, ripeness or physical graspability.
The crop names are fixture metadata. Completion compares source/post-action image
hashes, verifies reduced pickup color and checks the simulated deposited-item state.
A failed post-action check becomes `needs_review` and blocks subsequent movement.

## Run locally

On Linux with Python 3.12, Node 22.18+ and software EGL libraries:

```bash
sudo apt-get install libegl1 libegl-mesa0 libgl1-mesa-dri
git clone https://github.com/isayahc/Spooky-Civic-AI-Hackathon.git /tmp/oi-farm-source
git -C /tmp/oi-farm-source checkout --detach 523d1f5a54b5b279d6d2ae9fcb8b5315b15573aa
python3.12 -m venv .venv-farm
.venv-farm/bin/python -m pip install --require-hashes -r deploy/farm/requirements.lock
.venv-farm/bin/python -m pip install --no-build-isolation --no-deps ./services/vision
npm ci
MUJOCO_GL=egl EGL_PLATFORM=surfaceless LIBGL_ALWAYS_SOFTWARE=1 OPENBLAS_NUM_THREADS=1 \
  .venv-farm/bin/python -m oi_vision.farm_cli serve --source /tmp/oi-farm-source \
  --state-dir .astra/farm --port 8794
```

Open `http://127.0.0.1:8794` to view the original farm geometry and current robot pose.
The viewer includes capability-protected demo controls. MCP mutation/capture
endpoints require a private bearer token and reject browser-origin requests.
The HTTP service binds only `127.0.0.1`.

Add a local stdio server to your existing agent configuration:

```json
{
  "command": "/ABSOLUTE/PATH/.venv-farm/bin/python",
  "args": ["-m", "oi_vision.farm_cli", "mcp", "--root", "/ABSOLUTE/OI/ROOT",
           "--state-dir", "/ABSOLUTE/OI/ROOT/.astra/farm"]
}
```

The wrapper reads its service token from the private state directory; tokens are not
copied into agent configuration. Preserve your existing model/provider settings.

## Install alongside the AWS inspection station

Use the existing `oi-inspection` SSH alias. This reuses the same CPU-only EC2 host
and its pinned Node binary; the farm has separate app, account, database and Python
environment. Keep the inspection app's saved root binding intact.

```bash
# Set this to the reviewed full OI farm-adapter commit, pushed to Mapped-Assembly.
RELEASE=REPLACE_FULL_COMMIT
ssh oi-inspection "sudo git clone https://github.com/Mapped-Assembly/Open-Industries.git /opt/oi-farm/app && \
  sudo git -C /opt/oi-farm/app checkout --detach $RELEASE && \
  sudo bash /opt/oi-farm/app/deploy/farm/install.sh $RELEASE"
```

No new EC2, public IP, security-group ingress or model subscription is needed. Rendering
and active control add CPU usage to the existing Unlimited-credit instance. Idle farm
state does not continuously render images or replay an automatic harvesting loop.
Existing eligible AWS credits apply to usage, subject to their terms and expiration.

Agent command:

```bash
ssh -T oi-inspection sudo -n /usr/local/bin/oi-farm-mcp
```

View the live farm through an authenticated tunnel:

```bash
ssh -N -L 8794:127.0.0.1:8794 oi-inspection
# Open http://127.0.0.1:8794 on this machine.
```

Use another local port, e.g. `8795:127.0.0.1:8794`, if a local farm is already running.

## State and operation

- `/var/lib/oi-farm/state/farm.sqlite`: station identity, saved source binding,
  simulation progress, active job, immutable command receipts, mutable job results,
  observations and image bytes in one SQLite database.
- `/var/lib/oi-farm/state/connection.json`: private bearer token and saved port.
- Service: `oi-farm.service`; user: `oi-farm`; root-owned app: `/opt/oi-farm/app`;
  pinned original farm source: `/opt/oi-farm/source`.
- Restart resumes active work from the last checkpoint. Downtime does not advance
  simulated time. Paused jobs stay paused. Bounds: 1,000 command receipts and 256
  images per station, with space reserved for a harvest's follow-up image.

```bash
ssh oi-inspection 'sudo systemctl status oi-farm --no-pager'
ssh oi-inspection 'sudo journalctl -u oi-farm --since "1 hour ago" --no-pager'
ssh oi-inspection 'sudo systemctl restart oi-farm'
ssh oi-inspection 'sudo systemctl stop oi-farm'
```

The systemd MCP wrapper is tied to farm lifecycle, so stopping the station also stops
its clients. Runtime and wrapper errors do not expose private tokens in MCP results.
Persistent worker errors stop the service for bounded systemd recovery.

For a coherent backup, disconnect agent clients, take an exclusive
`/run/lock/oi-farm-maintenance.lock`, stop `oi-farm`, and archive the entire
`/var/lib/oi-farm/state` directory. Keep the archive private: it contains the token.
Restore while stopped to the same absolute paths with matching source/application
commits; quarantine the current directory first, and restore ownership to `oi-farm`.
Do not edit command receipts or replace only part of the database to restart a job.

After exporting evidence, an operator can explicitly start a **new** simulated farm
while retaining the completed one. Disconnect clients first, then on the host:

```bash
sudo bash <<'SH'
set -euo pipefail
exec 9>/run/lock/oi-farm-maintenance.lock
flock --exclusive --nonblock 9
systemctl stop oi-farm
mv /var/lib/oi-farm/state /var/lib/oi-farm/completed-$(date -u +%Y%m%dT%H%M%SZ)
systemctl start oi-farm
SH
```

This creates a new station identity and service token, not an idempotent retry of
the old mission. Reconnect MCP afterward. Never use it to conceal an uncertain job.

Upgrades: stop, back up, fetch/checkout the reviewed full OI commit at the same
`/opt/oi-farm/app` path, then run its installer. Keep the pinned farm-source commit.
Disable the farm with `sudo systemctl disable --now oi-farm` before removing its
app or private state. The shared EC2 instance and retained EBS continue to incur
usage until handled through the inspection deployment's teardown procedure.

## Verification

```bash
OI_FARM_SOURCE=/tmp/oi-farm-source MUJOCO_GL=egl EGL_PLATFORM=surfaceless \
  python -m unittest discover -s services/vision/tests -p test_farm.py -v
OI_VISION_MCP_TESTS=1 python -m unittest discover -s services/vision/tests -v
npm run test:mcp
python -m oi_vision.farm_evidence --root "$PWD" \
  --command '["ssh","-T","oi-inspection","sudo","-n","/usr/local/bin/oi-farm-mcp"]' \
  --output .astra/farm-evidence
```

The last command operates a fresh station through the real MCP entry point: seven
segments, three OpenCV-gated harvests, pause/resume, disconnect/reconnect, idempotency
and six before/after PNGs. It is a deterministic controller, not a model-driven run.
Unit tests separately prove absent/stale evidence and stale revisions cannot create
jobs, unauthorized/browser-origin HTTP cannot command motion, and in-flight state
survives runtime restart. Tests may advance an injected clock; production tools cannot.
