# Construction and manufacturing queues

Implements [tower-defense #16](https://github.com/isayahc/tower-defense/issues/16). Policy `manufacturing-v1` is a modeled game fixture. Material suitability, measured evidence, parts, existing hardware and finished assemblies remain different records. Nothing manufactures electronics from bulk scrap.

## Bills of materials

Read `astra.game_manufacturing_catalog` for the exact reviewed quantities and rates. `astra.game_manufacturing_preview` accepts owned `batch_ids`, `product_ids` and `component_ids` plus a catalog `recipe_id`. It returns eligibility, missing requirements, next actions and server-owned time/power. Preview never reserves work. `enqueue_manufacturing` rechecks everything in the command transaction and reserves those exact inputs.

| Output | Required station | Declared inputs |
| --- | --- | --- |
| Copper conductor | Bench | 100 g approved copper wire |
| Steel bracket | Bench | 1 kg approved steel stock |
| Aluminum housing | Metal press | 300 g approved aluminum stock |
| HDPE housing | Bench | 200 g approved HDPE stock |
| Glass filler | Bench | 500 g approved compatible glass granulate |
| Traction tread | Bench | 500 g approved rubber tread stock |
| Steel chassis | Metal press | 8 kg approved steel stock |
| Metal press | Bench | 2 brackets, 1 conductor, 4 tested fasteners |
| Furnace | Bench | 2 brackets, 1 filler, 1 conductor, 2 tested fasteners, 1 tested insulated wire |
| Polymer processor | Bench + enabled furnace | 1 bracket, 1 housing, 1 conductor, 2 tested fasteners |
| Fabricator | Bench | 1 bracket, 1 conductor, 2 tested fasteners, tested drive and controller |
| Solar array | Bench | 1 bracket, 1 conductor, tested solar panel and charge controller |
| Charging port | Bench | 1 bracket, 1 conductor, 1 housing, 2 tested fasteners, 1 tested insulated wire |
| Solar reflector upgrade | Fabricator | 1 bracket, 1 filler, 2 tested fasteners |
| Scrap barricade | Fabricator | 2 brackets, 1 tread, 2 tested fasteners |
| Scavenger robot | Fabricator | 1 chassis, 1 conductor, 1 housing, 2 treads; tested motors ×2, wheels ×2, battery, camera, depth sensor, controller and magnetic probe |

Parts take 4 seconds at 250 W (1 kJ); assemblies take 8 seconds at 500 W (4 kJ). These are explicit game balance values, not physical process predictions. Bench parts are cold cutting/finishing of existing approved forms. Homogeneous stock is required. The whole source lot is held while working; completion incorporates only the declared grams and creates an exact, graded offcut from the same homogeneous lot. Cancellation returns the original held lot and never refunds energy spent.

The installed press enables `form-steel`/`form-aluminum`; an enabled polymer processor plus furnace enables the heated `mold-hdpe` route. Paid output inspection establishes the bounded game fixture grade. Disabling a required machine pauses processing. Startup cannot borrow capabilities from the starter separator or heat battery-suspect feedstock.

## Existing hardware and finite allocations

The original starter ledger stays immutable. Current allocations may move into the store, reservations and assemblies, but their original kind/quantity/unit-mass totals must still match. Manufactured products carry recovered constituent grams separately from their existing component records; the shared ledger never issues a new component count in exchange for bulk material.

`salvage_starter_asset` dismantles the parked fabricator, solar equipment or an idle, unloaded robot at home into its exact original hardware. All reclaimed components start untested and require paid bench tests. A retired robot dissipates its remaining battery charge into its existing spent-energy account and cannot dispatch again. This is deliberate finite reuse, not a replenishment grant. Original chassis/frame hardware remains hardware; it is not silently credited as approved steel stock.

A constructed robot receives **zero initial charge** and must charge from the existing base energy budget before dispatch. Optics, controller, motor, wheels and battery must be actual tested hardware. Its routing/sensing rules are the existing robot policy. Sensor-kit manufacturing requiring unavailable detector hardware remains unsupported; no NIR/thermal detector is invented from raw material.

The solar array reuses an existing tested panel/controller and generates 100 W. Each enabled solar reflector adds a modeled 50 W only while solar equipment operates. A constructed charging port supplies 1,000 W instead of the starter 500 W port, on the same bus; it creates no energy or battery capacity. The base retains its 20 kJ capacity. Equipment changes affect the event clock at their actual boundaries. All issued energy remains metered `W × ms` solar. Robots, assemblies and chargers share accounting and production priority.

## Durable lifecycle

Jobs persist `waiting`, `running`, `paused`, `completed`, `cancelled` or `failed`. The common core stores waiting jobs as `queued` and resource waits as `waiting-for-resource`. One production/process job draws the shared bus at a time. The oldest runnable job advances; a manually paused or disabled job does not falsely accrue work. Pauses distinguish requested, power, machine-disabled and storage-full. Power recovery and enabled-equipment/storage recovery resume automatically. Long catch-up and short ticks have equal paid work, mass and energy outcomes.

There are 16 finished-part storage slots, at most 8 live production jobs, 64 retained production jobs and 128 retained product records per crew. Reservations move finished parts to WIP, freeing finished-part rack slots. Bulk batch retention remains limited to 512. Cancel or finish work to release inputs; use or discard finished parts to free racks. Discarded/destroyed products retain all material/hardware in private debris records and cannot pay for new work. A destroyed manufacturing station fails its assembly jobs, returns held inputs once and retains spent energy. A source separator destruction/abandonment uses the existing cancellation path. Completed outputs never receive both a refund and another output on retry.

`set_production_machine`, `destroy_manufactured_product` and the existing pause/resume/cancel commands operate on owned IDs only. Assembled defenses are base equipment ready for later combat rules; construction does not enable combat, capture or victory. All current production state is owner-only. Other crews see neither hardware reservations nor finished inventory.

## Compatibility and verification

SQLite schema **7** guards manufacturing saves against older binaries. Opening schema 6 advances only the compatibility marker; existing envelopes, IDs, evidence, pins, active work and immutable receipts are unchanged. Unknown manufacturing policy pins fail closed. Back up the complete SQLite database before upgrade; rollback requires that complete pre-upgrade backup. Wire v5 adds reviewed tools, actions and an owner-only manufacturing projection; the new projection is optional only to validate old immutable receipts. Upgrade the matching client together.

`npm run test:manufacturing` runs a fresh file-backed two-account recovery-to-assembly chain, including the full machine set, reclaimed/tested hardware, uncharged robot, solar/charging, defense/upgrade, heater interlock, exact offcuts, failed receipt rollback, cancellation, destruction, real restart/replay, power starvation, storage capacity, competing connections and private projections. `test:simulation` additionally compares long/short power-starved manufacturing schedules and refusal rules. Manufacturing has dedicated Linux/Windows CI jobs; existing native, material and scene regressions remain independent. The client browser suite builds an actual press on desktop and manufactures a conductor on mobile, using reviewed bills of materials and UI controls.
