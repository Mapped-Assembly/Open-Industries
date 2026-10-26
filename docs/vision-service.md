# Camera observations for machine agents

Open Industries provides an optional **Python OpenCV 5 service** for acquiring image
evidence and exposing observations through the existing `server/astra-mcp.mjs` host.
This is a perception boundary: the service never sends a robot command or marks a
task complete. Machine agents can use observations when proposing subsequent work.

The [inspection policy and MCP tools](vision-agent.md) connect this service to the
existing simulated robot runtime, with durable command recovery and before/after evidence.

## Installed capabilities

| Component | Implemented behavior |
| --- | --- |
| Camera interface | Typed `CameraSource.capture()` protocol returning encoded pixels and optional source modification time |
| File adapter | Reads a configured PNG/JPEG snapshot; suitable for renderer output, a camera writer, or explicitly labeled fixtures |
| HTTP adapter | Reads a fixed operator-configured PNG/JPEG endpoint, optionally with bearer authentication; redirects are rejected |
| OpenCV processing | BGR-to-gray quality metrics and HSV threshold/morphology/contour region detection from actual pixels |
| Evidence store | Dedicated SQLite database retaining exact input bytes, SHA-256 hashes, immutable observations and idempotent receipts |
| Agent interface | Seven `astra.vision_*` tools; frame reads include an MCP image preview |

The generic library is in `services/vision/oi_vision`; garden-specific cell geometry,
seed classification, calibration and placement verification belong in a consuming
application. Region labels are operator configuration, not learned semantic recognition.
There is no trained detector, claimed confidence probability, or automatic camera-to-arm transform.

## Run locally (WSL2 / Linux / macOS)

From the repository root, use Python 3.11+ and the existing Node 22.16+ requirement:

```bash
python3 -m venv .venv-vision
source .venv-vision/bin/activate
python -m pip install -e ./services/vision
npm ci

python services/vision/examples/make_demo.py
export OI_VISION_TOKEN="$(python -c 'import secrets; print(secrets.token_hex(32))')"
export OI_VISION_ENABLED=true
export OI_VISION_SERVICE_URL=http://127.0.0.1:8792

python -m oi_vision --config .astra/vision-demo/config.json &
vision_pid=$!
node server/astra-mcp.mjs
# After the MCP host exits:
kill "$vision_pid"
```

Normally an MCP-capable client launches the Node command. Configure those same three
`OI_VISION_*` environment variables in that host; the token must match the independently
running Python service. Use the host's secret environment mechanism, not a prompt or
checked-in configuration. The tools are listed when disabled, but every service operation
requires `OI_VISION_ENABLED=true` and a valid token. `vision_describe` only describes the
installed contract and works without the service.

Python dependencies are pinned in the service's own `pyproject.toml`, independently of
the geospatial exporter and optional Forma environment. Startup rejects OpenCV 4.x.
On Windows, use `.venv-vision\Scripts\python.exe` and set the environment variables in
PowerShell; both the service and its tests use platform-independent Python APIs.

### First agent exercise

Ask the connected agent:

> Discover the vision tools, list my cameras and profiles, capture demo-overhead with
> a new request ID, and read its evidence image. Analyze that frame using yellow-regions
> with another new request ID and max_age_ms=60000. Report the measured regions and
> image/profile hashes. Identify the input as fixture evidence. Do not issue machine commands.

The generated image has two yellow regions and a blue distractor. This tests actual
OpenCV image processing, not agricultural accuracy. Regenerate the fixture if its file
modification time is older than the requested maximum age. Then change the source pixels,
capture with a new request ID, and observe that detections change while earlier evidence
remains readable.

## Configure a real or simulated camera

Copy [`cameras.example.json`](../services/vision/examples/cameras.example.json) to an
operator-owned location and set its sources. Relative image paths resolve from the
configuration file, not the process working directory. Renderers should write a new PNG
and atomically replace the configured snapshot file. This adapter does not itself render
an OI scene or provide a calibrated virtual-camera model.

For an existing Pi snapshot viewer, use its actual tunnel URL, for example
`http://127.0.0.1:8081/emeet/snapshot.jpg`; the port is illustrative and must match your
tunnel. Use a snapshot endpoint, not an indefinite MJPEG stream. A camera may specify
`bearer_token_env` for a distinct upstream camera credential. URLs, file paths and tokens
never enter public camera/observation records or agent errors.

Configuration is loaded at startup. Each principal has a unique token environment
reference and an explicit `machines` allowlist. Tokens must contain 32–256 characters
from letters, digits, underscore and hyphen. Shared cameras can be accessed by multiple
principals explicitly allowed for the attached machine. Unknown and unauthorized IDs
both return `NOT_FOUND`. Reads of stored evidence also check current camera ownership.
There is no automatic synchronization with a machine registry or model provider.

An operator chooses `physical`, `simulation`, or `fixture` for each source. That label
records declared provenance; it is not a cryptographic attestation of camera hardware.

## Tool and HTTP contract

