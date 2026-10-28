# OpenCAD robot asset handoff

OpenIndustries can accept `opencad-robot` as a **verified source label**
for a generated asset. This is different from Form-generated geometry and is
kept distinct in source metadata and provenance checks.

## Generate from OpenCAD

In a checkout of OpenCAD that supports
`opencad export ros-package` (Mapped-Assembly/OpenCAD issue #9):

```bash
opencad export ros-package my-robot.opencad.json \
  --package-name my_robot_description \
  --output /tmp/my_robot_description
```

The directory contains `urdf/`, `meshes/`, the standard ROS `package.xml`
and `CMakeLists.txt`, plus `oi.asset.json` and `robot.handoff.json`.
The former is an actual OpenIndustries `Asset` v1 geometry bundle; the latter
preserves link/joint names, visual and collision references, material metadata,
ROS units, mesh/URDF SHA-256 hashes and unverified physical capabilities.

The OpenCAD adapter bakes each visual mesh into a **static neutral pose**,
converting from right-handed Z-up millimeters to right-handed Y-up meters with
`(x,y,z) -> (x,z,-y)`, and preserving separate visual occurrence part IDs
under the original nested URDF link hierarchy.

**This is not an animated robot controller or a verified linkage solver.**
Mimic joints, passive loops and spring dynamics are not inferred, and OI never
interprets a static robot asset as physically validated.

## Import into local OpenIndustries scene storage

```bash
ASTRA_SCENE_BACKEND=local \
node --import tsx cli/local-scenes.ts import-asset /tmp/my_robot_description/oi.asset.json
```

The CLI returns an immutable `{"kind":"local","version_id":"..."}` reference.
Use that reference as an `instance.asset` in the existing
`astra.create_scene` MCP call with room dimensions (meters), Y-up
placement and Euler rotation (degrees). Component animation targets may use
stable part IDs like `urdf:tip:visual:0`, but must be authored separately
and **are not mechanically validated by this handoff**.

This is a typed asset handoff through the existing local scene backend; it
does not create a new public network endpoint or implicitly upload CAD files.

## Provenance and testing

A generated robot asset uses:

```json
{"kind":"generated","generator":"opencad-robot","filename":"demo.urdf","digest":"<sha256>"}
```

OpenIndustries' cloud/local asset validators now explicitly accept the
`opencad-robot` generator without relaxing source-type or geometry checks.
`assertSourceMatches` also prevents replacing one generated-source
provider with another for an otherwise identical asset reference.

Run `npm run test:opencad-robot` to exercise schema parsing, local immutable
asset persistence, MCP inspection, static-scene creation and retrieval,
and rejection of unknown generators. For full cross-repository coverage,
provide `OPENCAD_OI_ASSET_PATH=/path/to/oi.asset.json` to run the exact same
consumer test on an asset produced by OpenCAD.

See [OpenCAD issue #9](https://github.com/Mapped-Assembly/OpenCAD/issues/9).
