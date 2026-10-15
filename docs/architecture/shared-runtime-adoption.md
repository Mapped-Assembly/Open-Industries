# Shared runtime adoption: game compatibility and a neutral service

Status: native material/robot integration follows the first service-adoption step for #33.
This does **not** close #33. The v5 game and neutral work-cell service share authority, command
transactions and authorized history. Generic game envelope/resource/job migration remains
outstanding. Material/robot policies from PR #6/#16 are integrated here; those older branches
need no separate merge before this PR.

## Implemented boundary

| Path | Domain ownership | Shared mechanisms | Persisted compatibility |
| --- | --- | --- | --- |
| Existing game service/MCP | `server/domains/game.mjs`: world, membership/invites, balance, recovery, processing, completion and private/history projections | `SqliteAuthority`, every native game command through `executeTransactionalCommand`, exact resource/time helpers and `SqliteEventHistory` | Native protocol v5 and SQLite schema 4; unchanged native v5 state/receipt bytes, explicit older-save upgrades |
| Work-cell service/MCP | `server/domains/work-cell.ts`: instrument, finite fixture stock, timed modeled assay, rates, interruptions and result projection | Real `DomainRegistry` envelopes, transactional commands, resource ledger/reservations, job worker and persisted history | Envelope v1, `work-cell@fixture-v1` / schema 1, dedicated SQLite schema 100 |

`SqliteAuthority` owns native account/session hashing, SQLite locks, transactions, heartbeat
and database-version guards. It contains no required match, tower, opponent or winner model.
Both adapters reuse it. Accounts remain scoped to their database; sharing implementation does
not implicitly merge game/work-cell accounts. Transports resolve the current session before
accepting a principal and never accept a trusted owner or simulation clock from the client.

The versioned game compatibility module retains its published native v5 event-boundary progression and exact yields.
Creation/join remain explicit native bootstrap flows. Every `astra.game_command`, including
invite rotation, now uses the common executor with original request keys/results. Game state
has not been converted to a generic `SimulationInstance`, nor its existing orders/inventory to
the new job/resource storage. That migration must be versioned and tested separately under
the remaining #33 work; the current split avoids silently reinterpreting live saves.

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

Native game schemas 0–3 use explicit atomic upgrades to schema 4 in the versioned domain
module. They retain IDs, inventory, paid work, observations and immutable receipt bytes;
newly provisioned probes are recorded once in the starter ledger. Migrated matches keep
the starter recovery path. New matches require physical robot surveying/collection/hauling.
Existing native v5 saves keep their exact persisted state and receipts on cutover/reopen.
Unknown robot/science pins or database versions fail with an explicit backup/runtime remedy.

The persisted native history wrapper stays `game-runtime@dump-world-v1/schema3`; it is not
the wire or SQLite version. Historical pre-science states use their original private projection;
science/robot states retain their own explicit pins. Replay validates frozen state without
initializing science, granting components or rerunning effects. A real upgrade appends one
migration event within the same state/version transaction; old journals and cursor keys remain.

Work-cell storage uses schema 100 and refuses a game save. The game service refuses schema
100. Unknown work-cell module/schema pins fail startup rather than rerolling stock or erasing
receipts. This is a new bounded fixture database; old test-fixture tables are not a migration
source. The registry's offline migration hooks are not invoked automatically on reads.

Stop the relevant service before switching binaries. Back up using SQLite's backup facility,
for example `sqlite3 /absolute/path/runtime.sqlite '.backup /absolute/path/runtime-backup.sqlite'`.
Keep the entire database, including history and cursor keys, together. Do not copy a live main
database file while dropping its WAL. Test the backup with the matching module/runtime before
an upgrade. Restoring it discards work after that backup; never combine newer receipts with an
older inventory or job state. A return to the earlier v3/schema-2 binary requires the pre-upgrade backup.
Native v5/schema-4 state and receipt bytes are preserved; new history tables are additive.
A work-cell database requires this service or its compatible successor.

## Evidence and remaining #33 work

`npm run test:simulation` includes 61 tests. The four captured-native-save tests cover
v3/v5 migration, exact paid work/reservations/observations/receipt preservation, old history,
revoked retry, rollback and unsupported-pin remedies. Robot/material suites run directly
against this adopted checkout, rather than a separate pinned baseline. The downstream
HTTP/MCP integration verifies strict v5 discovery, native identities, ownership/privacy,
invites, processing, retries, CSRF/cookies and revocation against this actual authority.
The production build and room/scene regressions are also required.

Downstream discovery now verifies required game tools while allowing additional installed
neutral tools. The client still rejects mismatched game schemas/versions; no authority moves
to the browser. The local Chromium download remains unavailable (truncated archives); the
GitHub browser job runs the actual desktop/mobile two-account recovery/reconnect flow and
publishes its screenshots. Do not claim that browser acceptance passed until that job succeeds.

Remaining #33 acceptance: faithful generic game envelope/resource/job migration preserving
native outputs, schedules and receipts, plus published two-account desktop/mobile evidence.
Native robot/process advancement is still domain-specific. This PR proves native v5
compatibility with the extracted authority/command/history; it does not pretend those orders
already use `SimulationInstance`, `runJobWorker` or the generic resource ledger.

For later domains, register trusted exact-pin modules with strict schemas, domain invariants,
explicit projections and finite initialization. Select worker/resource policies by the exact
pin; add explicit versioned migration and compatibility tests before accepting older saves.
Never load executable module paths from client input or default unknown versions to latest.

Full FIELD-LAB adoption remains #10, evidence/model validity remains #11, and authoritative
scene/CAD bindings remain #12. They can depend on epic #27 / #33 and the shared contracts,
worker, resource and history APIs introduced here; this work creates no second lab viewer,
physical-control claim, collision certification or scientific validation path.
