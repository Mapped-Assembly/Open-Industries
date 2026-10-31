# Local embodied chat: first execution milestone

The ordinary workbench now has a **Robot Run** view at `/?run=so101`, with the actual
pinned SO-101 meshes, two selectable tabletop blocks, a chat panel, direct Stop,
Resume, status, saved conversation and evidence export. Run poses come from the
Python authority; animation tracks are empty and the browser never advances jobs.

This delivers the first bounded motion path for #54. It does **not** complete the
epic: contact-based pick/place, camera perception and a separately recorded live-model
run remain outstanding. There is no farming route or scripted attachment here.

## Local setup (Linux / WSL2)

Use Node 22.16+, Python 3.11+ (tested on 3.12), Git and a local filesystem:

```bash
python3 -m venv .venv-embodied
.venv-embodied/bin/python -m pip install -r services/embodied/requirements.txt
npm ci
npm run build

git clone https://github.com/TheRobotStudio/SO-ARM100.git ../SO-ARM100
git -C ../SO-ARM100 checkout --detach a758567c3978dfeefe282ede0500085a48fe8f78
.venv-embodied/bin/python scripts/embodied_runtime.py --source ../SO-ARM100
```

Open `http://127.0.0.1:4197/?run=so101`. No AWS account, model key, public DNS or TLS
is required. Source/dependencies are downloaded once; manual execution is offline.
The launcher validates the complete source lock before loading state. State defaults
to `~/.local/share/open-industries/embodied`; use `--state-dir` to explicitly create
an independent station, or `--port` for an isolated restore. A missing saved database
is an error, not permission to silently replace the run.

1. Select **red block** (dropdown or click the block in the scene).
2. Click **Enter Run mode**.
3. In default **Manual test mode**, enter `approach selected`.
4. Watch the robot move above the block. Use Stop and Resume during movement.
5. Disconnect/reconnect the viewer, or reload: the run, task, conversation and evidence
   remain. The server must remain running. Use **Export trace** for recorded IDs/results.

Other manual commands: `approach blue-block`, `inspect red-block`, `home`, `status`,
`stop`, `resume`. Direct Cancel permits a replacement task; new goals are rejected
while a task is planning/running/paused. No implicit queue or replacement is created.
Manual grammar is deliberately labeled and is not evidence of natural-language control.

Use Leave Run mode after terminal work to edit a selected block's X/Y position in
metres. Save explicitly, then re-enter Run mode. Try the red block at
`[.15,-.05,.015]`, `[.17,-.05,.015]`, and `[.20,0,.015]`; the target is solved each
time, not substituted with a fixed route. Edits cannot alter an active task.

## Connect a model

The backend accepts an operator-configured chat-completions-compatible endpoint.
For an already-running local endpoint, set its URL and installed model name:

```bash
export OI_AGENT_URL='http://127.0.0.1:11434/v1/chat/completions'
export OI_AGENT_MODEL='YOUR_INSTALLED_MODEL'
.venv-embodied/bin/python scripts/embodied_runtime.py --source ../SO-ARM100
```

The example URL is configuration, not a claim that a model is installed. A remote
HTTPS endpoint is optional; only then supply `OI_AGENT_API_KEY` privately if required.
Never use a `VITE_*` variable or place a key in a URL, scene, trace or browser storage.
Credentials remain in the Python process; redirects are refused.

With a configured model, try “Move the gripper above this block,” “Inspect the red
block,” or “Return home.” Model output is a typed `{skill,target_id}` proposal, never
joint angles, object poses, durations or completion flags. The runtime independently
validates capabilities, reference grounding, scene revision, IK, joint limits and
postconditions. Requests for pick/place cannot be reinterpreted as successful approach.
Ambiguous requests ask for a selected or explicitly named block; the model receives
recent conversation for clarification follow-ups.

Budget: one inference/proposal per request, 160 output tokens, 64 KiB response limit,
15-second socket timeout with a 15-second read deadline (a blocked read can extend
that to roughly 30 seconds), no automatic provider retry and no inference per tick.
A provider failure creates a recorded review outcome without dispatch. Stop is handled
under the controller lock and does not wait for inference; late proposals are invalidated.
There is no multi-step planner or contact skill in this first milestone.

## Authority, observations and recovery

