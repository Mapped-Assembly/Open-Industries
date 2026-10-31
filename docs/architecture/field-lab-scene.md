# FIELD-LAB event-driven scene and OpenCAD handoff

Issue #12 adds a current runtime viewer at `benchmarks/field-lab/runtime.html`.
The original `render.html` film and its frozen numerical evidence remain historical
kinematic artifacts. They are not the new runtime replay.

## Run and reconnect

```bash
npm ci
npm run field-lab:viewer
```

Open http://127.0.0.1:4193/benchmarks/field-lab/runtime.html and click **Connect**.
This starts a local simulated baseline day with the existing FIELD-LAB SQLite domain.
Jobs take their actual modeled 15 minutes; the renderer cannot accelerate the server clock.
Select an occurrence in the dropdown or click geometry to see its job, progress, and reason.
Pause/resume and modeled failure operate through existing transactional commands.
The worker continues while the viewer is disconnected. Restart the launcher to reopen the
same database and run. An eight-hour completed day remains completed; it is never silently reset.
For another independent day use a new `FIELD_LAB_VIEWER_STATE_DIR` directory.
`FIELD_LAB_VIEWER_PORT` changes the local port.

This development launcher is an operator-local Vite application, bound to 127.0.0.1.
Its private operator credentials live in `~/.local/share/open-industries/field-lab/operator.json` and never
enter browser responses or exports. Back up this directory coherently with its SQLite
state. Host/Origin checks reject foreign browser requests. It is not a remotely exposed
multi-user deployment or a physical equipment controller.

## One authoritative timeline

`FieldLabDatabase.sceneHistoryPage` projects the same authorized event IDs and fixed-head
history as the runtime, selecting only scene bindings, jobs, recipe, and time. This avoids
copying complete resource ledgers into every browser frame. The existing full history API
is unchanged. The scene projector does not create jobs or award results.

The recording includes a retained checkpoint and ordered post-state events. The runtime
retains at most 64 events / 2 MiB of raw history, so older history can be compacted. The
viewer exposes this boundary and never synthesizes missing intermediate work. Reconnect
replaces the recording with the current retained history; replay is limited to that range.

Component poses derive from the selected job's **paid progress**, normalized from the
900,000 ms recipe to the 24-second OpenCAD interaction. A paused or failed job retains that
progress. When no job is running, the last started job supplies the held pose, while queued
resource waits remain visible in the inspector. An authored return stage joins successive
cycles at the same home pose. Static scene assets are not animated from the old film clock.
The evaluated handoff uses held 0.25-second motion samples (9.375 seconds of recipe work);
there is no extrapolation between recorded events. This is a discrete kinematic projection,
not a fluid solver, servo loop, or continuous observed equipment motion.

**Export recording** preserves the scene, OpenCAD document and evaluated samples/checks,
source pins, stable occurrence/component/interface/joint IDs, runtime job/event IDs, and
replay cursor. Reimport uses the same projection as reconnect. Screenshots carry the scene
hash, implementation revision and event ID visibly, plus companion JSON with motion hash.
Exports contain modeled state; they are not signed attestations or physical measurements.

## OpenCAD reuse and checked mechanics

The exporter calls existing OpenCAD `SceneDocument`, `evaluate_scene`, scene serialization,
and `validate_scene_motion`. It does not introduce an alternative interaction or collision
engine. Reproduce against the inspected revision:

```bash
git clone https://github.com/Mapped-Assembly/OpenCAD.git ../OpenCAD
git -C ../OpenCAD checkout 9c0c6dc0b5794debdfb8c7507078bae3303dd8bd
python -m pip install -e ../OpenCAD/packages/opencad
python benchmarks/field-lab/export-motion.py --opencad-source ../OpenCAD
```

The committed `fixtures/pipette-motion.json` contains the evaluated document, 97 sampled
poses, stable component mapping, tip/task interfaces, modeled X/Z travel IDs, and checks.
OI right-handed Y-up meters convert to OpenCAD Z-up millimeters as `[x,-z,y]*1000`,
and back as `[x,z,-y]/1000`. Component translations are applied relative to the original
mesh, then the OI occurrence transform places the assembly in the room. This fixture has
no rotational joints; the adapter does not claim arbitrary articulated CAD support.

The transfer lowers at the source reference, raises, translates, lowers at the destination
reference, raises, and returns. Evaluated motion is checked against X [-270,290] mm and
Z [-90,0] mm limits. An altered 400 mm destination fails the sampled travel check; a task
reference displaced by 20 mm fails the 1 mm interface-alignment test.
These task reference heights are conceptual; alignment is not proof of liquid contact.

OpenCAD's conservative interval checker examines box proxies derived from selected source
meshes, with 0.001 mm collision tolerance and 0.0001 second subdivision tolerance. The
blocked-path variant inserts an obstruction and must report a collision. Explicit mount
and carriage-contact exclusions are retained in the document and exported evidence.
The overall clean-scene result is **unchecked**, not clear: fused frame, tube/rim arrays,
plate wells and electronics have no collider coverage. Mesh contact, liquid transfer,
assay validity, cables/harnesses and hardware certification are unsupported. Passing
sampled travel/alignment checks does not certify continuous-path or hardware behavior.

Source scene and Form hashes use UTF-8 with LF newline normalization. Geometry, part-frame,
placement, or Form changes invalidate the old findings. The viewer keeps geometry usable
but disables the stale motion handoff and labels it for revalidation. Re-export against
changed CAD and explicitly update the runtime's scene binding through a compatible domain
revision; do not edit saved runtime hashes to bypass pin validation.

## Verification

```bash
npm run test:field-lab-scene
npx playwright install chromium
npm run test:field-lab-scene-browser
npm run test:field-lab
npm run test:simulation
npm run build
```

Scene tests use real file-backed SQLite for pause/resume, failed motion, shortages,
compaction, immutable retries, restart, private access, stale-source detection, and all-frame
export/reimport equivalence. They write replay fixtures under `deliverables/field-lab`.
Browser tests consume those fixtures, verify selection/pose/cursor and screenshots, then
exercise a fresh live station with viewer disconnection, reconnect, pause and origin checks.
Set `ASTRA_CHROME_PATH` to an installed Chromium executable if necessary. No cloud account
or model provider is needed. CI also regenerates the handoff against pinned OpenCAD.

For background execution across terminal closure and Linux host startup, use the
[installed local service](../persistent-runtime.md). `field-lab:viewer` remains foreground development.
Existing checkout-local saves are not moved automatically: set `FIELD_LAB_VIEWER_STATE_DIR`
to their absolute directory to reopen them. Opening a viewer never resets an installed station.
