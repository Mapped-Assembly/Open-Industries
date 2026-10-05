# Cleanroom POC Example

This bundled Mergence scene is a local architectural visualization and schedule demo. It is opened with `/?scene=cleanroom`; that route does not replace the user's saved workspace.

The example models four 20 ft rooms within an 80 ft square, 20 ft perimeter corridors, four cleanroom workbenches, and one Form swab-sampling robot. The illustrative A/B/C schedule is in `sampling-plan.json`; Room B is deliberately skipped while marked occupied. Confirm access, sample targets, egress, HVAC, classification, and fabrication requirements before real operation. The STEP robot is a mostly fused CAD pose, so its sampling contact is approximated with a short whole-robot approach/retract.

## Asset units and provenance

All bundled geometry, positions, dimensions, and MCP requests use **meters**, Y-up, with XYZ rotations in degrees. STEP assets are tessellated imported geometry. The 80 ft footprint is 24.384 m; each 20 ft room is 6.096 m. Source digests and immutable asset identities are recorded in [`asset-provenance.json`](asset-provenance.json), checked by the cross-agent integration suite.

| MCP example ID | Source | Representation | Available license evidence / usage permission |
| --- | --- | --- | --- |
| `cleanroom-architecture` | Repository generator in `src/lib/cleanroom.ts` | Procedural floors, walls, doors, lights, and markings; visualization only | No explicit repository license file is present. Confirm permission with maintainers before redistribution. |
| `cleanroom-robot` | Imported `swab_bot.step`; originally identified as `forma-cleanroom-swab-bot` | Form-authored source project, tessellated STEP, mostly fused CAD pose; whole-body sampling contact is approximate | Original example notes report CERN-OHL-S-2.0; upstream source archive and license notices are not bundled. Verify those documents and applicable conditions before reuse. |
| `cleanroom-desk` | Imported `cleanroom_desk.step`; originally identified as `forma-cleanroom-desk` | Form-authored source project, tessellated STEP; four placed copies share geometry | Same reported CERN-OHL-S-2.0 status and missing upstream evidence as the robot. |

The source project names above preserve the provenance recorded when the assets were added in [#59](https://github.com/caid-technologies/OpenIndustries/pull/59), before the Form/Mergence display rename. The repository does not include original STEP files, source project URLs, or upstream license texts for independent verification. The license field records the existing declaration; it does not establish a new permission grant or claim that these files are public domain. Keep source identities, digest records, and notices with any permitted reuse. The fixture work adds no new third-party geometry.

## Reproduce the example

Regenerate the bundled architectural geometry and robot timeline with `node --import tsx scripts/build-cleanroom-example.mjs`. This reuses the existing tessellated robot/desk; it does not fetch or rebuild their original STEP sources. Update the provenance manifest if a source digest changes.

The route maps one animation second to one scheduled minute starting at 09:00. Samples occur in A at 5/10 seconds and C at 65/70 seconds. Room B has no proposed sample times and the animated robot stays outside its footprint. This is an illustrative schedule, not live occupancy sensing or operational authorization.

Use the [cross-agent walkthrough](../../../docs/mcp-agent-workflows.md) to create this scene through typed MCP calls, open its returned revision URL, revise it, and reopen a pinned original. The bundled `/?scene=cleanroom` route and the MCP workflow are separate entry points; neither becomes the default workspace.
