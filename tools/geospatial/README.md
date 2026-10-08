# Static OI scenes → 3D Tiles 1.1

A small, independently runnable Python converter and local CesiumJS/Three.js
interoperability demo for [issue #18](https://github.com/Mapped-Assembly/Open-Industries/issues/18).
It consumes the geometry already bundled in a portable OI scene. It does not
tessellate CAD, perform physics, or build a general-purpose streaming hierarchy.

## Reproduce

Python 3.11+ is sufficient for conversion and contract tests. The separate
viewer/validator package uses Node 22.18+ and a committed npm lockfile. Root
application dependencies and provider credentials are unnecessary.

From the repository root:

```sh
python tools/geospatial/export_scene.py benchmarks/field-lab/fixtures/field-lab.oi.json tools/geospatial/public/export --longitude=-73.977 --latitude=40.684 --height=30 --heading=0 --license-note="Existing conceptual FIELD-LAB fixture; redistribution permission unresolved"
python -m unittest discover -s tools/geospatial -p test_export.py -v
cd tools/geospatial
npm ci --ignore-scripts
npx playwright install chromium
npm run validate
npm run test:browser
npm run serve
```

Open <http://127.0.0.1:4194/> for CesiumJS or
<http://127.0.0.1:4194/?viewer=three> for the independent 3D Tiles renderer.
The server is local; nothing is published or deployed. Both runtimes load the
same local tileset without Cesium ion, imagery, login, or tokens. Dependencies
and browsers need network access during installation only.

`--ignore-scripts` avoids unused native SQLite build hooks pulled in by the
validator's archive tooling. This adapter validates directory-based JSON/GLB,
not SQLite tile archives. The pinned sharp override supplies platform packages
instead of the old validator dependency's legacy installation hook. Runtime
dependencies retain their own licenses.

## Coordinate contract

- Input is `astra.scene` v1, meters, right-handed Y-up. OI rotations use
  Three.js Euler XYZ in degrees.
- At heading zero, OI +X is east, +Y is up, and -Z is north. The caller explicitly
  supplies WGS84 longitude, latitude, **ellipsoidal** height, and heading.
  Heading rotates clockwise from true north, in [0, 360).
- GLB positions remain Y-up. A 3D Tiles runtime applies the standard Y-up→Z-up
  rotation `C`, mapping (x,y,z) to (x,-z,y). Child transforms are
  `C × OI_pose × inverse(C)`. The root is WGS84 ENU→ECEF with heading.
  Tile bounds are Z-up; all serialized matrices are column-major.
  The empty root uses a conservative extent-sized geometric error to request
  refinement; exact leaf geometry has zero geometric error.
- Stored mesh vertices are already normalized and stored instance positions
  already locate those normalized origins. **Do not add originOffset again.**
  The offset is retained as source provenance.
- The Three.js viewer recenters the ECEF scene into the original local meter
  frame for numerical precision. It loads the identical geographic tileset.
- Geographic anchors are illustrative. The converter does not fetch terrain,
  infer ground height, geocode a lab, or establish surveyed accuracy.

## Data and metadata mapping

| Input | Output |
| --- | --- |
| Indexed part geometry and linear RGB | Shared-asset GLBs with unlit, double-sided materials |
| Visible instance placement/rotation | One leaf tile per instance; same asset content reused |
| Asset ID/name and source digest | glTF EXT_mesh_features + EXT_structural_metadata property table |
| Instance ID/name, asset ID, source kind/digest | 3D Tiles tile metadata; inherited when geometry is picked |
| Project identity/revision, cloud binding, source normalization offset, part IDs | Allowlisted provenance.json sidecar |
| Input file byte digest and checkout revision | Export report and provenance; revision is null outside Git |
| Hidden geometry, animation, hierarchy grouping, BOM/compiler findings, source documents, room decoration | Explicitly excluded; no claim of lossless IR transfer |

There is no static feature ID per animated component: all primitives of a shared
asset refer to its single asset feature. Part identities are preserved in node
extras and the sidecar. Instance identity belongs to the leaf tile and remains
distinct when two instances share one GLB. Arbitrary provider settings, raw IR,
source documents and credentials are not copied; this allowlist is stricter than
the full OI portable export. It cannot detect secrets pasted into an allowed name.

## Validation and evidence

The converter writes tileset.json, content-addressed GLBs, provenance.json and
export-report.json with source/output hashes, Python version, payload size and
conversion timing. Existing unrelated files in the output directory are not
deleted; the report and validators enumerate only current referenced content.
Use a fresh output directory for a distributable package.

`npm run validate` records complete diagnostics from 3d-tiles-validator 0.6.1
and gltf-validator 2.0.0-dev.3.10. The latter reports metadata extensions as
unsupported informational messages; the 3D Tiles validator additionally checks
those extensions. Zero core errors alone is not proof that every extension or
engineering property is valid.

`npm run test:browser` starts and closes its own Vite server, verifies placement
against independent Cesium WGS84/ENU and Three.js Euler implementations within
1 cm, loads both runtimes, and clicks pipette geometry to check exact identity.
It saves screenshots, browser/runtime versions, load timing, and memory metrics
under evidence/. External browser requests are blocked in this test.

The workflow runs Python checks on Linux/Windows and viewer/conformance checks
at two demonstration anchors on Linux. Screenshots, validator diagnostics,
checksums, geometry, and timing are uploaded as CI artifacts. Load/capture timing
on a software-rendered browser is not interactive FPS or physical performance.

The upstream FIELD-LAB merge has passing [benchmark](https://github.com/Mapped-Assembly/Open-Industries/actions/runs/37550844141),
[scene](https://github.com/Mapped-Assembly/Open-Industries/actions/runs/37550844134),
and [runtime](https://github.com/Mapped-Assembly/Open-Industries/actions/runs/37550844184)
workflows at e88f5ce5f8eeb4eda6a49757d5325699cd815cea.
Adapter CI is separate and must be checked at the published PR head.

## Openness and limits

The new source/documents in **this tools/geospatial directory** are MIT licensed.
That license does not relicense the repository, imported FIELD-LAB or cleanroom
assets, dependencies, or generated models. `--license-note` records the user's
evidence or unresolved status; it does not grant permission or certify rights.
Confirm original asset permissions before redistributing a grant demonstration.

For a fully MIT-licensed interchange fixture, use
`fixtures/open-equipment.oi.json`: two instances of a newly authored asymmetric
workbench envelope, including a 90-degree rotation and shared geometry. Its
conceptual boxes do not reuse the existing lab/CAD assets. Substitute that input
in the converter command and set `--license-note="MIT; tools/geospatial/LICENSE"`.
The browser smoke test specifically targets the 21-instance FIELD-LAB fixture;
the minimal fixture can be inspected manually and checked with the validators.

This first version exports the **static base layout**, not frame zero of the
authored animation. No animation, scientific validity, perception, provider
generation, cold-chain solver, live operation, or physical validation is implied.
The small FIELD-LAB fixture is not a scalability benchmark. A state/replay
overlay and resolved asset licensing remain follow-on work; issue #18 should
stay open until its remaining evidence gates are addressed.
