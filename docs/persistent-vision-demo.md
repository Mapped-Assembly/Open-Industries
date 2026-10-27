# Keep an inspection station running for an external agent

The Python launcher keeps the simulated robot runtime, synthetic HTTP camera and
OpenCV 5 service alive while an external MCP agent connects and disconnects. It
reopens the same match, robot, endpoints, observations and inspection checkpoints
when restarted with the same state directory. Starting the launcher does not issue
an inspection or move a robot.

This is the simulated city-dump inspection adapter from [the inspection integration](vision-agent.md).
The camera draws the authorized runtime state and a configurable yellow marker.
Physical equipment, native Open Industries chat, a live model run and AWS deployment
remain separate integrations.
For the deployment implementation and cloud acceptance procedure, see
[AWS inspection station](aws-inspection-station.md); it preserves this launcher's
fixed repository-root binding and supervises the complete process tree.

## Start the station

Use Linux, WSL2 or macOS, Python 3.11/3.12 and Node 22.18+. From the repository root:

```bash
python3 -m venv .venv-vision
source .venv-vision/bin/activate
python -m pip install -e ./services/vision
npm ci
oi-vision-demo serve --root "$PWD"
```

The equivalent command is `python -m oi_vision.demo_cli serve --root "$PWD"`.
The default state directory is `.astra/vision-agent-live`, relative to your current
directory. Use `--state-dir /absolute/path/to/station` on every command when choosing
another location. A new directory creates an independent fixture.

Wait for one JSON line with `"status": "ready"` and `"services_healthy": true`.
It includes the camera URL, match/robot IDs and MCP configuration path. URLs bind to
`127.0.0.1`; the launcher selects available ports on first start and saves them for
subsequent starts. Occupied saved ports cause startup to fail rather than silently
changing the service identity of an existing inspection.

Keep this terminal running. An MCP client can close without stopping these services.
To keep the terminal session across SSH disconnections, run it inside an installed
`tmux` session (`tmux new -s oi-vision`, then detach with Ctrl+B, D).

## Connect an agent

The generated `.astra/vision-agent-live/mcp.json` contains a `mcpServers` entry named
`open-industries-demo`. Add that entry to a local stdio MCP host that supports this
configuration shape. For hosts with another configuration format, use the entry's
exact `command` and `args` values. They use absolute paths and work from other
working directories. The launcher does not edit an existing host configuration.

The command runs `oi_vision.demo_cli mcp`, which checks the services, reads private
connection settings and starts the repository's existing `server/astra-mcp.mjs`.
Only MCP messages appear on stdout. The agent host and launcher must run on the
same machine; a hosted browser chatbot cannot attach to this local stdio process.

Ask the connected agent:

> Inspect demo-inspection. Choose one new run UUID and keep using that same ID
> with astra.agent_inspect_robot until completed or needs_review. Show the initial
> image using astra.vision_read_frame, then the runtime action and follow-up image.
> Report the review reason if it stops. Describe the movement as simulated.

The exported configuration is tested through real stdio MCP, Python policy processes,
OpenCV and the game worker. The launcher does not choose or call an LLM provider;
your external agent host supplies its own model.

## Demonstrate the visual decision

In a second terminal, using the same Python environment and repository directory:

```bash
oi-vision-demo status
oi-vision-demo marker hide
```

Request an inspection with a new run UUID. Missing marker pixels cause one recapture,
then `needs_review`; no robot command is issued. The operator can then change the
scene condition:

```bash
oi-vision-demo marker show
```

Request a **new** inspection with a new run UUID. The marker now permits the configured
survey command. The runtime moves the robot; the agent monitors that job and captures
follow-up evidence. Repeating the same UUID retrieves or advances the same intent.
A terminal review result is retained when the marker changes.

The marker's image coordinates are not motion coordinates. It enables a survey of
one fixed configured destination. After a successful survey the robot remains at
that destination. A second identical survey may produce unchanged pixels and correctly
request review. For another movement demonstration, use the existing `return_robot`
command and wait for its completion, or start a separate fixture directory.

