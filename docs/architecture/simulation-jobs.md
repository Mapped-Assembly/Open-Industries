# Durable jobs and authoritative time

Status: shared internal scheduler API for #31, following #29 and #30 under epic #27.

`server/simulation/jobs.ts` proposes deterministic checkpoint updates. `runJobWorker` loads,
advances, validates and saves under an adapter's existing transaction. It needs no client
connection, match lifecycle, session token or second participant. Trusted domain modules
supply phases and resource effects. The single-operator SQLite fixture demonstrates the
complete storage path; it is not a new production login or public job endpoint.

## Checkpoints and states

Each schedule pins instance identity and module/schema version, a time quantum, server-time
high-water mark, processed cursor, jobs and domain data. Each job stores owner, priority,
dependencies, phase definitions, phase index/work, completed step count and timestamps.
Resources and reservations live in the same proposed domain state, using the #30 ledger.

| State | Meaning and next action |
| --- | --- |
| queued | No work committed yet; eligible at the next full boundary after creation/resume. |
| running | Last eligible step committed; continue its phase at a future boundary. |
| waiting-for-resource | No work or side effects committed for the attempted step. Reason identifies missing energy, feedstock or dependency. Retry at the next eligible boundary. |
| paused | Explicit operator interruption; no automatic work. Inspect its reason and issue an authorized resume. |
| completed | All phase steps committed; terminal and cannot resume/cancel. |
| cancelled | Explicit cancellation; domain hook releases only unused allocations. Terminal. |
| failed | Declared domain fault or failed/cancelled dependency. Domain cleanup runs once; terminal. |

Dependencies must exist within this schedule and form an acyclic graph. Eligibility uses
dependency states at the **start** of each global boundary. A dependent begins no sooner than
the boundary after its prerequisite completes, regardless of array order or priority.
Failed/cancelled dependencies fail their active dependents with `dependency-terminal`.
Paused dependents remain explicitly paused until resumed or cancelled.

## Time and bounded catch-up

Only a trusted server adapter supplies `clock()`. `authoritativeTime` rejects negative,
fractional, nonfinite and unsafe millisecond values and clamps rollback to the saved high-water
mark. The current game adopts this same guard in its existing advancement function; its
processing rates, ordering, wire contract and database schema are unchanged.

The shared scheduler commits fixed boundaries of `quantum_ms` (1–60,000 integer milliseconds).
Phase durations must be positive exact multiples of that quantum. A trusted step hook receives
the elapsed quantum, phase/checkpoint, completion flag and boundary time. Domain code supplies
rate and energy models; no shared code invents physical process rates or robot behavior.
The fixture declares a 1-second quantum and spends 1 MJ per worked step.

A worker call processes at most `maxSteps` (1–1,000) global boundaries. Later time remains
persisted as `observed_at_ms - cursor_ms`; later calls drain the same debt without discarding
downtime. Partial-quantum time is retained. Rollback does not reduce observed time or produce
new work until the clock catches up. Frequent calls and an equivalent long catch-up execute
the same boundaries and declared effects, provided domain policy and external inputs match.

Enqueue and controls refuse while at least one full boundary of debt remains. Callers drain
bounded debt before accepting the action, inside their existing serialized command path.
Creation/resume records the observed action time. The first credited work boundary must be
at least a full quantum later, so fractional-time actions cannot claim historical work.
Quantization can delay work by less than one extra quantum. Paused/waiting time earns no
banked work. Recovery, retreat, pause and resume run only at a committed checkpoint.

## Resource contention and atomic effects

Each boundary orders jobs by descending priority, ascending creation time, then ASCII ID.
There is no implicit fairness or priority aging; a domain must choose an explicit priority
policy if it requires those properties. Two workers must serialize through the same storage
transaction, just as commands do. A SQL row lock/equivalent can implement other adapters;
an in-memory mutex is insufficient across independent service processes.

The step hook receives a copied domain proposal. `worked` commits its returned domain data
and one checkpoint increment together. `waiting`/`failed` discard its attempted mutations;
previously committed work, outputs and spending remain. The fixture couples reservation,
energy cost and material output under that one decision. If a resource operation or storage
write fails unexpectedly, the whole worker transaction rolls back, not just the job record.

Effect IDs are `<job-id>:step:<completed-step-count>`. Domain code derives operation IDs from
them and writes ledger changes under the job owner and exact rule pin. Repeated worker calls
at the same time perform no additional steps. A killed transaction either committed its
checkpoint and effects or neither. Any external I/O needs a transactional outbox/idempotent
consumer in a separately reviewed integration; callbacks here must be synchronous pure
proposals and must never send an external side effect.

## Interruption, recovery and failure

Each phase declares permitted controls. The command layer must resolve authentication,
authorize instance access, supply the trusted principal, and persist the control proposal and
receipt together. `controlJob` additionally checks job ownership and rejects terminal jobs.
Exact command retries reuse #29 receipts rather than invoking the control twice.

Pause preserves the current checkpoint and allocations. Resume is legal only from paused and
starts earning future work. Recovery/retreat invoke domain-specific resource/location proposals
and leave the job paused for explicit resume; the core does not teleport robots, assume a
safe path or undo work. The neutral fixture keeps those actions at the same checkpoint; actual
robot recovery/path rules remain in the robot domain. Cancellation/failure invoke a domain
cleanup hook that must release only unspent reservations. Existing outputs, waste and spent
energy remain allocated. A noninterruptible phase rejects its undeclared controls.

## Validation and integration limits

`npm run test:simulation` now includes 40 tests. Job coverage verifies exact frequent/catch-up
state equality, clock rollback/retry, bounded persisted debt, fractional enqueue/resume,
energy waits and finite battery transfers, priority/contention, dependencies, invalid/cyclic
checkpoints, interruptions/cancellation/failure, command receipt replay and real SQLite
transactions. Independent worker processes progress without a browser, race at the same clock,
and restart after a hard kill **after the state write but before COMMIT**. Recovery neither
duplicates output nor repeats spending. A failed persistence transaction also rolls back.

The existing main game/service/MCP suites and build are regression checks for the adopted time
guard. Separately, unchanged material/robot code pinned at
`5e306c2033bfdb15510f98f575f937e1578f6a3f` passes its material authority and survey/collect/return/
recharge/interruption/retreat/restart/tick-equivalence suites. This is baseline evidence, not a
claim that those branch-only systems use this scheduler.

There are at most 128 retained jobs and 64 phases/job, plus the common bounded JSON limits.
Terminal IDs/checkpoints are retained; no implicit compaction or ID reuse occurs. The resource
ledger still has its finite history bounds. Adapters must size worker batches appropriately
and fail closed on exhausted history; compaction requires a future versioned checkpoint policy.
This API does not install a second timer beside the existing game scheduler, migrate game
orders/saves, or rewrite robot event-boundary logic. Production service wiring, catch-up policy
selection and migration remain #33. Shared external event history/replay remains #32. The
persisted internal checkpoints/ledger are not a public event stream or scientific validation.
