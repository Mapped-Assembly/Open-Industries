# Defensive structures and raiding units

Issue: isayahc/tower-defense#20. Policy: `units-v1`; additive recipes retain `manufacturing-v1`. All values below are explicit game balance fixtures, not predictions of physical performance. Open-Industries owns every inventory, placement, health and lifecycle transition. Combat orders, firing, movement, damage resolution, capture and victory are subsequent issues #18/#19. No browser damage command exists.

## Production

All four products use existing persistent manufacturing jobs, exact reservations, constituent offcuts, paid power, interruption and transactional receipts. Eligible graded material is required to manufacture the parts; reusable electronics and motors must be recovered and tested. There is no raw-scrap-to-electronics recipe. All assemblies take 8 s at 500 W (4 kJ), at an installed enabled fabricator. One source cannot fund two jobs. The existing 8-job queue, 64-job history, 128-product history and 16-slot part rack apply; unit history is limited to 16, including queued platforms.

| Recipe | Manufactured parts | Tested original hardware |
| --- | --- | --- |
| sentry-turret | 2 steel brackets, copper conductor, HDPE housing | motor, camera, controller, 2 fasteners |
| armored-turret | 2 steel brackets, copper conductor, aluminum housing | motor, camera, controller, 2 fasteners |
| raid-launcher | steel chassis, copper conductor, HDPE housing, 2 traction treads | 2 motors, 2 wheels, controller, robot battery, 2 fasteners |
| steel-slug | 250 g eligible homogeneous steel stock | none; metal press, 4 s at 250 W (1 kJ) |

The same steel bracket/conductor/housing/traction predicates used by machine construction apply here. The aluminum variant gives 140 rather than 100 health and costs 750 rather than 500 J to deploy. This is a declared part-specific balance tradeoff; it does not infer physical armor or thermal properties from material names. The steel chassis and rubber treads gate the launcher platform rather than acting as interchangeable currency.

## Operating limits

| Platform | Health | Range (cells) | Cooldown | Shot energy | Commissioning | Magazine |
| --- | --- | --- | --- | --- | --- | --- |
| sentry-turret | 100 | 0–16 | 2 s | 500 J | 500 J | 4 steel slugs |
| armored-turret | 140 | 0–16 | 2 s | 500 J | 750 J | 4 steel slugs |
| raid-launcher | 160 | 8–32 | 5 s | 1000 J | 1000 J | 2 steel slugs |

Idle power is zero; assemblies carry no initial operational charge. The launcher battery is retained original hardware, not an energy grant. Commissioning and service energy is debited from the shared base battery into its irreversible dissipation account. Future firing must use the declared shared-base shot budget and server cooldown; the present runtime cannot fire. `operational_ready` reports supplied equipment; `can_fire` and target `eligible` remain false with `combat-not-implemented`. Range previews use public opposing tower positions only and disclose no enemy loadout. Initial home-side sites cannot necessarily reach the opposing tower; movement is combat work.

## Lifecycle and accounting

- Assembly completes stowed, disabled and empty. `deploy_unit` costs commissioning energy and places it once at an integer, free, traversable home-side cell with a public-terrain path from its tower. Placement rejects obstacles, occupied base cells, deployed units and the enemy half. No contested placement or teleporting after deployment is supported.
- `set_unit_enabled` applies only to a live deployed unit. `load_unit_ammunition` requires disabled equipment and a specific available owned slug. Loading attaches that product without copying it; the magazine capacity is enforced. Attached slugs and repair patches cannot be destroyed separately or selected for manufacture.
- `repair_unit` requires a disabled damaged live platform, a distinct available manufactured steel bracket, and 500 J. It restores at most 40 health, capped at the catalog maximum. The bracket stays attached with its exact constituents; four patches maximum. Full-health and destroyed platforms reject repairs. The trusted `damageUnit` hook is reserved for server policies/tests; no client may assign health or damage.
- `destroy_manufactured_product` transitions a platform to destroyed and disabled, retains its original BOM and loaded items as accounted debris, and cannot refund inputs. No health or material is fabricated on retry.
- `salvage_unit` requires disabled stowed/deployed/destroyed equipment, no live process jobs, room for output, and 300 J. It marks the original assembly consumed exactly once, returns each constituent as an ungraded homogeneous salvage lot, and returns original hardware as untested component stock. Remaining ammo and attached repair brackets are detached to the part rack. All original BOM history remains immutable; actual allocations move to recovered lots/stock. Reinspection is mandatory before reuse. This v1 fixture models complete constituent recovery, zero material loss and paid dismantling, not realistic disassembly yield.
- The unit projection is owner-only, including its position, health, magazine IDs, readiness and target candidates. Existing version checks, authentication, receipt rollback and competing SQLite-writer serialization apply to every action. No service worker, browser or retry can grant bulk material, hardware, health or energy.

## Save compatibility and verification

SQLite schema **8** rejects older binaries opening unit-bearing saves. Existing schema-7 envelopes, IDs, pins, paid work, resource history and receipt bytes are preserved; only the compatibility marker advances. Native envelope pin and wire version 5 remain unchanged. The published exact schema adds lifecycle commands, optional `units` for historical snapshots, current owner projections and updated recipe/capability catalogs. Upgrade the paired client and server together; back up the complete SQLite database before upgrade or rollback.

`npm run test:units` uses a file-backed authenticated two-player runtime. It recovers/processes/grades real finite dump stock, reclaims and tests starter hardware, constructs both turret variants and a launcher, and verifies power/site errors, exact ammunition, disabled servicing, repair, material effects, private projections, destruction, salvage, receipt-write rollback, concurrent connections, persisted history and retry after restart. `npm run test:simulation` covers invariant/queue/resource regressions; downstream browser tests exercise real controls on desktop and mobile. Full warfare is deliberately unavailable until #18/#19/#17 are verified.
