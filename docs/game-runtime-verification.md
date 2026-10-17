# SQLite runtime verification

The SQLite runtime removes the game stack's Supabase dependency. Tests create actual local accounts and sessions in SQLite; no authentication facade or fixture JWT is involved.

`npm run test:mcp-game` covers:

- Account password hashing, session token hashing, failed login, expiry and revocation.
- Exactly two distinct participants, invitation reuse/expiry, owner checks and private projections.
- Strict published v5 schemas and rejection of caller-supplied identity.
- Immutable receipt replay, ID reuse errors and two concurrent MCP collection requests.
- Real SQLite trigger-induced write failure and transaction rollback.
- Pause/resume/cancel, input reservations, finite deposits and spent-energy accounting.
- File-backed reopen, monotonic progress through clock rollback, exactly-once completion and constituent conservation across all 256 starting partitions.
- A separately spawned production service advances while all MCP clients are closed. The test kills that service, restarts it against the same database, reconnects with persisted sessions and verifies completion without duplicate outputs.

`npm run build`, `npm run test:mcp` and `npm run test:mcp-scenes` check compatibility with the existing application and scene tools. CI's Linux/Windows game jobs now exercise SQLite rather than provisioning Postgres or Supabase.

The matching tower-defense PR verifies its actual MCP SDK adapter, HTTP boundary and desktop/mobile browsers against this service. Full gameplay, sensor-kit manufacturing, additional machines and combat remain unimplemented. No external production rollout is claimed.

## Finite-world v3 verification

`test:mcp-game` also runs `scripts/game-world-test.ts`: seven mirrored deposit categories, map/outposts/roads, per-base component allocations, private truth/observation checks, invite rotation and invalidation, owner-only paginated match listing, both 20-second recovery loops, bounded solar/storage/spill accounting, durable depletion after restart, mutual completion without a combat winner, and one-time migration preserving v2 material and jobs. The existing real service/MCP suite still exercises concurrent collection, process kill/restart, immutable receipts and revocation. The downstream browser suite exercises actual controls, including a committed response deliberately lost before identical-command retry.

## Material science v4 verification

`npm run test:materials` runs 16 pure tests (including 300 seeded accounting cases) and the actual SQLite material workflow: owned-only catalog/evaluation, rejection of supplied grades, uninspected evidence, paid cancellation, inspection restart/retry, private observations, temperature limits, component-only allocations, installed-machine refusal, nine residue passes, exact constituent balance and one-time v3 migration. `npm run build:materials` plus the CI diff gate ensures committed runtime JavaScript corresponds to TypeScript source. The downstream `check:materials` gate verifies its entire vendored package against the pinned runtime.

Two actual Chromium sessions verify unknown → inspected → eligible at 20 °C, refusal at 90 °C, component test compatibility, private observation counts, reconnect and residue preview/start/completion on desktop/mobile. These tests use production account, SQLite, HTTP and MCP code. No deployment or completed manufacturing/combat is claimed.

## Robot v5 verification

`test:mcp-game` runs `game-robots-test.ts` against real file-backed SQLite: owned commands and private evidence, fixed range/line-of-sight routes, dirty/occluded/low-signal evidence, energy-charged stable rescans, two database writers competing for a final load, atomic receipt rollback, reservation and cargo interruption, retreat, stale/depleted targets, hidden material until bench inspection, hazardous feedstock isolation, charging priority/transfers, payload/return budgets, exact retries, reopen/catch-up, long-tick equivalence and one-time schema-4 migration. Earlier regression tests explicitly use legacy-match fixtures to retain coverage of migrated starter workflows.

The downstream HTTP/MCP test kills and restarts the actual runtime service during a haul, replays its original receipt, waits for delivery, inspects/processes the batch and verifies charging from the shared base bus. The browser suite drives two isolated desktop/mobile sessions through survey, cargo hauling, bench inspection, processing, charging, interrupt/retreat, logout/reconnect and mutual completion; one committed survey response is deliberately lost to verify immutable retry. It captures field/map/material screenshots and checks console errors and overflow.

