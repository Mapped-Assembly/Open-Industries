# SQLite city-dump runtime v4

Open-Industries owns accounts, match identity, private deposits, inventory, jobs, time and receipts in a SQLite database. The game path does not use Supabase, Postgres, the scene CLI login, provider keys, or a hosted service. The independent Node process advances work even when all browsers and MCP clients disconnect.

This is a two-player recovery session in a finite 96 × 56 municipal dump. A shared map shows fourteen waste sites (seven categories per starting area), service roads, obstacles, two bases and neutral outposts. Both players can inspect their private 10 kg starter cable, recover it once and run a 500 W separator. Other sites retain finite private contents for later robot jobs. Moving robots, spatial sensors, hauling, manufacturing, combat and victory remain unsupported. `ready_for_recovery` is true; `ready_for_full_game` remains false.

## Run

Use Node **22.18 or newer** (Node's built-in `node:sqlite`) and install with `npm ci`. In a local `.env` file set:

```dotenv
ASTRA_GAME_PORT=8790
ASTRA_GAME_DB=.astra/game/runtime.sqlite
ASTRA_GAME_ALLOW_SIGNUP=true
```

Start the independently supervised service:

```sh
npm run game:server
```

It binds **127.0.0.1** only. Keep it running alongside the tower-defense backend on the same machine. The database and its WAL are private server files. Unix creation permissions are restricted; use a private service-account directory with appropriate ACLs on Windows. Back up SQLite with its backup API or stop the service before copying the database. Do not copy a live `.sqlite` file without its transaction state.

The tower-defense backend performs sign-up/sign-in, keeps the returned game token server-side, and launches one MCP process per browser session with:

```dotenv
ASTRA_GAME_TOOLS_ENABLED=true
ASTRA_GAME_SERVICE_URL=http://127.0.0.1:8790
# ASTRA_GAME_SESSION is supplied securely by the backend, never in tool arguments.
```

Disable `ASTRA_GAME_ALLOW_SIGNUP` after provisioning accounts if registration should be closed. Accounts use a normalized 3–40 character username and a 12–256 character password. Passwords use per-account salted scrypt; only SHA-256 digests of random 256-bit session tokens are stored. Sessions expire after eight hours and logout revokes them immediately. Password reset/account recovery is not implemented in this foundation.

## Authority and transport

The loopback service provides JSON-only server-to-server endpoints: `POST /auth/register`, `POST /auth/login` (username/password), `GET /auth/session`, `POST /auth/logout`, `GET /health`, and `POST /game`. Authenticated endpoints use a bearer game session. `/game` accepts exactly `{name, arguments}` and revalidates the published MCP schema. It derives the owner from the stored session; no request can choose a player ID. Browser-origin requests are rejected; browser traffic belongs behind tower-defense's cookie-authenticated backend.

The stdio MCP server exposes eight versioned tools with complete input/output JSON Schemas:

| Tool | Arguments in addition to `version: 4` | Result |
| --- | --- | --- |
| `astra.game_science_catalog` | `match_id` | Validated catalog pinned to this participant match |
| `astra.game_evaluate` | `match_id`, `target_id`, `query`, `design_id`, `temperature_c` | Private preview using owned evidence and installed machines |
| `astra.game_list_matches` | `cursor` (null for first page) | Up to 20 owned memberships and `next_cursor`, ordered by match ID |
| `astra.game_describe` | None | Static contract; does not certify deployment health |
| `astra.game_create_match` | `command_id` | Waiting snapshot and a one-use, one-hour invite |
| `astra.game_join_match` | `command_id`, `match_id`, `invite_code` | Second participant's private snapshot |
| `astra.game_read_match` | `match_id` | Full authorized snapshot for polling/reconnect |
| `astra.game_command` | `command_id`, `match_id`, `expected_revision`, `action` and its target IDs | Durable receipt and snapshot |

Actions: `inspect_batch`, `inspect_component`, `start_material_process`, `inspect_deposit`, `collect_deposit`, `start_processing`, `pause_job`, `resume_job`, `cancel_job`, `dismantle_machine`, `abandon_match`, `rotate_invite`, `finish_recovery`. Their target fields are defined by `tools/list`; unknown fields are rejected. A full snapshot replaces local state. Never merge another player's private data or infer opponent inventory from shared revision changes.

SQLite WAL, `synchronous=FULL`, foreign keys and `BEGIN IMMEDIATE` protect each transition. Input reservations, output creation, energy changes, revision updates and the receipt commit together. Identical command IDs and payloads return their original immutable receipt, including after restart. Reusing an ID for different work fails. After `CONFLICT`, read and reconcile before using a new ID. After `OUTCOME_UNKNOWN` or an invalid response, retry the **same** ID and payload before issuing new work. A replayed receipt can contain an older snapshot: read again for current state.

The service ticks once per second and catches up from persisted timestamps after restart. No browser or MCP process drives the clock. A heartbeat older than 15 seconds blocks new work; reads and recovery/cancellation remain available. Clock rollback cannot refund energy or repeat progress. Each tick processes up to 100 matches in oldest-tick order; this implementation targets a small single-host deployment.

## Material fixture and limits

Each player has one finite cable deposit and a separator connected to a 20 kJ charged battery and 100 W solar generator. Generation and processing advance together; excess generation is explicitly spilled at capacity. Solar charging needs no manufactured input. Each base includes one tower, two parked robots, an inspection bench and a parked fabricator. `starter_ledger` assigns every supplied component/stock quantity and balance mass to one asset or the store; state saves check that allocation. These prebuilt facilities and the charged battery guarantee a first cable loop with no circular build dependency. Inspection reveals only that player's server-issued cable assay. Collection creates one batch. The 10 kg fixture takes 20 seconds and 10 kJ; copper recovery is integer `19/20`, HDPE recovery is integer `6/7`, and all remaining constituents become residue. Outputs are recovered **ungraded** material. These balance rules certify no physical property or manufactured part.

Pause/resume preserves progress; cancellation returns reserved material while keeping energy spent. Destruction dissipates remaining battery energy and cancels the machine's work; abandonment cancels both players' live jobs. Every state save verifies constituent, component allocation and energy conservation: remaining energy + job expenditure + dissipated energy + spilled solar = initial energy + generated solar. Solar stops when the separator/battery is dismantled or the session ends. A completed processing job consumes its input and creates each output role once. Inspection jobs reserve and return their target, recording evidence without changing its mass.

Requests: 8 KiB at the game boundary, 256 KiB results, 30-second MCP-to-service deadline. Limits: three open memberships/account, twenty created matches/account/day, 256 successful commands/player/match (abandonment remains available), sixteen sessions/account, 1,000 accounts. Authentication is bounded to four concurrent scrypt operations and thirty attempts/minute per loopback address. History/receipts are retained; archival is future work.

## Verification and compatibility

`npm run test:mcp-game` uses the production SQLite engine and real service/MCP processes. It checks native account authentication, session revocation/expiry, hidden projections, ownership, two-player membership, simultaneous collection, duplicate receipts, transaction fault rollback, independent scheduling with clients absent, hard process restart, exactly-once outputs, conservation and 256 starting material partitions. CI runs on Linux and Windows.

Wire version 4 rejects older clients. SQLite schema 3 adds pinned material versions, private observations and component records referencing existing stock. Recovered legacy outputs receive no retroactive property evidence. Existing work and immutable receipts remain intact. The earlier schema-2 migration first upgrades v2 matches: preserve accounts, sessions, original cable IDs/composition/observations, batches, jobs, energy and immutable receipts; grant and ledger the new starter equipment/map once. Previous abandoned sessions become completed/abandoned. New private world contents are generated once and persisted. Legacy recipes remain `dump-v1`; map/catalog/sensor versions are independently pinned. Back up the database before upgrading, and upgrade the matching client together. An old request receipt stays immutable; its v2 command ID cannot be reused for a different v4 payload. This does not import or access the historical Postgres runtime. Scene-authoring persistence remains separate.

## World, lifecycle and privacy

`world` is the shared public projection: positions, exterior waste categories, depleted status, roads, obstacles, outposts, tower slots and pinned versions. `base`, `deposits`, `batches` and `jobs` are the caller's private projection. The HMAC generation seed, uninspected composition/components, other crew's assets/inventory and observations never enter snapshots, receipts, error details or logs. Public depletion and lifecycle are intentionally shared. Each side has mirrored geometry and the same bounded starter recipe/energy path; cable composition is independently sampled so one crew's assay does not reveal the other's.

The six other waste categories are finite persisted world objects, with hidden mass/components. They cannot yet be surveyed/collected; range-based sensing and robot hauling belong to later work. Robots/fabricators are provisioned, component-accounted and parked, not simulated moving or manufacturing units. Outpost capture and tower damage remain unsupported.

Lifecycle: waiting → active → completed. A waiting host can rotate its one-use, one-hour invitation after refreshing/signing in; older codes are invalidated. Expiry completes a waiting session with `invite-expired`. Abandonment cancels work and completes with `abandoned`. After each crew finishes a cable job, each can explicitly accept `finish_recovery`; both acceptances archive the session with `recovery-complete`. None of these reasons claims a combat winner (`winner_slot: null`). Completed history remains readable through membership listing/reconnect.

Revisions protect discrete commands and job/lifecycle transitions. Fractional clock progress and solar charging update `server_time_ms` and the full snapshot without changing the command revision every millisecond. Commands first check the supplied revision, then advance authoritative time and revalidate actual resources/readiness in the same transaction. Poll every two seconds and replace the whole snapshot. Time/energy never depend on client clocks.

## Material science v4

The canonical `@openindustries/material-science` package lives in `packages/material-science`. Its checked-in JavaScript/declarations are rebuilt and checked for drift in CI. The downstream UI vendors that exact build for tests/demo; runtime decisions always execute inside this SQLite service. The pure engine was moved from tower-defense's earlier calculation core, with evidence, result, component and substitution validation added.

Matches pin `materials-v2`, `balance-v2` and `bench-v1`; mismatched versions fail rather than silently adopting new rules. `astra.game_evaluate` accepts owned IDs and a catalog design only, with query `use`, `process`, `substitution` or `component`. It cannot receive batch composition, custom recipes, machine capabilities, property values, grades or identity. An eligible preview is not a reservation; startup rechecks real state atomically.

A bench inspection costs 300 J over 3 seconds at 100 W, sharing the existing power ledger and single live-job limit. Owner-scoped observations store target/revision, server timestamp, bench position and bounded fixture evidence. Copper-wire fixture values are labeled synthetic game measurements and cover only 20 °C; other grades remain unknown. Starter-component tests reference existing stock allocations and certify only the named game-maintenance fixture. They never credit bulk material.

The separator uses the same library's integer/rational cable plan, preserving the 10 kg / 10 kJ fixture. Inspected residue can pass through `recover-cable-residue`, recovering half its remaining copper (floor grams) and retaining every other constituent/remainder. Outputs do not inherit grade or property evidence. The other five families have explicit catalog process/use paths; their required machines are not installed, so the authority refuses startup. Manufacturing, robot sensing and new machine provisioning remain separate work.

See the downstream [science design](https://github.com/isayahc/tower-defense/blob/main/docs/material-science.md) for documented reference anchors, bounds, geometry and balance choices. These are bounded gameplay rules, not alloy inference, arbitrary chemistry or engineering certification.

`npm run test:materials` validates the canonical catalog and property units/bounds, all six families, 300 constituent cases, approved geometry, owned/private evidence, durable paid inspections, exact retries, stock allocations, nine residue passes and idempotent v3 migration. Existing service/MCP transaction and restart tests remain in `npm run test:mcp-game`.