All operations below are JSON POSTs with `Authorization: Bearer ...`. Unknown fields
are rejected in both MCP and Python. Agent requests accept camera/profile IDs, never
arbitrary filesystem paths, URLs, credentials, executable code, or detector parameters.

| MCP tool | HTTP route | Arguments |
| --- | --- | --- |
| `astra.vision_describe` | Local discovery only | `{}` |
| `astra.vision_list_cameras` | `/v1/cameras/list` | `{}` |
| `astra.vision_capture` | `/v1/frames/capture` | `camera_id`, `request_id` |
| `astra.vision_read_frame` | `/v1/frames/read` | `frame_id` |
| `astra.vision_analyze` | `/v1/frames/analyze` | `frame_id`, `profile_id`, `request_id`, `max_age_ms` |
| `astra.vision_read_observation` | `/v1/observations/read` | `observation_id` |
| `astra.vision_list_observations` | `/v1/observations/list` | `camera_id`, `limit` (1–100) |

`GET /health` returns service/contract/OpenCV versions, without credentials or camera
inventory. It proves library availability, not camera connectivity or detector accuracy.

Capture returns a stable frame ID, camera/machine IDs, exact encoded-source SHA-256,
byte length, dimensions, media type, acquisition time, and optional source modification
time. OpenCV ignores EXIF orientation: coordinates refer to the encoded pixel grid.
Agent frame reads return a JPEG preview of at most 384 pixels per side with its **own**
SHA-256. They do not pretend that the preview bytes match the original image hash.

Analysis returns an observation ID and frame link/hash, the full configured profile
and its hash, detector/OpenCV versions, timestamps, mean luminance, Laplacian variance,
and optional color-region detections. Bounding boxes are `[x,y,width,height]` in pixels;
centroids are `[x,y]`. HSV hue is 0–179 and saturation/value 0–255. Hue intervals cannot
wrap; use distinct profiles if required. Up to 64 regions are returned, with the total
count and an explicit truncation flag. Touching/overlapping objects may merge into one
region, and low-contrast objects may be missed. Neither no detections nor a blur metric
alone establishes that a target is absent or that a machine action is safe.

### Freshness and retries

- `acquired_at_ms` is the service acquisition time, **not** physical exposure time.
- `source_modified_at_ms` is file mtime or HTTP Last-Modified, when available. It is
  source-reported metadata, not independently verified exposure time. Missing timestamps
  remain null, with `source_age_known=false` in observations.
- Analysis rejects a frame older than `max_age_ms` (1 ms–24 hours) by acquisition time
  or known source modification time. Clock rollback and substantially future source
  timestamps fail closed. A controller needing verified fresh exposure must require a
  source that provides it; successful fetching alone cannot establish freshness.
- Reuse an identical `request_id` and payload after an uncertain capture/analysis
  response. The original receipt is returned even after restart or source changes.
  Reusing the ID for different work returns `REQUEST_ID_REUSED`.
- A successful receipt replay is historical: it **does not** recheck current freshness
  or re-run inference. Use a new capture request ID for new evidence. Read/history tools
  intentionally allow old evidence and do not authorize actuation.

## Persistence and deployment

The default database is `.astra/vision/observations.sqlite`. It is a separate,
versioned vision database; do not point it at the simulation or scene database. Images,
observations and request receipts commit atomically using SQLite WAL and FULL synchronous
mode. Limits are 4 MiB per encoded PNG/JPEG, 4096 pixels per side, 8 million total pixels,
64 MiB retained input image bytes, 1024 frames and 8192 successful mutation receipts.
At capacity, operations return `STORAGE_LIMIT` without deleting evidence. Back up with
SQLite's backup API and archive the database deliberately before starting a new store.
SQLite records are append-only through this API, not tamper-proof storage.

The HTTP server defaults to loopback, limits concurrent connections to eight, rejects
browser Origin requests, and bounds JSON bodies and camera reads. Operator-configured
HTTP camera sources are trusted network capabilities; review them before starting the
service. Redirects and inherited HTTP proxies are disabled for camera acquisition.

For AWS or another host, run the same Python service with durable disk and a supervised
process. Put authentication-preserving HTTPS termination in front of remote access;
the MCP bridge allows loopback HTTP or operator-configured HTTPS. Keep the service
token in the agent host, and its allowed machine identities in the service configuration.
This change does not provision cloud infrastructure or publish a service.

## Verification

With the service environment active and Node dependencies installed:

```bash
OI_VISION_MCP_TESTS=1 python -m unittest discover -s services/vision/tests -v
npm run test:mcp
npm run build
```

The suite exercises real OpenCV 5 pixel extraction, changed source images, original
and preview hashes, machine isolation, stale evidence, clock rollback, concurrent
duplicate requests, restart/retry persistence, quota rollback, malformed/oversized
images, HTTP auth/origin handling, camera redirects and the actual Node MCP process
calling the Python HTTP service. Fixture tests do not establish physical camera,
seed-detection, robotic manipulation or cloud-deployment performance.
