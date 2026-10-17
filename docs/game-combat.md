# Authoritative combat policy (combat-v1)

Combat is an explicit game abstraction. Damage, health, movement and energy below are balance fixtures, not physical performance claims. Requires matching wire-v5 clients and SQLite schema 9. Back up the complete SQLite database before upgrading both repositories. Schema 8 and earlier envelope state, paid work, IDs, pins, event history and receipt bytes are preserved; the compatibility gate advances without rewriting those records.

## Starting combat and public information

Either authenticated member of an active two-player recovery session may issue `start_combat`. This permanently begins combat for that session, clears both recovery-finish flags and initializes combat state without creating resources. A recovery session can still be ended with `abandon_match`. `finish_recovery` is unavailable once combat starts. Tower destruction does **not** select a winner or end the session yet; victory, defeat and simultaneous tower destruction policy belong to tower-defense #19.

Before combat, existing private projections remain private. Starting combat publishes tactical IDs, owner slots, kinds, grid positions, current/max health, outpost ownership and a bounded 32-event combat tail to both participants. This deliberately includes opposing robots, installed industry and deployed platforms. Material evidence, inventories, components, robot cargo, routes, jobs, accounts, invites, seed and ammunition IDs remain private. No third account can read or command the match. Stowed units are private until deployed.

## Commands and timing

`combat_order` accepts an owned unit ID, one of `defend`, `attack`, `target`, `retreat`, `capture`, and a target ID (explicitly null for defend/retreat). Clients cannot supply paths, speeds, health, damage, ammunition quantity, captured owner or completion times. Existing authentication, current revision, command receipt and SQLite transaction checks apply. Retrying the exact command returns its original receipt even after later combat ticks; a changed request cannot reuse its ID.

Commands store pending orders. The common durable event clock resolves at one-second boundaries, alongside processing, charging and recovery. There is no damage in command handlers or client code. Active orders persist with the next boundary and resume after restart; bounded catch-up reports scheduler debt rather than skipping events. Reissuing an order replaces that unit's old order; disabling/destroying the unit cancels its order at the next boundary. Disabling does not refund movement, energy or spent ammunition.

- **Defend:** hold position and automatically choose the nearest live opponent within weapon range and line of sight; ID breaks distance ties.
- **Target:** hold position and fire at the chosen opposing target. Admission requires range and line of sight; every pulse rechecks both against its current position. Losing range pauses firing.
- **Attack:** a raid launcher advances toward a firing position, then fires. Turrets are stationary and require a target already in range at admission. No automatic retarget after destruction.
- **Retreat:** a raid launcher stops attacking, walks to within two cells of its original home tower, then disables. Retreat consumes normal movement energy and can be blocked or starved.
- **Capture:** a raid launcher moves within one cell of a live neutral/enemy outpost and accumulates five uncontested one-second ticks. A live opposing tactical entity within three cells resets progress. Capture changes only the existing outpost's owner; no income, free material or energy is granted. A destroyed outpost cannot be captured.
- **Salvage:** after combat starts, `salvage_unit` schedules one server tick of service. It requires a disabled platform and either a position within three cells of its home tower or a surviving owned recovery robot within two cells of the wreck/platform. Stowed platforms are serviced at home. Position, job conflicts, rack capacity, 300 J and original salvage eligibility are rechecked on completion. Failed service cancels with a reason and grants nothing. Original accounting remains: one assembly is consumed, original constituents become ungraded lots, original hardware becomes untested stock, unspent attachments return once. Fired slugs are never returned.

Raid movement is one grid cell per pulse, costing 30 J from the existing shared process battery, without a free operating charge. Fixed-neighbor BFS avoids public obstacles, deposits and other deployed platforms. The server chooses the route afresh; the public service roads have no speed bonus. Movement is resolved in stable participant/unit order, so occupied cells serialize crossing traffic. A blocked or underpowered order pauses with a reason. Units do not have independent charging in this version.

## Shots, damage and interruption

Existing `units-v1` range, minimum range, cooldown, magazine capacity and shot-energy fixtures remain unchanged. A shot additionally requires an enabled deployed live platform, a valid live enemy target and line of sight through the public scrap walls. All firing decisions in the pulse precede damage application, so units destroyed by equal-time shots still complete their already-paid shots.

| Platform | Damage | Range | Cooldown | Shot energy | Magazine |
| --- | ---: | --- | ---: | ---: | ---: |
| HDPE sentry turret | 25 | 0–16 cells | 2 s | 500 J | 4 slugs |
| Aluminum armored turret | 25 | 0–16 cells | 2 s | 500 J | 4 slugs |
| Steel raid launcher | 50 | 8–32 cells | 5 s | 1,000 J | 2 slugs |

Each shot moves one specific loaded slug from installed to destroyed and detaches its ID from the magazine. The destroyed product retains all constituent mass and hardware in its original allocation; it is spent debris, never a fresh available slug. Shot and movement energy enters the irreversible dissipation account. Damage is integer, clamped at zero, and applied once per boundary. Historical product/job records and the existing finite product-history limits remain in force.

| Target | Maximum health | At zero health |
| --- | ---: | --- |
| Tower | 300 | Destroyed; no winner yet |
| Recovery robot / its sensors | 80 | Stop route/survey/haul, release uncollected reservation once, retire robot, dissipate remaining charge; delivered cargo stays in its wreck allocation |
| Solar generator | 80 | Stop its metered generation; installed replacement solar may continue |
| Battery | 100 | Cut the shared process circuit and dissipate remaining charge |
| Inspection bench | 80 | Cancel its active inspection; release inputs without refunding paid energy |
| Fabricator / separator / manufactured machine | 100 | Cancel/fail dependent paid work under existing interruption accounting |
| Manufactured upgrade | 60 | Disable its charging/solar capability |
| Passive manufactured defense | 80 | Retain destroyed product/debris allocation |
| Outpost | 100 | Clear ownership and prevent capture |

Turrets and launchers keep their declared 100/140/160 health material effects. The battery and separator use the current shared process circuit: destroying either disables base-funded processing, commissioning and charging. Destroying the generator alone leaves already-stored charge available. Hauler attacks disrupt its active route rather than introducing a separately owned road resource. No resource is erased by damage; cargo and irrecoverable wrecks remain counted. Recovery of cargo from destroyed hauler wrecks is not implemented in this increment.

## Verification

`npm run test:simulation` includes isolated command validation, wall/range/cooldown and energy checks, simultaneous fire, hauler reservation cleanup, industry interruption, capture contention, retreat, timed salvage, manufactured target kinds, frequent/sparse shared-clock equivalence and exact replay. `npm run test:combat` starts with real surveyed/recovered/processed/graded stock and tested original hardware, manufactures both turret variants and a raid launcher, then checks two-player combat against the file-backed runtime, rollback, competing SQLite connections, offline advancement/restart, tower damage, solar disruption, capture, retreat, salvage and immutable retries.

The matching tower-defense browser scenario (`npm run test:browser -- --combat`) builds a real turret, defends against the other player's moving recovery robot, verifies damage and ammunition, reloads on mobile, disables the platform near home, then salvages on a server tick. Isolated service tests additionally move a nearby recovery robot away before a remote salvage completion to verify revalidation. It does not claim a complete match or victory flow.
