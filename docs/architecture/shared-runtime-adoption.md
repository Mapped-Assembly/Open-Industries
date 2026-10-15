# Shared runtime adoption: game compatibility and a neutral service

Status: #33 adopts the shared envelope, bounded clock driver, job checkpoints, resource
accounting, authority, command transactions and authorized history in the native v5 game.
The independently running neutral work-cell uses the same core without game-required fields.
Published-head CI must pass both native services and the two-account game browser flow.

## Implemented boundary

| Path | Domain ownership | Shared mechanisms | Persisted compatibility |
| --- | --- | --- | --- |
| Existing game service/MCP | `server/domains/game-core.mjs` and `game.mjs`: native rules, event boundaries and private/history projections | `SimulationInstance`, `DomainRegistry`, transactional commands, event clock/jobs, balanced resource ledger, `SqliteAuthority` and `SqliteEventHistory` | Native protocol v5, SQLite schema 5; lossless native state view and unchanged receipt bytes, atomic explicit older-save upgrades |
| Work-cell service/MCP | `server/domains/work-cell.ts`: instrument, finite fixture stock, timed modeled assay, rates, interruptions and result projection | Real `DomainRegistry` envelopes, transactional commands, resource ledger/reservations, job worker and persisted history | Envelope v1, `work-cell@fixture-v1` / schema 1, dedicated SQLite schema 100 |

`SqliteAuthority` owns native account/session hashing, SQLite locks, transactions, heartbeat
and database-version guards. It contains no required match, tower, opponent or winner model.
Both adapters reuse it. Accounts remain scoped to their database; sharing implementation does
not implicitly merge game/work-cell accounts. Transports resolve the current session before
accepting a principal and never accept a trusted owner or simulation clock from the client.

The versioned game module preserves published v5 event-boundary progression and exact yields.
Creation/join remain explicit native bootstrap flows. Every `astra.game_command`, including
invite rotation, uses the common executor and registry with original request keys/results.
Game jobs and observations have one canonical owner in the shared envelope. Native route,
phase and recipe details are job checkpoints; native projections reconstruct the original v5
shape. The resource ledger checks every proposed resource change before it can commit.
See [event runtime accounting](event-runtime-accounting.md) for the exact split and limits.

The neutral adapter is a real independently running server, not the earlier test-only HTTP
fixture. It registers the trusted work-cell module, persists envelopes, runs the shared worker
on a server timer, and serves domain-validated projections. It creates no game tables, towers,
dummy participant or victory state. No browser is necessary for completion after restart.

## Work-cell fixture and finite limits

One instance contains one owned modeled instrument, one kit, 2,000 mJ of instrument energy,
and a separate finite battery holding 3,000 mJ. A job needs three paid 1-second work steps,
spending 1,000 mJ each. It reserves the kit and consumes it on completion. A second job waits
explicitly for the same finite kit. A shortage never produces a result or refunds completed
work. `deliver-energy` transfers exactly 1,000 mJ from the existing battery; it cannot refill
from nowhere. Cancellation returns only the unused kit reservation, preserving energy spent.

Completion records one `simulated` / `modeled` result with value `fixture-complete`, linked to
the job and instrument. It does not claim a real assay reading, material conversion, physical
instrument control or external evidence. Conservation reconciles the opening kit/energy,
spent quantities and completed steps. Completed jobs and result IDs are retained, not reused.

Limits are three instances/account, eight retained jobs/instance and 256 normal receipts per
instance (including bootstrap). Up to eight successful cancellations can still be recorded
after the normal limit. Existing receipt retries continue to replay after the limit. Jobs
and commands cannot award a second initialization grant; there is no delete/reset/refill API.
Journal retention follows #32. The small fixture's resource history fits #30's finite bounds.

Worker batches process at most 100 quanta/instance and 100 instances/pass, ordered by their
saved simulation time and ID. Unprocessed downtime remains debt. If a command cannot reach a
current checkpoint in that budget, `CATCHUP_REQUIRED` asks the caller to wait/read/retry; it
does not commit a partial command. The independent worker continues draining debt. The
projection exposes `work_cursor_ms` and `catchup_pending_ms`. A 1-second quantum can delay
new/resumed work by less than one extra quantum, as specified in #31. Snapshot reads do not
award progress, and the browser never supplies job duration, resource costs or clock time.

## Reproduce locally

Node 22.16+ and `npm ci` are required. The TypeScript service uses the already installed `tsx`
runtime, like the existing MCP TypeScript adapters. No new runtime dependency is introduced.

```bash
ASTRA_SIMULATION_ALLOW_SIGNUP=true npm run simulation:server
```

Default binding is `http://127.0.0.1:8791`, with a separate database at
`.astra/simulation/work-cell.sqlite`. Override `ASTRA_SIMULATION_PORT` and `ASTRA_SIMULATION_DB`
when needed. Signup is disabled by default; the command above enables it for the local demo.
The existing game command remains `npm run game:server` on its own database/port.

In another terminal, register/login through `/auth/register` or `/auth/login` with
`{"username":"operator","password":"choose-a-local-demo-password"}`. Use the returned native
token only in the server-to-server `Authorization: Bearer ...` header. Example request shapes:

```text
POST /simulation/instances
{"command_id":"create-intent-1"}

POST /simulation/read
{"instance_id":"<returned-instance-id>"}

POST /simulation/command
{"command_id":"start-intent-1","instance_id":"<returned-instance-id>","expected_revision":1,"action":"start","payload":{}}

POST /simulation/command
{"command_id":"delivery-intent-1","instance_id":"<returned-instance-id>","expected_revision":<fresh-revision>,"action":"deliver-energy","payload":{}}

POST /simulation/command
{"command_id":"cancel-intent-1","instance_id":"<returned-instance-id>","expected_revision":<fresh-revision>,"action":"cancel","payload":{"job_id":"job-1"}}

POST /simulation/history
{"instance_id":"<returned-instance-id>","cursor":null,"limit":20}
```