## Shared-runtime native v5 integration

`tests/simulation/native-game-adoption.test.ts` restores captured, unmodified native v3/v5
rows (sources recorded in `tests/simulation/fixtures/README.md`). It verifies exact active
robot stock/reservations/observations and receipt bytes across cutover/restart, paid legacy
work preservation, old-history projection, receipt-only legacy retry, revocation, atomic
migration failure and unknown-pin recovery. The neutral service remains independently tested.

The robot tick-equivalence test restores a complete closed SQLite backup before comparing
long and short schedules, including its history. Synthetic old-schema tests clear only their
test-created newer journal; captured-save tests separately prove real journal preservation.


## Shared envelope, scheduler and ledger (SQLite 5)

The current authority persists `SimulationInstance` with canonical event jobs, typed private
observations and balanced resource accounts. The real MCP autonomous-progress assertion reads
`state.schedule.jobs`, proving the production timer advances shared checkpoints. Captured
v3/v5 saves retain exact native views and receipt bytes while stored JSON changes to an envelope.

Event-runtime regressions compare original native rules and shared clock advancement for active
hauls, fractional time, solar-starved charging, final one-millisecond transfer, bounded catch-up
and restart. Generic ledger tests cover exact conservation, incompatible units, capacity,
transmutation, sink refunds, unauthorized issuance, replay and bounded history compaction.
A receipt-trigger failure during a real collection reservation leaves jobs, resources and history
unchanged; the identical request then commits once and replays exactly. Registry tests validate
entity/evidence changes together and sanitize private callback errors.

The `Game runtime` CI workflow runs native/material/shared tests on Linux and Windows. Its
`downstream-browser` job runs the immutable tower-defense client against the PR authority,
including actual HTTP/MCP and desktop/mobile two-account recovery; screenshots are uploaded as
`adopted-runtime-desktop-mobile-evidence`. Scene-authoring CI remains a separate regression gate.
These tests exercise modeled software behavior, not physical sensor or process validation.

## All initial waste recovery (SQLite 6)

`game-all-waste-test.ts`, included in `test:mcp-game`, drives two real accounts through robot collection, paid inspection and all six additional recipes in file-backed SQLite. Each route checks exact constituent and energy conservation, fault rollback, pause/cancel, processing restart, immutable retries, consumed-input refusal, private views and usable-output inspection/use. Battery-suspect residues retain quarantine through reinspection and reject repeated isolation. Machine power/energy/readiness and missing evidence are refused.

Policy unit tests cover grades, condition, purity, unknown contaminants, glass origin, tiny inputs, hazard restrictions and HDPE temperature bounds. A schema-5 envelope/receipt test verifies that opening schema 6 changes only its compatibility marker. Existing captured-save migrations and all cable tests remain in the suite. The paired desktop/mobile browser test exercises steel recovery and vehicle isolation through production HTTP/MCP controls.

## Manufacturing (SQLite 7)

`npm run test:manufacturing` runs the complete file-backed two-account machine/robot/defense/upgrade chain described in [manufacturing queues](game-manufacturing-queues.md), with dedicated Linux/Windows jobs. It covers exact component reuse, constituent offcuts, reservation faults, pause/cancel/failure, disabled equipment, heater interlocks, storage and power waits, persistence/retry, and competing connections. The shared-clock tests compare long downtime with short ticks under energy starvation. Existing 80 simulation regressions remain alongside the manufacturing policy tests. Desktop/mobile client CI drives real BOM preview, manufacturing, press construction and enable/disable controls.


Defensive platforms, ammunition and their lifecycle are documented in [game-units.md](game-units.md). SQLite schema 8 adds the compatibility guard; full combat remains unavailable.

Current combat extension: [combat-v1 authority, timing, visibility and interruption policy](game-combat.md). Combat-capable saves require schema 9 and the matching reviewed client.
