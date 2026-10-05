# Runtime import verification — 2026-10-05

Target: `Mapped-Assembly/Open-Industries`, based on initial import `f609a4694bb181fd74799a4182ea9efd67192014`.

The earlier runtime implementation at `2abf683` in the existing workspace was absent from this repository's initial import. This branch ports that implementation, removes its inaccessible issue link, and adds a race between two independently connected clients collecting the same finite pile. The production runtime uses the existing verified Supabase session and Postgres authority.

## Passed in this checkout

| Command | Evidence |
| --- | --- |
| `npm ci` | Lockfile installation and vendor preparation succeeded. |
| `npm run build` | Strict app/MCP TypeScript checks and the Vite production build passed. |
| `npm run test:mcp-game` | Real stdio MCP processes and real migration/RPC execution in PGlite; two-account membership, privacy, distinct collection-intent race, retry receipts, lost response, pause/resume/cancel/destruction, disk database reopen, energy accounting, RLS/grants, and 256 constituent partitions passed. |
| `npm run test:mcp` | Existing room creation/persistence/validation/path checks passed. |
| `npm run test:mcp-scenes` | Existing scene schemas, revisions, ownership, geometry and conflict checks passed. |
| `npm run test:scene-history` | Existing revision/restore, ownership, pagination and rollback checks passed. |
| `npm run test:mcp-agent-workflows` | Existing Grok/ChatGPT/Codex protocol fixtures and cross-client handoff passed; these are deterministic fixtures, not live provider sessions. |
| tower-defense discovery CLI at `8845c36` against this checkout | Enumerated 18 tools, including five game tools, through MCP SDK 1.32.0. Exit 2 and `GAME_CONTRACT_UNVERIFIED` correctly kept full-game startup disabled. |
| `node --check scripts/game-postgres-test.mjs` and `git diff --check` | Passed. |

## Remaining verification

- PGlite tests use an HTTP authentication facade and serialized transactions. They do not establish hosted Supabase login, native Postgres connection concurrency or autonomous `pg_cron` operation.
- The native Postgres suite is included in `.github/workflows/game-runtime.yml`, with an additional race for the last pile. It exercises concurrent connections, independent cron progress, a database process restart and output-insert fault rollback. It was not rerun here: Postgres is absent, and the environment rejected package installation with `setgroups`/`setegid` permission errors. No CI run for this branch has been created yet.
- Native database advisors, hosted migration/scheduler setup, real account authentication and a two-browser match remain unverified. No live deployment or database was changed.
- Moving robots, sensor range/noise/occlusion, shared-resource contention between opposing crews, hauling, charging, manufacturing, combat and victory remain unsupported. This is a server processing foundation, not a finished game.

## Publication

Organization access was enabled after an initial HTTP 403. [Issue #1](https://github.com/Mapped-Assembly/Open-Industries/issues/1) tracks the runtime and outstanding verification. The implementation is on `feat/city-dump-runtime`; the PR records subsequent CI results separately from the local evidence above.
