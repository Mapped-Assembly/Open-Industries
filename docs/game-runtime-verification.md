# SQLite runtime verification

The v2 runtime removes the game stack's Supabase dependency. Tests create actual local accounts and sessions in SQLite; no authentication facade or fixture JWT is involved.

`npm run test:mcp-game` covers:

- Account password hashing, session token hashing, failed login, expiry and revocation.
- Exactly two distinct participants, invitation reuse/expiry, owner checks and private projections.
- Strict published v2 schemas and rejection of caller-supplied identity.
- Immutable receipt replay, ID reuse errors and two concurrent MCP collection requests.
- Real SQLite trigger-induced write failure and transaction rollback.
- Pause/resume/cancel, input reservations, finite deposits and spent-energy accounting.
- File-backed reopen, monotonic progress through clock rollback, exactly-once completion and constituent conservation across all 256 starting partitions.
- A separately spawned production service advances while all MCP clients are closed. The test kills that service, restarts it against the same database, reconnects with persisted sessions and verifies completion without duplicate outputs.

`npm run build`, `npm run test:mcp` and `npm run test:mcp-scenes` check compatibility with the existing application and scene tools. CI's Linux/Windows game jobs now exercise SQLite rather than provisioning Postgres or Supabase.

The matching tower-defense PR verifies its actual MCP SDK adapter, HTTP boundary and desktop/mobile browsers against this service. Full gameplay, real robot/sensor behavior, manufacturing and combat remain unimplemented. No external production rollout is claimed.
