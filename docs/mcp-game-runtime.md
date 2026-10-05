# Authoritative city-dump runtime v1

This implements the first server foundation for [tower-defense](https://github.com/isayahc/tower-defense), tracked in [Open-Industries #1](https://github.com/Mapped-Assembly/Open-Industries/issues/1): two authenticated participants each inspect and collect a finite cable pile, then run a durable, powered processing job. Postgres owns truth, time, reservations, outputs and receipts. Scene documents, local files, browser animation and MCP process memory cannot change this state.

This is a processing integration fixture, not the complete Tower Defense game. Moving scavenger robots, sensor range/noise, shared-map pathfinding, other material recipes, recharging, manufacturing, capture, combat and victory remain unsupported. `game_describe` explicitly returns `ready_for_full_game: false`. The Tower Defense full-game startup gate must stay closed until its adapter and remaining gameplay requirements are verified.

## Deployment

1. Configure the existing [Supabase Auth/database setup](../supabase/README.md). Apply the repository migrations, including `20261005003736_authoritative_game_runtime.sql`, through your normal reviewed migration process. Keep `game_private` out of Data API exposed schemas.
2. On a PostgreSQL deployment supporting `pg_cron` seconds schedules, run [enable-game-scheduler.sql](../supabase/operations/enable-game-scheduler.sql) as the database deployment owner. This installs the extension if needed, schedules `game_private.tick()` every second and initializes the heartbeat. Self-hosted Postgres needs `pg_cron` in `shared_preload_libraries`; Supabase documents seconds schedules for Postgres 15.1.1.61+.
3. Configure each MCP user's public Supabase URL/key and run `astra auth login` with their own account. Set `ASTRA_GAME_TOOLS_ENABLED=true` in that user's MCP environment. Never use a service-role key.
4. Start `node server/astra-mcp.mjs` using the existing stdio host. No network MCP endpoint or hosted game deployment is provisioned by this change. The feature flag controls this local MCP surface; SQL authentication, validation and authorization remain mandatory for direct RPC callers.
5. Verify scheduler history and a two-account processing run before enabling a client adapter. No production database migration or scheduler activation is performed by the tests.

Example environment:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-public-key
ASTRA_GAME_TOOLS_ENABLED=true
```

The existing CLI refreshes the session and verifies the user with Supabase Auth on every call. Identity is not an argument. The database derives it from `auth.uid()`. Use one MCP process/config per account; a remote MCP host would need a separate, trusted per-request session adapter.

## Published tools

Discover authoritative input/output JSON Schemas with `tools/list`. All requests require `version: 1`; unknown fields are rejected in both MCP and SQL. Successful results have `version`, `balance_version` and a participant-scoped `snapshot`. Writes also return `command_id`.

| Tool | Additional arguments | Result |
| --- | --- | --- |
| `astra.game_describe` | None | Static contract, supported and unsupported capabilities; no login required |
| `astra.game_create_match` | `command_id` | Waiting match and one-use `invite_code`, returned only in the creator's receipt |
| `astra.game_join_match` | `command_id, match_id, invite_code` | Second distinct participant joins; match becomes active |
| `astra.game_read_match` | `match_id` | Full authorized snapshot, including database-time catch-up |
| `astra.game_command` | `command_id, match_id, expected_revision, action` plus the target below | Atomic command receipt |

Invites expire after one hour and are consumed on joining. A third participant, self-join, wrong invite, foreign object or unknown match is rejected. A host may deliberately share the invite; it should not be published in logs or scene documents. Membership is fixed for the match.

| Action | Target | Server behavior |
| --- | --- | --- |
| `inspect_deposit` | `deposit_id` | Built-in intake assay issues an observation of the caller's pile |
| `collect_deposit` | `deposit_id` | Requires that assay; moves the entire finite pile into one batch once |
| `start_processing` | `batch_id, machine_id` | Checks ownership, inspection and availability; reserves input and pins the recipe plan |
| `pause_job` | `job_id` | Accounts for work up to command time, then pauses |
| `resume_job` | `job_id` | Requires remaining battery; restarts timing without counting paused time |
| `cancel_job` | `job_id` | Returns the complete original input; keeps already-spent energy recorded |
| `dismantle_machine` | `machine_id` | Owner-only destruction; cancels work, releases input and records remaining battery as dissipated energy |
| `abandon_match` | None | Ends the fixture for both players, cancels pending jobs and releases reservations |

There is no winner field, damage command, claim of a robot movement simulation, or client-controlled grade. Abandonment is a terminal lifecycle action, not a victory rule. Machine capture is unsupported, so ownership cannot change around a reservation.

## Retry, concurrency and reconnect

Generate a UUID `command_id` for every new intent. Retrying the **identical ID and payload** returns its immutable original receipt, even after other commands, completion or restart. The receipt may contain an old snapshot; follow it with `game_read_match` for current state. Changing the payload under the same ID returns `COMMAND_ID_REUSED`.

Every write locks the match row. Identical command IDs also take an account-scoped advisory lock, including before match creation. A stale `expected_revision` returns `CONFLICT` without executing the command. Read again, reconcile the intended action, then use a new ID. Scheduler progress changes the shared revision, so clients must handle conflicts while work runs.

The MCP call has a 30-second deadline. `OUTCOME_UNKNOWN` means the transaction might have committed: retry the same ID and payload, never blindly submit a new ID. Lost-response tests exercise this path. Errors are allowlisted codes/messages without SQL details, hidden state or session contents.

Polling always returns a complete snapshot. Replace cached state rather than merging guessed events; no event cursor, WebSocket or subscriptions are advertised. Each snapshot shows public lifecycle/revision, two slot numbers, and only the caller's deposits, observations, machines, batches and jobs. Before assay, deposit composition is null. Opponent IDs, composition, observations, inventory and invitations are absent. Random deposit composition comes from server UUID entropy; no reconstructive world seed is published.

## Material and energy accounting

Each participant starts with one 10,000 g cable pile, one built-in assay and one 500 W separator with 20,000 J of battery energy. Starting equipment is a non-recyclable scenario fixture. The finite feedstock is 5,000–7,040 g copper, 500 g dirt and the remainder HDPE; there is no replenishment or inventory-import operation.

The private, immutable `plan_cable` function ports the integer `strip-cable` partition in [Tower Defense's material core](https://github.com/isayahc/tower-defense/pull/9):

- Conductor receives floor(copper × 19 / 20) grams of copper.
- Insulation receives floor(HDPE × 6 / 7) grams of HDPE.
- Every remaining gram, including all dirt, goes to residue.
- Duration is 2 ms per gram. The 10 kg fixture requires 20 seconds at 500 W: 10,000 J.

These fractions, assay, power and duration are explicit **game balance fixtures**, not industrial recovery or sensor specifications. A 6,000 g copper + 3,500 g HDPE + 500 g dirt input produces 5,700 g conductor, 3,000 g insulation and 1,300 g residue. The server does not automatically assign pure-element conductivity, strength, alloy grade or part eligibility. Outputs remain `recovered-ungraded` pending a future property-certification system.

The plan is computed from stored, server-inspected constituent masses inside the reservation transaction, then pinned on the durable job with `recipe_version: dump-v1`. Later recipe releases must retain support for existing pinned plans. There are no client-supplied times, masses, evidence, properties, power levels or output plans.

Mass uses integer grams. Energy uses integer millijoules: 500 W × 1 ms = 500 mJ. A tick advances by the minimum of elapsed database time, remaining work and available battery. Battery use, job work, input consumption and all output inserts commit together. Unique active-reservation/output indexes provide additional guards. Consumed input rows are history, not spendable inventory.

Pause retains the reservation. Cancellation uses an all-or-nothing processing model: the original mixture returns unchanged, partial work is discarded and consumed energy remains spent. Destruction uses the same input rule and dissipates unspent battery. A power-starved job pauses with its reservation; it can be cancelled but cannot resume without power. Recharging is not implemented.

## Independent scheduling and operations

`pg_cron` runs outside browsers and the MCP process. It advances up to 100 due matches per tick, using `FOR UPDATE SKIP LOCKED` and least-recently-advanced ordering. A database/MCP restart loses no job state. On recovery the next tick accounts for elapsed wall time, capped by remaining work and stored battery. Backward wall-clock corrections never decrease match time or re-credit work across pause/resume.

New matches, joining, inspection, collection, start and resume require a scheduler heartbeat no older than 15 seconds. Reads catch up work, and pause/cancel/dismantle/abandon remain available during a scheduler outage. This recovery path does not replace the independent scheduler.

Deployment owners should monitor:

```sql
select last_tick_ms, game_private.now_ms() - last_tick_ms as heartbeat_age_ms
from game_private.runtime;
select jobid, active, schedule from cron.job where jobname = 'oi-game-runtime-v1';
select status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'oi-game-runtime-v1')
order by start_time desc limit 20;
```

Ticks are atomic. An invariant failure rolls back that tick and appears in cron history; repair the cause rather than inventing replacement inventory. Verify latency/backlog under your expected load. This small fixture has not been load-tested as a production game service.

Bounds: 8 KiB request, 256 KiB result, three open memberships/account, twenty creations/account/day and 256 successful commands/player/match. Abandonment remains allowed at the command limit. Each player has at most one deposit, one machine, four batch records and 256 jobs. Read polling is not an application rate limiter; use the deployment's normal authenticated API limits. Receipts/state are retained for recovery; no automatic archival or account-deletion policy is added. Do not delete receipts while clients may retry.

Only the public `game_runtime` invoker RPC can reach the private, narrowly granted `dispatch` definer function. All tables have RLS enabled with no client policies, and API roles have no table grants. Internal functions, clocks, planners and tick are not executable by API roles. The public wrapper does not elevate privileges itself. The existing scene/room RPCs and storage model are unchanged.

## Verification and evidence

`npm run test:mcp-game` starts actual stdio MCP processes, uses verified-session calls against a local auth facade, and executes the real migration/RPCs in PGlite. It tests schemas, disabled/unauthenticated access, two accounts and third-party rejection, private projections, direct-RPC validation, finite collection, lost commit responses, retries/conflicts, pause/resume/cancel/destruction, power exhaustion, clock rollback, closing/reopening a disk database, grants/RLS, and all 256 starting constituent partitions.

`npm run test:game-postgres` requires a **fresh disposable local** PostgreSQL database called `oi_game_test` with `pg_cron`, plus `OI_GAME_TEST_DATABASE_URL`, `OI_GAME_PGDATA` and `OI_GAME_PG_BIN`. [Game runtime CI](../.github/workflows/game-runtime.yml) provisions it. This separate suite races commands and finite-pile collection through concurrent real database connections, verifies autonomous cron work while command connections are closed, restarts the PostgreSQL process mid-job, checks exactly-once recovery, and injects an output-insert failure to verify complete transaction rollback.

The auth facade does not establish evidence of a hosted Supabase login or production deployment. A deployment smoke test must still verify two real accounts, configured migrations, cron health and reconnect in the target environment. Existing build, room MCP, scene MCP, scene history and cross-agent workflow checks remain required; the existing browser CI also runs on the PR.

The Tower Defense PR #9 discovery client was also run against this checkout using MCP SDK 1.32.0. It successfully enumerated all 18 tools, including the five game tools. Its startup gate correctly remained closed with `GAME_CONTRACT_UNVERIFIED`: discovery is compatible, but a game-side adapter and the remaining runtime capabilities still need verification.

References: [Supabase function privileges](https://supabase.com/docs/guides/database/functions), [Cron setup and second schedules](https://supabase.com/docs/guides/cron/quickstart), [Postgres locking](https://www.postgresql.org/docs/current/explicit-locking.html).
