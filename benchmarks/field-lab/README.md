# FIELD-LAB-01 — scarcity benchmark

A fictional rural environmental-water lab, authored and rendered on 2026-10-05 using **Mapped-Assembly/Open-Industries main at `810f182e40011288e6f3280cd34926521481697b`**. This is a versioned integration baseline and gap assessment, not a certification of physical laboratory performance or a test of every CAID service.

The benchmark is deliberately split into three independently reproducible layers:

- the portable Open-Industries scene and authored kinematics;
- the deterministic six-scenario resource ledger; and
- optional browser/CAD evidence, reported with explicit capability states.

The fixed baseline is 08:00–16:00 in 15-minute steps. The runner rejects other horizons or step sizes until an extended model is versioned.

## Open the deliverable

In Open-Industries, choose **Import OI project** and select `benchmarks/field-lab/fixtures/field-lab.oi.json`. It includes all geometry, 21 instances, a 24-second timeline and eight animation tracks. No account or cloud database is required. Choose **Animate → Play animation** to view the kinematic workflow. Import `benchmarks/field-lab/fixtures/field-lab-pipette.step` separately for CAD review, or `benchmarks/field-lab/fixtures/field-lab-pipette.form.json` for the equipment/BOM handoff.

The render command produces `field-lab-benchmark.mp4` when ffmpeg is available and a native `field-lab-native.gif`. The presentation shows the normal day, a pipette/camera close-up, combined disruption, and a resilience package. The six-result panel is populated from the actual benchmark JSON.

The main film directly calls the unmodified OI `createWorld`, `applyWorldPoses` and `evaluateWorkspace` functions. It adds a camera, lights, shadows and captions. The imported portable scene retains OI's own default workbench appearance. The film freezes the workflow when the resource model blocks job admission; it is not a physical motion controller. Camera hardware is shown; no perception is running.

## Scenario and result

An approximately 8 × 5 m lab sits in a 17 × 12 m site. Sample intake, washing, a single-channel pipetting gantry with a tip camera, a microscope, a generic reader/centrifuge, dry supplies, cool storage and segregated waste occupy the interior. The yard contains solar panels, a battery, a clean-water tank, a repair bench and a delivery motorbike. The roof and two upper walls are removed for review. Architecture and equipment are newly authored conceptual geometry; they are not surveyed buildings, certified component models or manufacture-ready assemblies.

The short chain is **district depot → motorbike → lab**, with local repair on site. Consumables are imported from the depot, not manufactured from recovered material. Country, travel distance, supplier reliability and local costs are intentionally unspecified; this scenario makes no claim about any particular developing country.

| Eight-hour scenario | Jobs completed / 24 | Unserved base-load energy |
| --- | ---: | ---: |
| Normal supply | 24 | 0 Wh |
| Missed district delivery | 12 | 0 Wh |
| Cloudy day / low starting battery | 6 | 44 Wh |
| Water rationing | 8 | 0 Wh |
| Combined supply, water and energy disruption | 12 | 26 Wh |
| Prepositioned stock + water + deferred loads | 24 | 0 Wh |

Completion is a proxy job count, not verified test results. In the cloudy and combined cases, essential loads eventually lose power. There is no thermal/cold-chain solver, so jobs completed before an outage cannot be assumed to remain analytically valid. Workload, utility coefficients and solar production are synthetic assumptions. The 24/24 resilience result ends with exactly 0.5 L of water and no tips or kits: it meets this one-day scenario but is not robust to a longer disruption.

### Reproducible model assumptions

- 24 jobs arrive in four batches of six, at 08:00, 10:00, 12:00 and 14:00; the day ends at 16:00.
- A 15-minute discrete slot can complete at most one available job. No labor, incubation, chemistry, assay accuracy, contamination or instrument warm-up model is present.
- Each job requires 2 tips, 1 generic assay consumable, 0.35 L water and 12 Wh. There is an additional 0.2 L/hour housekeeping-water demand.
- Base load is 75 W. Battery capacity is 1,000 Wh; the normal day starts with 650 Wh. Jobs need to leave at least 80 Wh and 0.5 L after admission. Base/housekeeping demands can consume these reserves.
- The normal hourly delivered solar-energy curve is `[60,160,280,380,400,300,180,80]` Wh. These are illustrative DC-bus yields, not a weather model or a calibrated 1 kWp array.
- Normal opening stocks: 24 tips, 12 kits and 8 L water. The 11:00 delivery adds 24 tips, 12 kits and 8 L water. There are no hidden replenishments.
- Cloudy case: 20% solar production and 260 Wh starting battery. Rationed-water case: 4 L opening water and no water in the delivery.
- Combined case: no delivery, 20% solar, 350 Wh opening battery and 6 L opening water.
- Resilience case starts with 48 tips, 24 kits and 10.5 L water, retains the combined case's battery/solar, and reduces assumed deferrable loads by 40 W, leaving 35 W. The added stocks are 24 tips, 12 kits and 4.5 L relative to the combined case. No device-specific load-shedding or cold-storage performance is validated.

Every tick checks nonnegative resources. End-of-day checks conserve energy (including solar spill), water, tips and kits. Replay is deterministic. Zero-stock and invalid-input tests are included. All assumptions, interval states, blocking reasons and balances are in `field-lab-results.json`; modify `simulate.mjs` for new cases.

