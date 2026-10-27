# Connect visual observations to robot execution

The Python inspection policy connects the OpenCV service to the existing
`astra.game_command` interface. A connected agent can request an inspection, advance
it, and read its trace. The runtime remains the authority for routing, energy, job
progress, ownership and completion.

This first adapter targets the existing **simulated city-dump robots**. It demonstrates
the reusable perception-to-execution boundary. Garden task semantics, seed detection,
camera calibration, general per-machine agents and physical controller drivers remain
separate integrations tracked by #54 and #56.

## Behavior

An operator binds a camera, color-region profile, owned robot and one known survey
destination. The camera's `machine_id` must equal that robot's ID, and its declared
evidence kind must be `simulation` or `fixture`. Physical camera bindings are rejected
by this adapter.

1. Read the authorized camera/profile and runtime snapshot.
2. Capture pixels and run OpenCV through the existing vision MCP tools.
3. Require one configured color region, usable image-quality measurements and recent
   evidence. Missing/ambiguous regions or poor image quality trigger one recapture,
   followed by `needs_review` if the problem remains. Stale images stop the workflow.
4. Recheck the observation, robot position and idle state. Persist the exact
   `survey_robot` command before sending it through `astra.game_command`.
5. Read the specific accepted runtime job until it completes. Routing and movement
   are performed by the existing worker; the policy never assigns robot positions.
6. Capture and analyze another image. Record completion only after the runtime job
   completes and an acceptable, changed follow-up image is available. Otherwise,
   retain the completed runtime result and request review of the visual evidence.

The color marker signals that an already configured inspection target should be
surveyed. Its image location is **not** converted into motion coordinates. The policy
does not recognize arbitrary objects, infer material composition, or certify physical
movement. The runtime's existing `camera-depth` survey results remain modeled sensor
data; the before/after OpenCV observations are separate records derived from pixels.

The reference policy is deterministic and needs no model account. An external
model-backed agent can invoke its MCP tools and show the evidence to the user.

For a station that remains available across agent connections and host restarts,
use the [persistent demo launcher](persistent-vision-demo.md). It writes a local
MCP connection configuration and provides operator controls to show or hide the marker.

## Run the complete local demonstration

From the repository root, using Python 3.11 or 3.12 and Node 22.18+:

```bash
python3 -m venv .venv-vision
source .venv-vision/bin/activate
python -m pip install -e ./services/vision
npm ci
python services/vision/examples/run_agent_demo.py
```

The demo starts the real SQLite game service, registers two temporary accounts through
its HTTP API, and creates/joins a match through the production contract. It starts an
HTTP camera that renders only the account's authorized snapshot and an OpenCV service.
The white robot position in each image comes from the running simulation. A yellow
marker identifies the configured survey destination.

It calls the **public agent MCP tools**, exercising the same subprocess/transport path
available to an external agent. Each call starts a fresh policy process and resumes
the saved checkpoint. The demo first hides the marker, then shows it:

| Input | Required outcome |
| --- | --- |
| Marker absent | Two observations, `needs_review`, no robot command |
| Marker visible | Survey command, actual simulated movement, completed runtime job, changed follow-up image |

Results are saved under `.astra/vision-agent-demo/`:

- `missing-marker.json`: rejected observations and the review reason.
- `inspection.json`: before/after observations, command ID/payload, job ID, positions,
  runtime result and causal events.
- `before.png`, `after.png`: exact encoded source images retained by the vision service.

The demo stops its services on exit. Its generated service configuration contains
temporary ports and is not a reusable deployment. Credentials are generated in memory
and are not written into the public evidence files. Use a new `--output` directory for
an independent run. This demonstration is a synthetic simulation experiment, not a
physical-camera, garden-recognition, live-model or AWS result.

## Connect an existing agent host

Install the service package into the Python environment used by the MCP host. Start
and configure the existing [vision service](vision-service.md) and
[game runtime](mcp-game-runtime.md), including valid independent service credentials.
Use `astra.game_read_match` to identify an owned robot and an available destination.

Write an operator-owned JSON configuration with the following shape, replacing the
illustrative UUIDs with the actual runtime IDs:

