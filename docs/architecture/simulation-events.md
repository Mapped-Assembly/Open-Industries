# Persisted simulation history and authorized replay

Status: #32 under epic #27, following the transactional command (#29), resource (#30) and
job (#31) mechanisms. The current game service adopts the history store. The neutral work-cell
HTTP fixture composes the same APIs through real SQLite. Full production neutral-service and
shared-scheduler adoption remains #33; scene/CAD bindings remain #12.

## Atomic append and identity

`SqliteEventHistory` uses the caller's existing `DatabaseSync` connection. It never opens a
second transaction, commits work, or emits an external side effect. Its initialization,
append, replay and read operations require an active transaction. Node 22.16+ supplies the
`isTransaction` guard. Existing command adapters still own authentication, revisions and
immutable receipts; workers still own their serialized state write.

The additive `simulation_history` and `simulation_events` tables store a private cutover
checkpoint and a bounded ordered tail. `simulation_history_keys` holds the local cursor key.
Game saves append in the same transaction as match state and, for commands, the existing
receipt. The extracted inspection path uses this same save callback. Worker ticks record
progress without inventing a user command or receipt. A failed state, event, head or receipt
write rolls back all related changes. Nothing is broadcast before COMMIT.

Each version-1 event has a persisted UUID, instance ID, increasing sequence, state revision,
logical simulation time, exact module/schema pin, command/worker/system source and actor,
instance-local entity/job IDs, unit declarations, provenance and domain payload. The state
replacement is private. Source command IDs match existing receipts and responses. Event
sequences order all writes, including multiple events at the same simulation timestamp or
revision; they are independent of wall-clock response time. Job steps keep #31's stable
effect IDs and resource entries keep #30's command/job identities in the persisted state.
Domains validate actual referenced entities/jobs and resource semantics.

Appending compares the expected sequence under the storage lock and rejects stale writers.
Exact command retries return their existing receipts before saving/appending. History is
not a replacement deduplication authority: adapters must retain their receipts/checkpoints
and never rerun a pruned command because its event is absent. Raw `append` rejects a stale
sequence rather than silently treating it as a new effect. Unchanged game worker saves do
not add events. Independent writers serialize through SQLite, including after restart.

## Supported replay boundary

Replay reconstructs **persisted materialized state**, not a fresh execution of commands,
randomness, resource rules or external instruments. Starting at the retained checkpoint,
each event replaces that private state with its recorded post-state. The store verifies
contiguous sequences, chain hashes, a stable rule pin, monotonic revision/time and the head.
Domain validators then check snapshots and event states before projection.

This reproduces the exact declared authoritative JSON state under its recorded pin. It does
not prove that domain code originally computed the right result or that an external source
was truthful. Hashes detect accidental corruption; a database administrator able to rewrite
both data and hashes is outside this integrity boundary. Reading/replaying never calls job,
command or resource effect handlers and cannot charge energy or award another output.

Existing saves receive an explicit current-state checkpoint on upgrade. Older events are not
fabricated. Match state, receipt bytes and public v3 game tools remain compatible; the new
tables do not rewrite those records. A different rule pin cannot silently enter the same
stream; a future migration must define an explicit cutover. The current game uses its existing
progression, not a second scheduler. Its persisted logical time holds paused work at the last
checkpoint rather than resetting playback to zero.

One worker transaction can cover several internal job boundaries. Its event records the
committed post-state and the resource ledger's accumulated step entries; it does not promise
a separately projected event for every intermediate physical motion. Consumers must not
invent missing motion samples. Finer scene-stage records and CAD evidence remain #12.

## Authorized snapshots, events and errors

The public read path requires an `EventProjection`: a current authorization check, state
validator, snapshot projection, event projection and explicit projection version. Callbacks
receive isolated, recursively frozen values. Snapshot/event callbacks select public fields
explicitly and may return null to hide historical data. The store never merges raw event
metadata, actor IDs, private payloads, hidden state, hashes or counters into their output.
Adapters must resolve the principal from a current session and consult current ACLs, including
any ACL stored outside the history stream. Authorization runs on every request and resume.

The game projection reuses the existing owner snapshot rules. Opponent command events are
omitted; historical checkpoints before a player joined return null for that player. Map
deposit positions and IDs remain public as in existing reads. Assays, private machine IDs,
hidden world truth, invite hashes and other owners' inventories are not exposed. Historical
snapshot time comes from the event, not the current presentation clock; live scheduler health
is omitted from history snapshots. Rule pins are explicit. Neutral projections expose owned
job status/checkpoints/reasons and omit hidden composition and observation payloads.

Missing/unauthorized scope and foreign or altered cursors return safe `NOT_AVAILABLE` errors.
Expired retained positions return `CURSOR_EXPIRED` after authorization. Invariant, SQL and
callback diagnostics are never returned by the service. Projection failures fail closed;
there is no raw-state fallback. Raw `head`/`replay` methods are internal storage operations
and must never be exposed as client transports.

Provenance distinguishes `simulated`, `external` and `observation-derived`. Simulated and
derived records cannot claim `observed`; external records cannot claim `modeled`, and external
or derived records require source/revision/observation references. These structural rules do
not validate scientific evidence. Domain modules retain responsibility for unknown/null
observations, evidence ownership, observation validity and appropriate public projections.
The current game's sensor/assay events are explicitly simulated/modeled, not physical evidence.

## HTTP, cursors and retention

The server-to-server game service adds authenticated `POST /simulation/history`, with its
existing bearer session, JSON body limits, no-browser-Origin restriction and no-store response:

```json
{"instance_id":"the-match-id","cursor":null,"limit":20}
```

It returns `{version:1, snapshot, checkpoint, events, next_cursor}`. Snapshot is the authorized
state at a fixed head; checkpoint is the authorized retained base. Events are authorized
domain views, not raw state replacements suitable for client-side reconstruction. Clients
hydrate the snapshot and use event views for explanation/playback. `next_cursor: null` ends
that fixed-head read; request `cursor:null` again for a fresh head. No new MCP game tool or
second lab viewer is introduced.

Cursors use AES-256-GCM and bind principal, instance, projection version, processed position
and the original head. They are opaque; raw private-state hashes and sequence counts are not
client tokens. Restart preserves the database key and permits resume. Appends after a first
page do not move that page's snapshot forward. Filtering happens before visible pagination,
so hidden-only rows do not produce empty pages or expose their sequence gaps. Same-time events
retain append order. Limits are 1–100 projected events per page; no sequence is a wall clock.

Default retention keeps at most 256 raw events and 16 MiB of event JSON per instance. Configured
bounds are 1–1,024 events and 2–64 MiB. Removing old events atomically advances the checkpoint
to the last removed post-state; replay remains exact from that point. The common JSON limits
bound each input/checkpoint and the complete projected response to 2 MiB. Large domains should
provide compact public projections and smaller pages. The retained checkpoint adds at most
one bounded state beyond the event-byte allowance. This is bounded recent history, not an
unlimited audit archive or a promise of time-based retention/disk reclamation.

If pruning overtakes a cursor's position or fixed head, resume returns `CURSOR_EXPIRED` (HTTP
409). Refresh a new snapshot; do not reset a job's logical time. While a cursor remains valid,
the retained base may advance, but the materialized fixed-head snapshot remains unchanged.
Backup/restore must keep the history tables and cursor key together. Key loss/rotation requires
fresh cursors. No implicit rule migration, export of raw private history, or external I/O
outbox is installed here.