`status` checks the live scheduler heartbeat, vision service and camera response.
The camera URL can be opened locally to inspect the synthetic scene; it carries no
service credential. Marker changes are operator commands and do not move the robot.

## Stop, restart and reconnect

Press Ctrl+C, or send SIGTERM to the launcher. It stops the HTTP services, asks the
runtime to checkpoint and close, and retains the fixture files. Run the same `serve`
command to resume. It does not recreate the match or reset robot positions.

Reconnect the MCP host and reuse the original run UUID to inspect or continue an
interrupted workflow. Its exact prepared command, observations and runtime job ID
remain available. Existing freshness and timeout limits still apply: a long outage
can require review. Restart does not certify an inspection or cancel an accepted job.
The runtime can catch up supported **simulated** work; inspection policy phases still
advance through tool calls and do not run autonomously when every agent disconnects.

Runtime sessions expire after eight hours. The launcher refreshes its own camera
session and writes fresh settings for the next MCP connection. Already connected
MCP processes retain their original session; if a tool reports `AUTH_REQUIRED`,
reconnect the host and continue with the same run UUID. Vision credentials and
machine bindings remain stable.

One OS file lock permits one launcher per directory. The launcher exits with a
nonzero status and closes dependent services if its worker fails. A process supervisor
can restart the same command. A machine reboot also requires restarting the launcher.
For an abrupt SIGKILL, any surviving runtime must be stopped before reusing its saved
port; normal Ctrl+C/SIGTERM shutdown is the tested path.

## Stored files and troubleshooting

| File | Purpose |
| --- | --- |
| `host.json` | Saved account credentials, provisioning command IDs, session metadata, ports and fixture binding |
| `connection.json` | Private environment for the next MCP connection |
| `mcp.json` | Generic stdio host entry, with absolute command paths and no embedded tokens |
| `agent.json`, `vision.json` | Fixed operator configuration |
| `marker.json` | Persistent operator-controlled marker visibility |
| `ready.json` | Last launcher state; use `status` to check current health |
| `runtime.sqlite` | Authoritative game state and command receipts |
| `observations.sqlite` | Exact images and OpenCV observations |
| `inspections.sqlite` | Inspection policy checkpoints, created on first agent call |

The directory uses mode `0700`, generated configuration uses `0600`, and a local
`.gitignore` excludes all its contents. Keep it private: `host.json` and
`connection.json` contain credentials. Share selected evidence through the existing
observation/inspection tools, not by uploading the entire state directory.

- `DEMO_ALREADY_RUNNING`: attach to the existing station or use another directory.
- `DEMO_DIRECTORY_NOT_EMPTY`: choose a dedicated empty directory; the launcher will
  not adopt a one-shot demo's files or an unrelated database.
- `DEMO_INCOMPATIBLE_STATE` / `DEMO_RUNTIME_DATABASE_MISSING`: restore the complete
  saved fixture; the launcher will not silently replace the missing runtime.
- `DEMO_NOT_RUNNING`: start the saved station before attaching an MCP client.
- `DEMO_SERVICE_EXITED` / `DEMO_UNAVAILABLE`: check Node/Python dependencies and
  whether a saved port is occupied, then restart the same command.

The fixture retains the runtime and vision service's existing quotas. It is a bounded
local demonstration, not a production fleet service. The one-shot
`python services/vision/examples/run_agent_demo.py` remains available for automatic
success/failure traces and exported images.

## Verification

```bash
OI_VISION_MCP_TESTS=1 python -m unittest discover -s services/vision/tests -v
```

Integration tests launch separate host and MCP processes, connect from an unrelated
working directory, change marker pixels, disconnect/reconnect, restart during an
accepted inspection, and verify one runtime job with preserved image evidence. They
also cover revoked-session recovery, private file permissions, duplicate launchers,
worker failure, interrupted provisioning and occupied-port cleanup.
