# FIELD-LAB-01 durable runtime

Issue #10 adopts the shared simulation core for the frozen eight-hour laboratory benchmark.
The lab is a one-operator domain, independent of the recovery game's two-player lifecycle.
It uses local SQLite authentication and needs no Supabase, cloud account or provider secret.

## Versioned contract and ownership

The exact module pin is `field-lab@FIELD-LAB-01-v1/schema1`, envelope version 1, SQLite schema
101. `server/domains/field-lab.ts` owns the trusted recipes, slot policy, instrument admission,
finite delivery plan and modeled outcomes. The shared registry validates strict commands,
snapshots and state; event-job checks, event clock, balance ledger v2, command executor,
SQLite authority and authorized post-state history provide the core mechanisms.

Each lab has 24 stable sample jobs and an exclusive instrument reservation. Job checkpoints
bind intake/assay/result phases to the existing `instruments` and `pipette` scene instance IDs.
Equipment entities bind seven existing instance IDs to the canonical-JSON SHA-256 of the frozen portable
scene (independent of checkout line endings). The saved model digest pins the scenario input file as well as the module version.
Changed or unknown pins/digests fail with an exact-runtime/complete-backup remedy. This new
schema does not import or convert game, work-cell or historical in-memory saves.

These are declared runtime-to-scene references. The renderer does not control the clock,
award outputs or dispatch physical equipment. Interactive scene synchronization remains #12;
scientific evidence/calibration is #11. Completion records simulated/modeled provenance and
`assay_validity: not-validated`. It is not a measurement, certification or cold-chain guarantee.

## Frozen one-day semantics

The six scenarios and all 32 timeline rows match the original
`benchmarks/field-lab/simulate.mjs`, including its ordering: district delivery, solar credit,
battery spill, base demand, housekeeping water, then at most one sample admission per slot.
No recipe or scenario coefficient is accepted from a client. Units are integer milliseconds,
millijoules, microlitres and component counts (1 Wh = 3,600,000 mJ; 1 L = 1,000,000 uL).

The original model books a whole 15-minute utility interval together. The durable policy books
that supply/demand at the **start** of the interval and reserves a job's inputs, then exposes
running work during the interval and completes at its end. A timeline row is recorded before
booking the next interval. Intermediate snapshots therefore include the current slot's booked
utilities and held inputs; the row and final balance reproduce the frozen model. This is a
slot accounting convention, not a continuous electrical, chemical or fluid simulation.

The recipe reserves 2 tips, 1 assay kit, 350,000 uL water and 43,200,000 mJ energy for 900,000 ms.
Admission leaves the original 80 Wh and 0.5 L margins in available stock. One instrument can
hold only one job. Paid water/energy use cumulative integer rounding against work progress,
so repeated ticks, clock rollback, disconnects and restart cannot refund or duplicate it.
Solar is the only issued resource and must equal the exact declared slot yield. All district
water/tips/kits exist in depot accounts at initialization; arrival is an idempotent transfer,
not issuance. Opening, district and solar lots remain distinct through stock, reservations,
consumption, spill and waste. Common posting checks and domain lot invariants conserve each.

`generated_mj`, `spill_mj`, base served/unmet energy, process energy, sample/service water,
service-water unmet demand and delivered quantities are explicit cumulative totals checked
against paid progress and balances. Unmet demand is a counter, not fictitious stock. The
battery capacity is enforced during generation and refund; unused energy returned to a full
battery becomes spill. Tips/kits used or opened on cancellation go to solid waste, sample
water to liquid waste and housekeeping water to service waste. Spent energy is never reusable.

## Jobs and controls

| State/control | Resource and scheduling semantics |
| --- | --- |
| queued | Sample has not been admitted; later arrivals retain their fixed arrival time |
| waiting-for-resource | Actionable `await-kits`, `await-tips`, `await-water`, `await-energy`, or combined reason; no input consumed |
| running | Exclusive instrument and inputs held; time, water and energy paid once |
| pause / paused | Holds instrument and unused inputs; `operator-paused`; utilities and deliveries continue |
| resume | Continues remaining paid duration; no second reservation or creation grant |
| cancel / cancelled | `operator-cancelled`; releases unused water/energy, wastes opened tips/kit, retains spent resources |
| fail / failed | Operator-declared `modeled-instrument-fault`, same release/waste semantics; no result or physical fault claim |
| completed | Exactly one modeled result, immutable terminal checkpoint; all recipe costs paid |
| day end | Unfinished work becomes failed with `day-ended-review-unserved-work`; no invented completion |

