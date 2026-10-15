# Event time and metered resource accounting

The game and neutral work-cell share authority, envelopes, registry validation, transactions,
history and `advanceEventClock`. Domain modules supply physical rates and legal outcomes.
The core does not require two players, a tower, combat or a winner.

## Clock and jobs

`advanceEventClock` owns a monotonic cursor, observed server-time high-water mark, bounded
iteration and stable interval effect IDs. Trusted policy selects the next positive integer-ms
boundary and proposes its effects. It cannot change either clock field. A zero next interval
means a fixed-quantum policy has less than a complete quantum remaining. Errors leave the
input unchanged; storage commits only a fully validated result. Downtime beyond the budget
remains explicit debt rather than discarded time or an unbounded startup loop.

`advanceJobSchedule` uses this driver for its original fixed-quantum ordered/dependency-aware
work policy. Game policy uses exact robot/process/charging event boundaries, including 250 ms
travel and final fractional-rate charging intervals. It preserves native priority and paused
states. The game uses a 1,000-boundary budget; the work-cell uses 100 quanta per instance.
Both independent service timers keep advancing after clients close.

Event-driven jobs have immutable ID, owner and arbitrary domain kind; common states include
queued, running, waiting-for-resource, paused and terminal results. Paid integer milliseconds
cannot regress or exceed elapsed time. Terminal checkpoints cannot change or resume, active
jobs cannot be pruned, and creation/pruning requires an explicit trusted command policy.
The bounded list retains at most 1,024 jobs. Native route, phase, reservations and recipe
fields live in each domain checkpoint. They do not create a second persisted job list.

## Two resource policies

| Policy | Purpose | Conservation and replay |
| --- | --- | --- |
| Reservation ledger v1 | Finite discrete workflows such as work-cell | Reserved inputs, paid fixed work, partial outputs/waste, release only unused stock, exact operation retries |
| Balance ledger v2 | Native event-driven workloads with metered energy | Immutable accounts, simultaneous balanced postings, explicit policy-approved issuance, lifetime totals and bounded replay tail |

The native adapter proposes all finite material/energy/component allocations. Common v2
checks validate exact integer units, capacity, per-resource conservation, immutable account
metadata and non-debitable spent/waste/spill sinks before accepting them. Constituent grams
cannot turn into another resource. The policy must explicitly approve any proposal. Metered
credits allow only mJ; bootstrap credits allow mJ or component counts, never mass. The game
policy permits exactly ready solar W × elapsed ms and the one newly joined crew's existing
starter grant. Commands cannot meter time, award another grant or silently refill stock.
Opening balances preserve already-existing saves without reconstructing past effects.

Game balances include deposit stock, robot-held reservations, cargo, available batches,
work in progress, component allocations, base/robot batteries and every energy sink.
Native records remain necessary domain state, but cannot commit unless these allocations
reconcile with the common ledger. Native material and robot invariants also run. Observations
use typed targets/owners and modeled provenance in the envelope, with original record IDs and
payloads. Own v5 projections reconstruct the native shape; raw envelopes remain private.

V2 bounds are 4,096 accounts, 16,384 nonzero allocations and 32 retained posting entries.
A checkpoint retains older balances, issuance totals, sequence, time and hash; it does not
reset lifetime conservation. Sequence plus request hash detects altered reuse; identical
retained effects replay exactly, and compacted stale effects are refused. Native command
receipts remain immutable in SQLite and are not compacted with this tail. Full state history
has its own existing retention/checkpoint policy. Ledger hashes detect inconsistent stored
records; they do not defend against a privileged database administrator rewriting all data.

## Production transaction and compatibility

SQLite schema 5 stores `native-game@dump-world-v1/schema1` in the existing match table.
Jobs/observations are removed from native metadata and owned by envelope schedule/evidence.
`GameDatabase.load()` is a lossless compatibility view; `loadInstance()` validates canonical
storage. Domain proposals atomically replace state and any changed typed entities/evidence.
The common executor commits the validated envelope, authorized post-state journal and native
receipt in one SQLite transaction. A receipt failure rolls back reservations and progress too.
An identical lost-response retry returns its original receipt before attempting another effect.

Wire v5 stays unchanged. Existing native schemas upgrade once inside the state/version/history
transaction; current native v5 revisions, IDs, paid work, observations and receipt bytes survive
packing. Old journals retain their original wrapper pin. `game-history-v3` projects both formats
without replaying physical effects. Unknown exact pins fail with an explicit recovery remedy.
Back up the complete SQLite database before upgrading. Older binaries need the complete
pre-upgrade backup; receipt/inventory/history files cannot be mixed across versions.

The old native advancement methods remain only for pre-envelope upgrades and reference
compatibility tests. Production worker, reads and ordinary commands use the common event
clock, job checks and balanced resource settlement. Domain rules still own routes, rates,
charger priority, sensor modeling and physical completion. This is modeled software behavior,
not physical validation, FIELD-LAB completion or scene/CAD authority binding (#10–#12).

Reproduction and verification commands are in [shared runtime adoption](shared-runtime-adoption.md)
and [runtime verification](../game-runtime-verification.md).


Game post-state history retains at most 64 events / 2 MiB plus its complete checkpoint.
The envelope already contains a bounded resource replay tail. This smaller game journal
bounds synchronous history verification so account login and reconnect remain responsive
while both crews poll. Compaction preserves exact current replay and immutable command
receipts; an overtaken pagination cursor requires a fresh snapshot. The neutral fixture's
existing history defaults are unchanged.
