# Starter recovery processing

Issue [tower-defense #15](https://github.com/isayahc/tower-defense/issues/15) adds game policy `starter-recovery-v1` without changing the pure `materials-v2` / `balance-v2` package or manufacturing parts. The existing inspection bench and separator cutting/sorting head form the modeled starter recovery cell. No new asset, mass, furnace, press or molding capability is granted.

| Waste family | Supported recipe | Usable output | Target recovery |
| --- | --- | --- | --- |
| Cable | Existing cable separation / residue recovery | Copper conductor and HDPE flakes | Existing balance-v2 fractions |
| Construction | bench-recover-steel | Steel stock | 49/50 |
| Packaging | bench-trim-hdpe | HDPE stock | 9/10 |
| Compatible glass | bench-sort-glass | Glass granulate | 19/20 |
| Tire | bench-cut-tire | Rubber tread stock | 9/10 |
| Appliance | isolate-appliance | Steel stock | 19/20 |
| Vehicle | isolate-vehicle | Aluminum stock | 19/20 |

Every new route requires paid graded bench evidence, sound condition, supported mixed/scrap form (HDPE flakes also accepted), a ready bench/separator, 500 W and the full planned energy. Cold operations run at at most 20 °C and take 2 seconds/kg: a 10 kg load costs 10 kJ over 20 seconds. Ordinary feedstock needs the exact supported game grade and at least 90% target material; unknown constituents and suspect hazards refuse ordinary recovery. Compatible glass requires its trusted glass-family origin. Inputs too small to yield one whole gram are refused.

Appliance/vehicle isolation requires the matching original inspected load, suspect-battery evidence and at least 60% target metal. Only the target metal enters the usable stream. Every non-target constituent, including every unknown gram, remains in suspect residue. Its quarantine survives reinspection and restart; neither generic processing nor repeated isolation can clear it. No battery disassembly, chemistry or mixed-electronics processing is modeled.

Outputs start ungraded. A further paid bench job establishes bounded synthetic game evidence for use evaluation: steel stock/brackets, aluminum stock/housings, HDPE stock/housings, compatible glass filler and rubber traction tread. Copper retains its existing conductor path. These are material suitability results for later manufacturing (#16), not completed components or real property/safety certification. HDPE service-temperature bounds and metal measurement temperatures remain enforced.

The server computes all rates, fractions, grades and machine limits. Clients submit owned IDs, never truth or property values. Previews give stable reason codes and next actions; startup repeats checks within the command transaction. The shared pure planner reports its balance-v2 math version; new jobs/output provenance separately pin starter-recovery-v1. Outputs plus residue conserve each constituent exactly, using floor whole grams. Pause/resume, cancellation, failed receipt writes and restart retain the existing input/energy/receipt guarantees.

Wire v5's reviewed recipe/form/output/version schemas and capability list are extended, requiring the matching client. SQLite schema 6 is a compatibility guard: old runtimes reject the new database version. A schema-5 database keeps its existing envelope, IDs, pins, jobs and immutable receipts unchanged when the marker advances. Back up the complete database before upgrade; rollback requires that complete pre-upgrade backup.

Run `npm run test:mcp-game` for the file-backed six-family production regression and `npm run test:simulation` for policy and schema-5 preservation checks. The downstream browser test additionally drives steel recovery on desktop and hazardous vehicle isolation on mobile through paid inspection, actual processing and use evaluation.