Automatic dispatch follows the frozen admission order. Manual dispatch lets an operator issue
`start` for an arrived queued/waiting sample; it still enforces one admission per slot, one
instrument and identical reserve margins. Cancellation does not allow a second admission in
the same slot. A paused job can span slots; another job waits until the instrument is free.
These controlled/interrupted runs are not claimed to equal an uninterrupted baseline.

Limits: six retained labs/account, 24 jobs/lab, one district delivery, 32 utility intervals,
256 receipts/lab and no refill/delete/reset API. The worker visits at most 100 unfinished labs
per pass and uses 128 event boundaries per lab, enough to drain the finite day. Every client
may be disconnected; the service timer remains authoritative. History retains at most 64
post-state events / 2 MiB plus its complete checkpoint. Immutable command receipts survive
history and ledger-tail compaction. Expired history cursors require a fresh snapshot.

## Local service and API

Use Node 22.16+ and `npm ci`, then:

```bash
ASTRA_FIELD_LAB_ALLOW_SIGNUP=true npm run field-lab:server
```

The service binds `http://127.0.0.1:8792` and stores its private database in
`.astra/simulation/field-lab.sqlite`. Override `ASTRA_FIELD_LAB_PORT` / `ASTRA_FIELD_LAB_DB` as
needed. Signup is disabled by default. In PowerShell, set
`$env:ASTRA_FIELD_LAB_ALLOW_SIGNUP = 'true'` before the npm command.

Register/login using `/auth/register` or `/auth/login` with
`{"username":"operator","password":"choose-a-local-password"}`. Send the returned session
only as `Authorization: Bearer <token>` from a trusted application backend. The transport
rejects browser Origins, query strings, extra fields, oversized bodies and client clock values.
`GET /simulation/describe` publishes the exact command and snapshot schemas without credentials.

```text
POST /simulation/instances
{"command_id":"lab-day-1","scenario":"baseline","dispatch":"automatic"}

POST /simulation/read
{"instance_id":"<returned-instance-id>"}

POST /simulation/command
{"command_id":"pause-intent-1","instance_id":"<id>","expected_revision":<fresh-revision>,"action":"pause","payload":{"job_id":"sample-1"}}

POST /simulation/history
{"instance_id":"<id>","cursor":null,"limit":20}
```

Other actions are `start`, `resume`, `cancel` and `fail`, each with exactly `payload.job_id`.
The six scenario IDs are `baseline`, `missed_delivery`, `cloudy_power`, `water_ration`,
`combined` and `resilience`. Creation requires explicit `automatic` or `manual` dispatch.
A stale revision fails `CONFLICT`; read fresh state and create a new intent. After a lost
response, retry the identical command ID, revision and payload, which returns its original
immutable outcome. Altered reuse fails `COMMAND_ID_REUSED`. Cross-lab reads/mutations fail
`NOT_AVAILABLE`; expired/revoked sessions fail `AUTH_REQUIRED`. No MCP tool additions or
changes to recovery-game wire v5 are required for this API adoption.

Back up the complete SQLite database with SQLite backup while the service is stopped, or
use its live backup facility while retaining the WAL correctly. Keep state, receipts, history
and cursor keys together. Restore only the complete compatible backup with its exact module;
never combine old inventory with newer receipts. No production deployment is part of this PR.

## Reproducible evidence

```bash
npm run test:field-lab
npm run test:simulation
```

The first command creates a real temporary SQLite database, runs all six complete days,
compares every row against the frozen reference, closes/reopens the database and checks state
hashes and immutable creation receipts after fresh login. It writes
`deliverables/field-lab/durable-results.json`, with model/input pins, per-scenario totals,
timelines and saved-state hashes; it removes only its private temporary test database.
The existing historical benchmark inputs/results remain unchanged. FIELD-LAB CI publishes
the durable evidence alongside the original replay on both Linux and Windows.

Shared-core tests include the real authenticated HTTP service and file-backed adapter,
private-lab refusal, strict request validation, all job controls, paid cancellation, clock
rollback, typed scene bindings, altered-state rejection, receipt-write transaction fault,
independent process writers racing for the last kit, independent no-client worker progress,
hard process kill/restart, scheduled delivery restart and process death before COMMIT.
Existing game/material/work-cell and scene-authoring CI remain required regression gates.
All results establish modeled software behavior, not physical laboratory performance.
