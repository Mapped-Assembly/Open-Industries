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