Commands are `start`, `deliver-energy`, `pause`, `resume`, and `cancel`; controls require
`payload.job_id`, while start/delivery accept no job ID. Read a fresh revision after CONFLICT
and submit a new intent. If the response is lost/unknown, retry the identical command ID,
revision and payload; do not invent a second start. Expired history cursors require a fresh
snapshot. Requests are JSON, bounded, loopback/server-to-server and reject browser Origins.

MCP exposes `astra.simulation_describe`, `astra.simulation_create_work_cell`,
`astra.simulation_read`, `astra.simulation_command` and `astra.simulation_history` alongside
the existing tools. Describe reports the installed modeled contract, not service readiness.
Configure `ASTRA_SIMULATION_TOOLS_ENABLED=true`, `ASTRA_SIMULATION_SERVICE_URL` and
`ASTRA_SIMULATION_SESSION` in the MCP server's environment. RPC request and response schemas
are validated; credentials are not tool arguments or projected state. Existing game discovery
and strict version gates remain unchanged. No client is silently downgraded from v5 to v3.

## Save compatibility, backup and rollback

Native game schemas 0–4 upgrade atomically to schema 5. Existing native science/robot
upgrades run first when necessary. Packing the shared envelope retains IDs, inventory,
paid work, observations, pins, revision and immutable receipt bytes. No old elapsed-time
history is invented: current finite balances become the opening checkpoint. The migration
appends one `shared-core-cutover` event. Captured v3/v5 saves verify lossless native views,
old history, exact receipts and one-time initialization across reopen.

The history wrapper remains `game-runtime@dump-world-v1/schema3`; the current envelope pins
`native-game@dump-world-v1/schema1`. These differ from wire v5 / SQLite 5. Old journals and
cursor keys remain; `game-history-v3` projects both old native and new envelope events.
Older projection-bound cursors require a fresh snapshot. Unknown module/science/robot pins
or database versions fail with a restore-backup/exact-runtime remedy without rewriting saves.

Work-cell storage uses schema 100 and refuses a game save. The game service refuses schema
100. Unknown work-cell module/schema pins fail startup rather than rerolling stock or erasing
receipts. This is a new bounded fixture database; old test-fixture tables are not a migration
source. The registry's offline migration hooks are not invoked automatically on reads.

Stop the relevant service before switching binaries. Back up using SQLite's backup facility,
for example `sqlite3 /absolute/path/runtime.sqlite '.backup /absolute/path/runtime-backup.sqlite'`.
Keep the entire database, including history and cursor keys, together. Do not copy a live main
database file while dropping its WAL. Test the backup with the matching module/runtime before
an upgrade. Restoring it discards work after that backup; never combine newer receipts with an
older inventory or job state. Returning to any pre-schema-5 binary requires the full pre-upgrade backup.
Receipt bytes and the lossless native view are preserved; persisted state is now an envelope.
A work-cell database requires this service or its compatible successor.

## Verification evidence

`npm run test:simulation` covers the core contracts, transactional commands, both job policies,
resource conservation, history, neutral independent service, real SQLite concurrency/restart,
and captured-native migrations. Event-runtime tests compare exact physical checkpoints with
the original native rules, including quarter-second travel, variable-rate solar-starved charging,
one-millisecond final transfer, bounded debt, clock rollback and ledger tail compaction.
Receipt insertion failure during a real robot reservation rolls back the entire envelope and
history; identical retry commits once. Registry tests reject inconsistent entity/evidence
proposals and preserve only explicitly public domain rejection codes.

`npm run test:mcp-game` runs robot/world regressions and independent production HTTP/MCP
reconnect, concurrent collection, autonomous progress, hard process restart and exact receipt
replay. `npm run test:materials`, `npm run build`, `npm run test:mcp` and scene regressions
protect the existing materials and authoring paths. The downstream integration runs its real
HTTP/MCP adapter against this checkout. The upstream `downstream-browser` CI job checks out
immutable client commit `9fb37e7304935aea6616a1dc8c9bd6bd68e390fc`, uses this PR's runtime,
and runs two isolated desktop/mobile accounts through recovery, materials, robots, lost
responses, logout/reconnect and mutual completion, uploading screenshots. Consult that job's
result for published-head browser acceptance; a local Chromium download is unavailable.

The wire schemas remain v5. Discovery allows additional neutral tools while still requiring
all game tools and exact supported game versions. No simulation authority moves to the client.

For later domains, register trusted exact-pin modules with strict schemas, domain invariants,
explicit projections and finite initialization. Select worker/resource policies by the exact
pin; add explicit versioned migration and compatibility tests before accepting older saves.
Never load executable module paths from client input or default unknown versions to latest.

FIELD-LAB adoption under #10 is detailed below. Evidence/model validity remains #11, and
authoritative live scene/CAD binding remains #12. These domains reuse epic #27 / #33; no
physical-control, collision certification or scientific validation claim follows from software adoption.

## FIELD-LAB-01 adoption (#10)

The versioned [field-lab runtime](field-lab-runtime.md) now uses the same envelope, event clock,
job checkpoints, balanced resource ledger, command executor, native SQLite authority and
post-state history. Its separate schema-101 database supports one operator and finite lab
jobs, scheduled deliveries, modeled outputs, water/energy shortfalls and waste/spill. Actual
HTTP, independent process/restart tests and a file-backed six-scenario baseline provide lab
adoption evidence; the work-cell remains the small neutral exemplar. Scientific validation
and live scene/CAD authority binding stay with #11/#12.
