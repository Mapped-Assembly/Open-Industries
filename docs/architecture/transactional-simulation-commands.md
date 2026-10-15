# Transactional simulation commands

Implements #29 under epic #27, following the contracts in #28. The shared executor is now used by the existing `inspect_deposit` game command and by a neutral work-cell SQLite test fixture. No other gameplay command is moved in this PR.

## Transaction boundary

`executeTransactionalCommand` is a synchronous internal API over a typed `CommandAdapter<State, Result>`:

1. Copy bounded finite JSON and validate the strict common command envelope (8 KiB maximum). Clients cannot add a principal/owner field to this envelope.
2. Enter the adapter's existing `BEGIN IMMEDIATE` transaction and resolve the authenticated principal server-side. Authentication runs even for receipt replay.
3. Compute the immutable request key and look up that principal's command ID. A different request under the same ID fails with `COMMAND_ID_REUSED` before any mutation; the caller learns only about their own command namespace.
4. Load the target instance and verify its ID and principal scope. Exact receipt replay still requires current authentication and membership. If a receipt exists, return its original result without advancing time, running transitions or writing rows.
5. Check the expected revision before advancing simulation time. Invoke optional trusted catch-up preparation, then obtain the prepared state's revision. This preserves the current game's check-before-catch-up semantics.
6. Invoke the domain transition against a copied state with a frozen command/context. The domain cannot choose the instance ID or command revision. Core increments the prepared revision once and calls the adapter's invariant validation.
7. Build a result from an isolated copy of validated state, then save state, append proposed events through the transactional hook, and insert the immutable receipt. Any failure rolls back the transaction, including prior state/event writes.

The adapter owns the existing connection and tables. The executor does not open another database, start an independent scheduler, accept a browser principal, or create generic production storage. All callbacks must be synchronous trusted application code and must not perform external I/O. The adapter's transaction implementation is part of the trusted integration boundary, not something an API caller can supply.

## Registry domain rules

`DomainRegistry.transition` validates the common command shape, instance scope, expected revision and the exact module's strict `{action, payload}` schema. It calls the module's authorization and transition-proposal hooks with recursively frozen copies. Authorization refusal is `NOT_AVAILABLE`; illegal transitions, malformed proposals and failed resulting-state invariants yield `INVALID_TRANSITION` without private callback diagnostics.

A proposal changes only domain state and declares an array of bounded JSON events. The registry validates the resulting instance but does not commit it, change the core revision, invoke migrations or write events. The storage adapter connects that proposal to the transactional executor. It must validate the complete resulting state before saving. Domain rules remain pinned by the instance's exact module/rule/schema versions.

The command passed to an adapter retains its original expected revision and request identity. If trusted scheduler catch-up increments the state revision, a registry-based adapter must pass the prepared revision to its internal proposal check while preserving the original command for receipts. The adopted legacy game adapter uses its existing domain handler directly; it already performs catch-up under the same transaction. Clock ownership and broader catch-up behavior remain #31.

## Game compatibility adapter

`GameDatabase.inspectThroughCore` normalizes the already schema-checked game request into a common command. It then reuses:

- `GameDatabase.transaction`, native account/session authentication and the same SQLite file;
- the existing `matches`, `members` and `receipts` state, with no new tables or schema migration;
- the exact historical canonical request key `{name, arguments}` and original result serialization;
- shared existing game preconditions for active state, receipt quota and scheduler health;
- `advance`, the existing domain `command` handler, extracted `assertState`, authorized `snapshot` and published response validation.

The existing MCP request/response version remains unchanged. Known game error codes retain their published mapping. The executor's unsupported-event failure maps to the existing game invariant error. An identical old-format receipt can still replay after later progress; reads after replay remain necessary because the receipt contains a historical snapshot.

New inspection, retry, stale-revision and failure paths all use one transaction. Other game commands continue through existing dispatch. `checkMutation` and `assertState` are shared helpers, avoiding divergent validation between the two paths.

The implementation bases on main after #34. The material/robot runtime PRs #6/#16 were still unmerged at implementation start. This PR does not merge those branches. Reconcile their expanded domain-specific `assertState`/readiness rules when landing them; keep their versioned schemas and robot privacy/conservation checks. The compatibility result uses the discovered game contract version, not a newly invented API version.

## Events and storage limits

The typed `appendEvents(instanceId, commandId, principal, events)` callback is reserved for transactional event append. Nonempty proposals fail closed with `EVENTS_UNSUPPORTED` if the adapter provides no append hook; events are never silently discarded. Append and receipt failures roll back state.

The neutral tests write events into a **test-only table** to prove transactional behavior. No generic production event log, replay API, retention policy or event transport ships here. Those remain #32. Production generic instance persistence/migration and complete game/work-cell adoption remain #33.

The common command limit is 8 KiB, canonical request keys are bounded to 32 KiB, and proposed events are bounded to 256 JSON objects within the shared JSON limits. The game keeps its existing tighter request/result/schema checks. Module rules must validate semantic event contents; schema-shaped objects alone do not establish correct resource accounting or evidence.

## Reproduction and evidence

```sh
npm ci
npm run test:simulation
npm run test:mcp-game
npm run test:mcp
npm run test:mcp-scenes
npm run build
```

The simulation suite includes real temporary file-backed SQLite and separate Node processes. It verifies immutable replay across connections/reopening, conflicting ID reuse, stale revisions, unauthorized scopes, malformed/client-identity fields, domain transition/invariant refusal, failed state/event/receipt writes, and concurrent writers. Two simultaneous identical commands commit once; different commands at the same revision produce one success and one conflict.

The adopted game test checks native account authentication, original published response keys/version, exact request fingerprint and receipt bytes, rollback on receipt-insert failure, cross-owner denial, and replay after time advancement. Existing real game service/MCP tests continue to cover browser-independent progress, process restart, revocation and exactly-once material outputs. A neutral fixture's authenticator is deliberately test-only; it is not a replacement production login flow.

This PR establishes command atomicity. Resource mechanisms are added in [#30](simulation-resources.md), durable job/worker APIs in [#31](simulation-jobs.md), and [persisted history with authorized replay](simulation-events.md) in #32. Production generic adoption/migrations (#33) remain separate work.