```json
{
  "bindings": [
    {
      "binding_id": "inspection-station",
      "camera_id": "overhead",
      "match_id": "00000000-0000-4000-8000-000000000001",
      "robot_id": "00000000-0000-4000-8000-000000000002",
      "target_id": "00000000-0000-4000-8000-000000000003",
      "profile_id": "inspection-marker",
      "max_age_ms": 60000,
      "timeout_ms": 120000,
      "min_laplacian_variance": 1.0,
      "min_luma": 1.0,
      "max_luma": 254.0
    }
  ]
}
```

The profile must be an operator-configured `color_regions` profile in the vision
service. Quality thresholds are explicit heuristics, not calibrated confidence values.
The camera configuration must attach `overhead` to the exact `robot_id` above.

Set these additional environment variables in the host that launches
`server/astra-mcp.mjs`, alongside the existing vision/game settings:

```bash
export OI_AGENT_ENABLED=true
export OI_AGENT_PYTHON="$PWD/.venv-vision/bin/python"
export OI_AGENT_CONFIG="$PWD/.astra/vision-agent/config.json"
export OI_AGENT_DATABASE="$PWD/.astra/vision-agent/inspections.sqlite"
```

On Windows, point `OI_AGENT_PYTHON` at `.venv-vision\Scripts\python.exe`. The configured
Python executable, paths and credentials are host configuration, never tool arguments.
Each host uses its own authenticated service scope. The nested transport disables agent
tools to prevent recursive inspection execution.

| Tool | Arguments | Meaning |
| --- | --- | --- |
| `astra.agent_inspect_robot` | `binding_id`, `run_id` (canonical UUID) | Start or advance one bounded phase of the same inspection |
| `astra.agent_read_inspection` | `binding_id`, `run_id` | Read the authorized historical checkpoint without advancing it |

Example instruction to the connected agent:

> Inspect inspection-station. Choose one new run UUID and keep using it when advancing
> the inspection. Show the initial image using vision_read_frame. Continue until the
> inspection completes or needs review. Show the runtime action, position change and
> follow-up image, and distinguish simulated movement from physical validation.

`observing`, `ready`, `dispatching`, `running`, and `verifying` are intermediate states.
`completed` and `needs_review` are terminal. Polling an intermediate run does not create
a new intent. A review result provides a reason and retains any accepted command/job;
it must not be described as automatic cancellation or successful inspection.

The same workflow is available from Python or a shell:

```bash
oi-vision-agent advance --root "$PWD" \
  --config "$OI_AGENT_CONFIG" --database "$OI_AGENT_DATABASE" \
  --binding inspection-station --run-id YOUR_RUN_UUID
```

Use `read` instead of `advance` for a historical checkpoint. Shell calls assume the same
service environment as MCP. A process exit alone is not success: inspect the returned
`inspection.stage` or structured `error`.

## Recovery and authorization

The workflow database stores coordination checkpoints, not an alternative machine
state. It uses a full-synchronous SQLite rollback journal for short-lived policy
processes. Each update compares the previous revision; competing workers cannot
replace another worker's prepared command. Limits are 256 retained runs, 128 KiB per
run and 32 causal events. At capacity, preserve/archive the database before starting a
new one; there is no silent deletion of evidence.

Capture and analysis IDs derive from the run and phase. The exact runtime command is
committed before transmission. A lost response is retried with identical arguments and
the same command ID, allowing the runtime's immutable receipt to recover it. A known
revision conflict permits at most two new attempts, each preceded by fresh authorization,
snapshot and evidence checks. Uncertain outcomes never receive a new command ID.

If evidence expires while dispatch is uncertain, the run requests review rather than
sending a stale command. Reconcile the retained command ID and runtime state before
starting new work. Runtime wait expiry also requests review; an already accepted job
may still be running. The adapter does not silently interrupt or cancel it.

Both services are consulted for authorization on every advance/read, including terminal
replays. Rebinding a run, changing its policy configuration, or changing its service
endpoints is rejected. Credentials and camera source locations are excluded from traces.
A terminal result is historical evidence; reading it does not certify current freshness.

## Verification

```bash
OI_VISION_MCP_TESTS=1 python -m unittest discover -s services/vision/tests -v
npm run test:mcp
npm run build
```

The integration tests exercise changed pixels and runtime positions, the public MCP
agent tools, exact command replay after a committed response is lost, process restart,
parallel workers, stale frames/decisions, unauthorized access, changed bindings,
physical-camera rejection and frozen follow-up images. All simulated movement is driven
by the real service worker using wall-clock time. Tests never set robot positions or
mark jobs completed directly.
