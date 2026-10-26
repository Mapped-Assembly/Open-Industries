# Recorded field-lab scene playback

This is the event-playback portion of #12, not completion of the motion handoff.
`src/lib/field-lab-playback.ts` is a pure projection and playback module. Its inputs
are authorized runtime post-state snapshots, not browser clocks or scenario guesses.
The compact `FieldLabDatabase.sceneHistoryPage` projection retains the existing
history ACL, fixed-head cursors, event IDs and checkpoint semantics. It is currently
used by the local recorder; it is not a new HTTP route.

The scene occurrence `pipette` binds to the scene's canonical JSON SHA-256. Job IDs
are scoped by the lab instance ID; event IDs come directly from the durable journal.
Positions use metres, right-handed Y-up; paid work and event cursors use integer
milliseconds. A pose fraction maps the existing authored 24-second pipette track
onto the recipe's paid 900,000 ms. Only pipette tracks are driven: unrelated courier
and instrument animation must not suggest unsupported operation.

Paused work retains its reservation and paid pose. On failure or cancellation the
last started job's checkpoint retains the pose until a new job starts. Waiting jobs
cannot increment completed counts. A terminal pose uses the endpoint without modulo
wraparound. A new job deliberately starts a new authored cycle; transition clearance
between cycles has not been verified. No physical dispatch is performed.

Recordings retain every sampled post-state with stable IDs and source hash. Import
rejects duplicates, time reversal, mixed instances and stale scene hashes. Runtime
restart uses the same durable history. Server history is bounded, so reconnect cannot
reconstruct already compacted motion: capture events before compaction, or begin from
the supplied checkpoint and explicitly accept the missing earlier interval. The local
recorder does the former. The viewer does not interpolate between recorded states.

## OpenCAD inspection and remaining handoff

Inspected OpenCAD revision `5cf1a47dda7b80fc6b5ac47a9f60f8d6030dba0f`:

- `docs/SCENE_INTERACTIONS.md`
- `packages/opencad/src/opencad/assembly/models.py`
- `packages/opencad/src/opencad/scene/collision.py`
- `packages/opencad-viewport/src/sceneCollision.ts`

Its existing version-1 SceneDocument separates assembly hierarchy from temporary
interaction relationships. MOVE evaluates component-local poses; GRASP, RELEASE and
PLACE handle attachment/support semantics. Transforms use millimetres, Z-up and XYZW
quaternions. The OI conversion must therefore include both unit and frame conversion;
geometry baked into world coordinates must first be expressed in component frames.
Do not recreate or reopen OpenCAD #121.

The existing motion validator supports authored oriented box proxies, self-collision,
attachments, ground checks, exclusions and conservative interval subdivision. Status
can be clear, collision, uncertain or unchecked. Its default penetration tolerance is
0.001 mm. MOVE itself neither enforces travel limits nor solves IK; GRASP/PLACE do not
prove contact. These are inspected upstream capabilities, **not checks executed on
this pipette**. No collision or contact pass is claimed by this change.

Remaining acceptance work before closing #12:

1. Stable component/joint/interface and source CAD revision mapping through the actual
   OpenCAD import/export, including frame revisions and exact transform conversion.
2. Pipette transfer fixture evaluated by OpenCAD, with explicit travel limits, normal
   and blocked/misaligned cases, intended-contact exclusions and coverage/tolerances.
3. Imported evaluated transforms/checks, invalidation after CAD/frame edits and preserved
   interaction semantics on export/reimport. Scene hash checks here cover only OI scene
   recordings; they are not CAD motion-finding invalidation.
4. Live authenticated workbench connection, occurrence selection with job/reason details,
   and reconnect handling for history cutover. Current evidence is offline playback and
   a compact server projection, with job state/reason exposed in the benchmark overlay.

Harness feasibility, liquid transfer, assay validity and hardware safety remain
unsupported. Continuous path certification cannot be inferred from rendered checkpoints.

## Verification

`npm run test:simulation` includes file-backed pause/resume, failure, immutable receipt
retry, restart, JSON round-trip, duplicate rejection and stale-scene tests for playback.
`npm run test:animation` and `npm run test:portable-scenes` cover existing scene semantics.
`node benchmarks/field-lab/run.mjs --render` produces the event recording, screenshots,
GIF, optional MP4 and event/source metadata. Browser capture requires working Chromium.