The SQLite station contains scene/model pins, joint state, current task, the last 64
terminal tasks, 128 chat messages, 64 observations and 512 ordinary immutable request
receipts, with reserved allowance for a final Stop and Cancel. New goals beyond the
receipt cap fail explicitly; exhaustion never disables Stop. Repeated Stop on an
already-paused controller at capacity is acknowledged without growing storage. Each request has a
caller UUID; each task has a separate UUID and deterministic controller-command UUID.
Retries must reuse the exact envelope. A changed envelope with the same ID is rejected.

The worker advances at nominal 20 Hz; the client polls snapshots at 5 Hz, discarding
older revisions. Lost connectivity shows stale/held state and disables new goals.
Rendering has no independent motion clock. Stop records controller acknowledgement;
the UI may display it after polling/render latency. Test bounds are 250 ms for direct
controller acknowledgement and 1.5 s for the exercised browser path, not a physical
real-time guarantee. Re-observation and pin validation precede Resume.

Observations are explicitly **privileged simulated state**, with run/task IDs, timestamp,
scene revision, model hash, base-link frame, joint/TCP transforms and object poses. The
policy receives fixture state and selection; it does not receive camera-derived object
recognition. The evaluator checks the simulated TCP or home-joint tolerance. Mesh/video
rendering is not sensor evidence. No physics solver, contact-based grasp, physical
validation or measured hardware performance is asserted.

Only loopback HTTP is exposed. The local operator page creates a SameSite=Strict,
HttpOnly cookie; API calls require that cookie plus same-origin mutation or a private
backend bearer token. Host/origin/cross-site checks and frame-embedding restrictions
block foreign-page control. Wrong run IDs cannot command another run. This is one
trusted local OS operator per station, not multi-tenant login isolation from other
users/processes on the same computer. Provider keys are never in HTTP responses.

An OS file lock excludes a second authority for the same directory. SQLite WAL and
FULL synchronous transactions bind state and command receipts. A process restart
loads the same run and pauses active work; Resume retains the command ID and elapsed
motion progress. Powered-off time produces no robot motion. Back up the **whole**
state directory with the service stopped; preserve the pinned source checkout and
release as well. Do not copy live WAL files individually.

## Optional local background service

The launcher is foreground by default. For persistence after terminal closure and
Linux user-manager startup, copy `deploy/embodied/oi-embodied.service` to
`~/.config/systemd/user/oi-embodied.service`, replacing its three `/ABSOLUTE/...`
paths with your pinned OI checkout, venv Python and pinned SO-ARM100 checkout.
Keep these checkouts outside `/tmp`, which the unit isolates.
Provider configuration, if used, belongs in a mode-0600
`~/.config/open-industries/embodied.env` (plain `NAME=value` lines).

```bash
systemctl --user daemon-reload
systemctl --user enable --now oi-embodied
systemctl --user status oi-embodied --no-pager
journalctl --user -u oi-embodied -n 100 --no-pager
systemctl --user stop oi-embodied
```

User-manager availability after logout requires `sudo loginctl enable-linger "$USER"`
on machines where the operator chooses it. WSL2 systemd does not keep Windows awake
or guarantee the distro starts at Windows boot; the [local lifecycle limitations](persistent-runtime.md#host-lifecycle-and-wsl2)
apply. This unit is provided but real boot/logout behavior was not tested here.

## Verification and remaining epic work

```bash
SO101_SOURCE_ROOT="$PWD/../SO-ARM100" PYTHONPATH=services/embodied .venv-embodied/bin/python -m unittest discover -s services/embodied/tests -v
SO101_SOURCE_ROOT="$PWD/../SO-ARM100" PYTHON=.venv-embodied/bin/python npm run test:embodied-browser
```

Install Playwright Chromium/ffmpeg first (`npx playwright install chromium ffmpeg`),
or use `ASTRA_CHROME_PATH` for an existing Chromium. Browser checks produce a PNG,
WebM demonstration and correlated JSON trace in `deliverables/embodied/`.

[Recorded execution evidence](evidence/embodied-chat/README.md) distinguishes manual
browser execution, injected HTTP model-adapter tests and the absent live-model run.
To complete #54, add contact-based pick/place with declared dynamics and measured
lift/retention/release/settling, full collision outcomes, sensor observations, multi-step
feedback behavior and a recorded live-model run over the bounded manipulation fixture.
Keep the epic open; these are not satisfied by approach motion or a chat panel.
