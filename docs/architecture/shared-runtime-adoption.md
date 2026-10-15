# Shared runtime adoption: game compatibility and a neutral service

Status: first reviewable adoption step for #33 under epic #27, built on #28–#32.
This does **not** close #33. Native v3 game compatibility and the real neutral service are
covered here; production robot/material/client adoption and the full two-browser acceptance
remain outstanding. Upstream material/robot authority is still in PR #6 / PR #16.

## Implemented boundary

| Path | Domain ownership | Shared mechanisms | Persisted compatibility |
| --- | --- | --- | --- |
| Existing game service/MCP | `server/domains/game.mjs`: world, membership/invites, balance, recovery, processing, completion and private/history projections | `SqliteAuthority`, every native game command through `executeTransactionalCommand`, exact resource/time helpers and `SqliteEventHistory` | Native protocol v3 and SQLite schema 2; unchanged job/inventory format and receipt fingerprints |
| Work-cell service/MCP | `server/domains/work-cell.ts`: instrument, finite fixture stock, timed modeled assay, rates, interruptions and result projection | Real `DomainRegistry` envelopes, transactional commands, resource ledger/reservations, job worker and persisted history | Envelope v1, `work-cell@fixture-v1` / schema 1, dedicated SQLite schema 100 |

`SqliteAuthority` owns native account/session hashing, SQLite locks, transactions, heartbeat
and database-version guards. It contains no required match, tower, opponent or winner model.
Both adapters reuse it. Accounts remain scoped to their database; sharing implementation does
not implicitly merge game/work-cell accounts. Transports resolve the current session before
accepting a principal and never accept a trusted owner or simulation clock from the client.

The versioned game compatibility module retains its original progression and exact yields.
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

Native game schema 0/1 uses the existing explicit upgrade to schema 2 in the versioned domain
module. Schema-2 saves retain their IDs, inventory, job phases/progress, observations, accounts,
rule pins and immutable receipt bytes. The native adapter continues the old rate/rounding and
ordering model. Unsupported database versions fail before an upgrade; incompatible module
pins fail with instructions to restore a compatible backup or use the exact runtime version.
There is no latest-version fallback or automatic destructive repair.

Work-cell storage uses schema 100 and refuses a game save. The game service refuses schema
100. Unknown work-cell module/schema pins fail startup rather than rerolling stock or erasing
receipts. This is a new bounded fixture database; old test-fixture tables are not a migration
source. The registry's offline migration hooks are not invoked automatically on reads.

Stop the relevant service before switching binaries. Back up using SQLite's backup facility,
for example `sqlite3 /absolute/path/runtime.sqlite '.backup /absolute/path/runtime-backup.sqlite'`.
Keep the entire database, including history and cursor keys, together. Do not copy a live main
database file while dropping its WAL. Test the backup with the matching module/runtime before
an upgrade. Restoring it discards work after that backup; never combine newer receipts with an
older inventory or job state. The native game can return to the preceding v3 binary because
its wire/state/receipt format is preserved; a work-cell database requires this service or its
compatible successor. No conversion to robot v5 saves is claimed here.

## Evidence and remaining #33 work

`npm run test:simulation` includes 57 tests. Six adoption tests cover actual neutral HTTP/MCP,
one-owner authority, process contention, resource waits, discarded-response retries, finite
energy delivery, exact results, revocation, SQL rollback, forced process death before COMMIT,
service CLI restart, preserved receipts/state and unsupported-version recovery instructions.
The native game test retains IDs, inventory, active jobs, observations and receipt bytes across
the module split/reopen. Existing game/world/service/MCP, production build and room/scene MCP
regressions also pass locally.

Separate unchanged material/robot code at `5e306c2033bfdb15510f98f575f937e1578f6a3f` passes
its material-library/authority and survey/collect/return/recharge/interruption/retreat/accounting
suites. The downstream tower-defense HTTP/MCP integration also passes against that pinned
v5 checkout. These are baseline evidence, not proof that the v5 client or robot jobs use the
new adapters. The local two-browser rerun could not start because Chromium is absent; the
Playwright download failed with a truncated archive. No browser pass is claimed for this step.

Remaining acceptance: rebase/integrate material/robot PR #6/#16 with the adopted game module;
define faithful generic envelope/resource/job migration for their saves; adapt and run the
strict v5 tower-defense client against that authority; run the required two-account desktop/
mobile browser recovery/reconnect scenarios; and publish that integration evidence. Keep #33
open until these criteria pass. This PR is a concrete first adoption step, not an excuse to
mark the full game/client migration complete.

For later domains, register trusted exact-pin modules with strict schemas, domain invariants,
explicit projections and finite initialization. Select worker/resource policies by the exact
pin; add explicit versioned migration and compatibility tests before accepting older saves.
Never load executable module paths from client input or default unknown versions to latest.

Full FIELD-LAB adoption remains #10, evidence/model validity remains #11, and authoritative
scene/CAD bindings remain #12. They can depend on epic #27 / #33 and the shared contracts,
worker, resource and history APIs introduced here; this work creates no second lab viewer,
physical-control claim, collision certification or scientific validation path.