## Validation evidence

`npm run test:simulation` includes 51 tests. New coverage exercises materialized replay, hidden
canaries, encrypted cursor scope/tampering, fixed-head pagination, revoked access, retention,
provenance, pin/time/sequence rejection, corrupted history and safe callback errors. SQL fault
injection targets instance state, event insertion, history head and receipts. A worker is killed
after state/history writes before COMMIT; restart preserves the prior checkpoint and resource
spending, and concurrent writers preserve ordered committed history.

Real HTTP tests cover the production game service and a separately labeled test-only neutral
service over the actual shared command/worker/resource/history adapters. They verify immutable
command retries, owner/opponent/outsider projections, game service restart and cursor resume,
revocation, shortfall/pause/cancel/dependency-failure history and stable logical time. The
neutral fixture transport is not a production authentication or neutral-service deployment.

The main game/service/MCP suites, production build and room/scene MCP regressions are also
checked. Unchanged material/robot code at `5e306c2033bfdb15510f98f575f937e1578f6a3f`
is checked separately as a baseline; its survey/collect/return/recharge/interruption/retreat
and accounting suites are not claimed to have adopted this event store. #33 owns that broader
production reuse. #12 still owns scene occurrence/component/joint mappings, source frame
revisions, instrument motion, contact/collision/travel checks and export/reimport playback.