## What the technology demonstrated

| Layer | Observed result | Boundary |
| --- | --- | --- |
| Open-Industries scene | PASS: 21-instance native UI import, no missing geometry, portable round-trip, animation and rendered frames | Procedural geometry and keyframed kinematics |
| Form handoff | PASS: scenario-authored Form project imports through the production adapter, retaining equipment/BOM data | Not generated by a live Forma model |
| CAD handoff | PASS: CadQuery solids exported to STEP; actual OI worker/OpenCascade conversion returns 63 meshes with checked 1.12 m width and 0.76 m depth | This used CadQuery 2.7.0, not the OpenCAD application or its joint/physics systems |
| Core regression suites | PASS: CAD import, scene schema, animation, portable scenes and production build | Package-level/model coverage; not every repository test was run |
| SQLite game runtime | PASS: finite world, private projections, mass/energy balance, retries, transaction rollback, hard restart and autonomous scheduler suites | Existing recovery-game fixtures; this lab resource model is not wired into that durable game service |
| Scarcity model | PASS: six deterministic scenarios and conservation/stockout checks | New standalone harness; not a preexisting native OI lab simulator |
| Live Form generation bridge | BLOCKED in this environment: installed `caid-forma-core` 0.3.6, bridge requires 0.3.5 | No provider inference, mini-PC call or production deployment tested |
| OpenCAD robotics, camera vision, instrument sensing | NOT TESTED | Camera geometry does not establish perception, robot accuracy or fluid handling |
| Real supply-chain or scientific validity | NOT TESTED | No empirical consumption, stochastic logistics, assay validation or cold-chain evidence |

`native-checks.json`, `integration-checks.json`, `scene-checks.json`, `render-checks.json` and logs preserve the evidence. Two npm wrappers initially hit a local `tsx` IPC socket error; the exact underlying CAD/scene suites passed with `node --import tsx`. The rendering environment used Chromium 153 with SwiftShader; screenshot capture timings are recorded, but are not interactive FPS or hardware performance measurements. The agent-browser launcher could not start its daemon in this environment; repository Playwright tooling performed the browser checks and captures instead.

## Next benchmark gates

1. Reconcile the Form bridge's supported package version, then run one genuine equipment-generation request and import its output.
2. Replace the conceptual pipette assembly with an OpenCAD mechanical design; verify travel, collision clearance, wiring and BOM against the CAD.
3. Add simulated camera images, perception results and controlled aspiration/dispense events, with explicit accuracy metrics.
4. Connect the lab's inventories and jobs to the durable SQLite service, then repeat power/supply disruptions with process restart and replay.
5. Calibrate consumption and critical-load/thermal behavior from instrument measurements; add multi-day reserve and delayed-delivery cases.

## Capability states and evidence boundary

Every run emits `capability-report.json` with the four states `passed`, `failed`, `blocked` and `not-tested`. A passing numerical replay does not imply that a provider, camera, physical robot, assay, thermal system or supply chain was tested.

The committed fixture records the original audit bundle SHA-256 in `manifest.json` and preserves the original scene, Form/BOM, STEP and geometry-spec hashes in the generated checksum evidence. Generated render timing is explicitly labeled as frame-capture timing; it must not be reported as interactive FPS or hardware throughput.

## Reproduce from a clean clone

Node 22+ and the repository npm dependencies are required. The browser and media encoder are optional unless render evidence is requested. CadQuery is optional for rebuilding the STEP fixture; the versioned STEP file is used for deterministic worker verification when CadQuery is unavailable. No cloud login or provider secret is required.

The same commands work in Bash, PowerShell and `cmd.exe` because output paths are handled by the scripts:

```sh
npm ci
npx playwright install chromium
node benchmarks/field-lab/run.mjs deliverables/field-lab
```

The replay writes the scene build, six-scenario results, `simulation-checks.json`, `capability-report.json`, per-step logs, `run-summary.json` and `checksums.json` under `deliverables/field-lab`.

To run native UI import, actual STEP-worker conversion, the browser render and the native GIF export:

```sh
node benchmarks/field-lab/run.mjs deliverables/field-lab --render
```

Use `ASTRA_CHROME_PATH` only when Playwright's managed browser is not appropriate. There is no hardcoded browser or `/tmp` path. Ports default to 4192 for verification and 4191 for capture and can be changed with `FIELD_LAB_VERIFY_PORT` and `FIELD_LAB_CAPTURE_PORT`.

To rebuild the STEP from the source recipe when CadQuery is installed:

```sh
python benchmarks/field-lab/export-cad.py deliverables/field-lab
```

The optional MP4 conversion is separate from benchmark correctness:

```sh
ffmpeg -framerate 10 -i deliverables/field-lab/frames/%04d.png -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart deliverables/field-lab/field-lab-benchmark.mp4
```

The repository workflow `.github/workflows/field-lab.yml` runs the reproducible replay on Linux and Windows, and publishes the output directory as a CI artifact. Linux additionally runs browser verification and render capture. The artifact contains inputs, versions, checksums, logs, numerical results, capability states and render evidence.
