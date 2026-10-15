# Finite resources, reservations and conservation

Implements #30 under epic #27, building on the transactional command executor (#29). The shared resource API is internal, typed and directly runnable by the existing Node service. It adds no public endpoint, SQLite migration, background scheduler or new dependency.

## Model and units

A `ResourceLedger` belongs to one instance and exact domain rule pin. Its fixed resource catalog declares separate conserved identities and canonical integer units: mass in `g`, energy in `mJ`, volume in `uL`, and discrete items in `count`. Power is a rate and is never an inventory unit. `energyForPower(integerWatts, integerMilliseconds)` returns exact mJ; fractional/negative/nonfinite inputs and overflow are rejected. Smaller rate units or conversions require an explicit future contract, not silent rounding.

Resources are not interchangeable currency. Copper, polymer, dirt, electrical energy and test kits remain distinct. Conservation compares every resource/constituent, not just aggregate weight. Domains must select an appropriate conserved basis: processed forms change lots/attributes, while an assembled machine can retain allocated constituent/component records instead of exchanging them for a universal robot token.

Lots identify form and domain-owned attributes. Grade, contamination and unknown properties remain domain data. Account requirements compare declared attributes exactly; missing evidence does not satisfy an explicit grade requirement. There is no sensor certification or chemistry inference in the ledger.

Accounts represent stock, reserved inventory, cargo, work in progress, output, waste, spill and spent resources. They declare owner/job scope, allowed resource IDs, accepted lot kinds/attributes and optional capacities per unit. Capacity aggregates all constituents/lots in that unit. Scoped accounts reject a different actor or job; reservations additionally bind their creator principal. These internal context values must come from authenticated command/job state, never a client-supplied identity object.

The opening inventory is finite and recorded separately from current balances. `createResourceLedger` is an initialization API, not a refill action. Domain commands must use the operation API and must not replace the opening inventory to award resources. Deliveries can transfer from explicitly modeled finite external stock. Open-ended solar/utility input and production ledger migration require a separately reviewed source/time policy in later integration; this PR keeps the existing game's generation ledger and adopts only its shared exact arithmetic helpers.

## Operations

`applyResourceOperation` validates and copies input state, returning a proposed replacement. On failure the original ledger remains unchanged. The domain embeds the returned ledger in its state proposal; #29 commits state and the command receipt under the same SQLite transaction.

| Operation | Behavior |
| --- | --- |
| `reserve` | Atomically move selected input constituents into an empty, dedicated job holding account and record source, actor, job and reservation ID. |
| `use` | Debit part/all of an open reservation and credit explicitly declared output/WIP/waste allocations. Requires a trusted domain transformation policy. New lot definitions must be distinct and policy-approved. Every resource's debit equals its credits. |
| `transfer` | Move the same lot/resource identity between compatible accounts; cannot bypass reservation APIs or withdraw terminal waste/spill/spent resources. |
| `spend` | Move energy or discrete consumables into an irreversible spent account. |
| `cancel` | Return only the balance still held by that reservation to its original source. Existing output, WIP and spent energy are not refunded. |
| `complete` | Close an empty holding account. Further consumption or cancellation fails; identical retries are no-ops. |

Each operation has its own ID. Reusing that ID with the same command/actor/job/rule and payload is a no-op retaining current state; changed reuse is rejected. Simulation timestamps may advance on retry without rewriting the original entry. The outer command receipt still returns the original response, as defined in #29.

Reserved accounts are dedicated to a reservation in this bounded implementation; they are not shared mutable resource pools. Reserved inputs cannot be withdrawn through an ordinary transfer. Recoverable residue belongs in a normal inventory/WIP account with an appropriate domain rule; terminal waste/spill/spent accounts intentionally cannot be reclaimed by a generic refund operation.

