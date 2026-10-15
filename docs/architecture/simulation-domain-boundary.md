# ADR: Versioned simulation contracts and trusted domain modules

Status: executable contract foundation (#28), with [transactional command execution](transactional-simulation-commands.md) added in #29 under epic #27.

## Decision

Extract reusable simulation mechanisms incrementally from the existing SQLite runtime. A simulation instance is a versioned namespace containing entities, memberships, spatial frames, observations and domain state. It has no required second participant, tower, game map or winner.

A trusted domain module supplies schemas, invariant validation, command authorization, transition proposals, authorized projections and explicit migration hooks. Pin all three of `module_id`, `module_version` and `schema_version` in every instance. Resolution is exact; reads never select the latest implementation or invoke migrations. Contract envelope version 1 is independent of existing game MCP API versions.

The first implementation is an internal TypeScript registry in `server/simulation`. It validates stored envelopes and invokes invariant/projection callbacks on isolated, recursively frozen JSON data. Registration clones schemas and pins, rejects duplicate registrations and compiles strict schemas using the existing Ajv dependency. Modules are statically imported trusted application code; no module ID becomes a filesystem path, network request or dynamic import.

Keep the existing Node/TypeScript stack for this extraction: the SQLite scheduler and MCP boundary already run in Node, and using the same process avoids a new cross-language transaction boundary. No additional runtime dependency or language migration is introduced. A future Python adapter can consume a separately reviewed wire contract; it must not become a second state authority.

## Delivered scope

- Typed contracts and strict runtime envelope schemas for instances, exact module pins, memberships, entity identity/type/revision, references, locations, observations and future command/transition hooks.
- `DomainRegistry.register`, `resolve`, `validateInstance`, `entity` and `project`.
- Game and neutral one-operator work-cell **test fixtures** using the same registry. Their command authorization refuses execution and their transition hook throws: these fixtures demonstrate the boundary, not a newly working game or laboratory engine.
- Focused tests, a dedicated TypeScript check and Linux/Windows CI coverage.

The #28 foundation did not change live service behavior. The #29 follow-up adopts one existing game inspection command through the shared transaction executor while preserving its wire contract and SQLite tables; see the command document for current integration and evidence. The module registry itself remains internal and is not advertised as a new MCP capability.

## Contract responsibilities

| Concern | Shared contract | Domain responsibility |
| --- | --- | --- |
| Identity | Instance-scoped stable entity IDs and revision counters | Meaning of an entity kind and its attributes |
| Access | Stored principal membership/role, entity read/write policy and scoped reference resolution | Action-specific permissions and payload checks |
| Space | Declared frames, coordinate conventions and matching units | Bounds, reachability, geometry, roads and travel models |
| Observations | Target, owner, source/revision, simulation timestamp, origin, validity and JSON value | Sensor models, applicability, external evidence verification and uncertainty |
| State | Strict envelope plus module-pinned state schema and invariant callback | Valid domain states, recipes, material evidence and lifecycle |
| Commands | Common instance/command/revision envelope and typed context | Strict `{action, payload}` schema, authorization and transition proposal |
| Projections | Membership check, read-only callback input and schema validation | Explicit allowlist of visible fields, excluding domain secrets |
| Migration | Exact source pin plus an explicit hook declaration | A reviewed transformation preserving domain invariants |

`validateInstance` and `resolve` are trusted storage/developer APIs, not public read endpoints. `project` is the projection boundary. Only authenticated server code may supply its principal argument; browser-provided identity is not authentication. A future service must enforce this boundary when exposing the registry.

Membership alone never grants access to another owner's private entity. Even the instance's owner role has no automatic private-read bypass. Viewer roles cannot write. References contain both instance and entity IDs; cross-instance or dangling references are rejected. Domain-specific references embedded in `state` or entity `data` must be checked by that module's schema/invariant handler; the registry does not guess which arbitrary strings are IDs.

Coordinates use bounded finite numbers and an existing frame. `xyz` frames use `m` or `mm`; `xy-grid` frames use integer `cell` coordinates with z=0. Frame and location units must match. There is no implicit conversion from a dump cell to a meter or from millimeters to meters. Parent frames, transforms, geometry and navigation are later domain/scene integration work.

Observations distinguish `simulated` from `external` provenance. Unknown validity requires a null value. Simulated observations cannot claim `observed`; external observations cannot claim `modeled`. Timestamps cannot exceed instance simulation time, and targets/owners must resolve. These structural checks do not verify a source's truth, certify a sensor, establish clinical/scientific validity or make modeled sample completion a valid assay. Real evidence verification remains a domain concern (#11).

Payloads must be finite JSON without executable values, accessors, custom prototypes, implicit `toJSON` coercion or cycles. Current internal limits: 2 MiB serialized envelope/projection, depth 64, 100,000 inspected values, 4,096 entities/observations, 1,024 members and 64 frames. These are defensive contract bounds, not scalability claims; transport limits may be lower. Every declared identity list is checked for duplicates. Top-level state, command and projection schemas must reject unknown fields. Domain schemas must explicitly protect nested state.

Projection callbacks run trusted code and are responsible for privacy beyond generic membership checks. Output schemas enforce the declared shape, but cannot determine whether a permitted string secretly encodes private data. Tests cover the fixture's private attributes and observations. No arbitrary extension can claim that schema validation alone proves privacy.

## Existing code destination map

| Existing source | Destination during later extraction | Preserved behavior |
| --- | --- | --- |
| `server/game-sqlite.mjs`: transaction, receipts, revision checks | Shared command execution (#29) | Immutable retries, rollback, ownership and one state authority |
| `server/game-sqlite.mjs`: base/material ledgers and reservations | Shared resource mechanisms (#30), domain constituent rules | Finite inputs, spent energy, residue, exactly-once outputs |
| `server/game-sqlite.mjs`: `advance`, scheduler and process persistence | Shared job/time execution (#31), domain phase handlers | Restart catch-up, power waits, bounded progression |
| `server/game-service.mjs` and `server/mcp-game.ts` | Existing transport retained, generic service adoption reviewed in #33 | Server-derived identity, strict schemas, loopback service |
| `server/mcp-game-contract.mjs` | Existing game adapter plus shared envelope validators | Existing API versions and hidden-state protection |
| `server/game-world.mjs` | Tower-defense module | Two slots, towers, deposit generation, grid and balance rules |
| `server/game-robots.mjs` (PR #16 branch) | Robot domain behavior atop shared jobs/resources | Routes, survey evidence, cargo, energy and retreat semantics |
| `server/game-materials.mjs`, `packages/material-science` (PR #6/#16 branches) | Reuse canonical material domain/library | Property evidence, constituent rules and standalone calculations |
| `snapshot` and private world/science projections | Domain projections over shared events/snapshots (#32) | No hidden composition, seed or opponent observation leakage |
| Scene animation/replay bindings | Existing #12 using shared events from #32 | Stable scene/entity/job identity, no independent authority |
| Field-lab adoption | Existing #10 using the shared core after #33 | No reskinned two-player match or dummy opponent |

At implementation start, `main` was `b3d954d`, PR #6 and robot PR #16 were open, and the tested robot head was `5e306c2`. This PR bases directly on main because additive contracts have no dependency on those branches. Check current merge state again before later extraction. References to branch-only files describe intended destinations, not claims that they are on main.

## Staged save and API compatibility plan

1. **#28 (this PR):** add contracts/registry and fixtures; zero writes to existing SQLite files and no new exposed API. Original immutable receipts and game schemas stay intact.
2. **#29–#31:** route one existing operation at a time through shared command/resource/job mechanisms. Keep existing game endpoints as compatibility adapters and retain a single transaction owner. Run old fixtures against the adopted operation before expanding extraction.
3. **#32:** add a versioned transactional event history and defined checkpoints. Record the boundary between migrated historical state and newly recorded events; never invent historical measurements/events or promise replay before that boundary.
4. **#33:** introduce generic persisted envelopes via an explicit, versioned SQLite migration only after canonical runtime integration. Preserve stable entity/match IDs through namespaced mappings; preserve material composition, job progress, observation provenance, clocks and original receipt bytes. Pin domain/rule versions from known source versions; do not infer unknown measurements or rewrite old response snapshots into new schemas.
5. Keep old-version receipt replay on its original API response contract. New adapters may obtain a fresh authorized snapshot after replay. Unsupported module/schema versions fail closed with a concrete upgrade/backup remedy; no default latest-version fallback.
6. Before applying any migration, back up the database and validate supported source versions and invariants. Prove interruption rollback, migration idempotence and upgrade fixture preservation. Downgrade is only supported where an explicit reverse migration exists; otherwise restore the pre-upgrade backup, not an older binary against a newer database.

Migration hooks are interface declarations only here. Registering, resolving, validating or projecting an instance never calls them. No migration or hosting rollout is performed by this PR.

## Verification and next boundary

```sh
npm ci
npm run test:simulation
npm run test:mcp-game
npm run test:mcp
npm run build
```

`test:simulation` type-checks both contracts and fixtures, then exercises exact version pins, invalid references, unit mismatch, private access, projection validation, unknown evidence and hostile/non-JSON values. The existing game/scene suites remain the behavioral baseline.

#29 adds transactional command dispatch and pure registry transition proposals, invoking `authorizeCommand` and `proposeTransition` with frozen inputs. The registry itself does not commit state or receipts. #30 adds [finite resource and reservation mechanisms](simulation-resources.md); #31 owns scheduler execution; #32 owns event persistence; #33 proves actual service reuse by tower-defense and a neutral work cell. A passing contract fixture does not close those issues.