`splitQuantity` computes an exact rational floor with BigInt intermediates and returns the entire unused integer quantity as `remainder`. That remainder must be explicitly assigned to residue, unused input or waste. BigInt never enters persisted JSON. Stored quantities and per-resource totals must remain safe integers.

## Domain policy and atomic production

The ledger enforces finite quantities, identity conservation, scope, units, compatibility and capacity. The trusted pinned domain module still decides whether a recipe, grade substitution, hazard condition, phase or energy cost is scientifically/game-rule eligible. A valid schema or balanced posting cannot establish those facts.

Transformation policies receive isolated copies and must approve `use`. They cannot mutate the committed source through those copies. Unknown input attributes remain unchanged unless the domain explicitly establishes a new output lot under its rule. Conservation prevents even an approving policy from exchanging copper for polymer or charging energy as a mass quantity.

The neutral work-cell fixture charges its explicit 1 MJ example process cost and creates material output inside one command transaction. Insufficient energy, invalid output or failed receipt insertion rolls back both changes. This is a bounded test recipe, not a physically validated manufacturing model. The fixture shows the reservation and energy APIs are actually composed through #29, not only tested as independent arithmetic functions.

## Journal and validation

Every posting entry records instance, operation ID/kind, authenticated principal, command ID, job ID (explicitly null for direct command work), simulation time and exact domain rule pin. It also records balanced postings, reservation changes and new lot definitions. Initial quantities are separate opening evidence.

`validateResourceLedger` reconstructs balances from opening quantities and the ordered postings, validates reservation lifecycle/actor/job identity, checks lot definitions and capacities, and reconciles each conserved resource against opening totals. Ledger time cannot run backward. Duplicate identities, overdrafts, unsupported units, incompatible attributes and changed balances that do not match history fail closed with safe codes.

This journal is part of bounded domain state. It is not a new production event transport or replay API; #32 owns shared durable events/checkpoints. This PR does not claim protection against an administrator rewriting both opening state and history. The registry/command boundary must keep raw ledgers private, and production domains must constrain their mutation handlers to the reviewed APIs.

Current bounds are 64 resources, 128 accounts/reservations, 512 lots, 4,096 balance rows and 1,024 entries, intersected with the existing bounded JSON limits (2 MiB, depth 64, 100,000 inspected values). A ledger reaching its bounds fails explicitly. There is no silent history deletion or unrecorded reset; compaction/epoch migration is follow-up work. Accounts/catalog are declared by trusted setup; this is not an unrestricted player-authored inventory editor.

## Adoption and compatibility

The existing game now uses shared exact constituent comparison, cable split rounding and W×ms energy calculations while preserving its current schema, SQLite files, response shapes, recipe yields and accounting fixtures. Its batch/reservation storage is not replaced by generic ledger tables in this PR. Complete production-domain adoption and save migration remain #33; shared job progression remains #31.

The pinned material/robot runtime at `5e306c2033bfdb15510f98f575f937e1578f6a3f` (still on the separate #16 branch at implementation start) was checked as a separate unchanged baseline: its material and robot/base accounting suites pass. That is regression evidence, not a claim that this PR migrated those branch-only systems onto the new ledger. The new simulation suite separately verifies original cable recipe values across 256 inputs and exercises the new resource APIs against real file-backed SQLite and independent writer processes.

```sh
npm ci
npm run test:simulation
npm run test:mcp-game
npm run test:mcp
npm run test:mcp-scenes
npm run build
```

For the separate material/robot baseline, check out the pinned commit and run `npm ci`, `npm run test:materials`, and `npm run test:mcp-game`. Do not treat those branch-only capabilities as merged merely because their baseline tests passed.

The new tests cover last-kit contention, exact retry after reopen, partial work plus cancellation, completed-reservation refusal, terminal spend preservation, WIP/cargo/waste/spill accounting, grade/capacity/unit rejection, rational rounding, overflow, conservation/transmutation rejection, atomic energy/output costs and rollback on receipt failure.
