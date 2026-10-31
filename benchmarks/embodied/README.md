# Pinned SO-101 tabletop fixture

`robot-contract.json` and `source-lock.json` are reused unchanged from
[the verified shared model contract](https://github.com/isayahc/Real-Time-Video-Agents-Hack-NYC/tree/c534e42d83c87324285c803fc11883d8479abb90/examples/so101-robot).
That project's importer/contract is MPL-2.0. The upstream geometry is Apache-2.0;
its license is retained in `UPSTREAM-LICENSE`.

Upstream: TheRobotStudio/SO-ARM100, commit
`a758567c3978dfeefe282ede0500085a48fe8f78`,
`Simulation/SO101/so101_new_calib.urdf`. The service validates every pinned URDF,
mesh, README and license byte before startup. Assets are served from that verified
checkout; the browser renders the actual STL meshes, not stand-in links.

The shared contract defines SI metres/radians, right-handed Z-up, exact source
joint origins/axes/limits, reference pose and TCP. The controller composes those
matrices; the viewer converts `(x,y,z)` to OI `(x,z,-y)` and restores import origin
offsets. The source q=0 pose is a model reference, not measured physical home.
No payload, actuator performance, friction, mass/contact solver or physical
calibration is inferred from the source geometry.

This milestone's authored fixture is two 30 mm cubes and a marked 80 mm square.
Initial block centres are `[.15,-.05,.015]` and `[.17,.05,.015]` metres; the mark is
`[.24,0,.002]`. Explicit Edit mode permits block centre X in `[.05,.35]`, Y in
`[-.15,.15]`, Z fixed at `.015`, with at least 50 mm centre separation. Every edit
increments the saved scene revision. Active tasks freeze editing.

## Version 1 skills

| Skill | Input / precondition | Execution and evidence |
| --- | --- | --- |
| `inspect` | Grounded block ID | Retain privileged simulated-state observation; no camera claim |
| `approach` | Grounded block ID, stationary target, current scene revision | Position-only IK places TCP 100 mm above the block; five arm joints move, gripper angle retained; final TCP error ≤3 mm |
| `home` | No object target; no active task | Move to declared q=0 model reference; joint-error check ≤0.003 rad |

Every proposal is checked outside the model. Named/selected target disagreement,
missing/ambiguous reference, unknown skill, moved target, joint-limit violation or
unreachable goal produces review/refusal. IK uses three deterministic seeds with
at most 100 evaluations each. Joint interpolation is limited to 0.35 rad/s with a
minimum two-second duration; the gripper is not actuated. TCP samples at 64 points
reject table penetration or proximity within 35 mm of block centres. This is a
**limited TCP proxy check**, not swept-link collision checking, self-collision
checking, dynamics, grasping or contact verification.

Stop freezes persisted joint pose synchronously, invalidating late policy results.
Resume re-observes and checks the scene pin, continuing the same task/command IDs.
Cancel preserves the current pose and permits a new goal. No object is attached,
held, released or teleported by any skill. Process recovery pauses active tasks;
no simulation motion is inferred from downtime. Pick/place and contact outcomes
remain #54 Milestone B and must not be presented as completed by this fixture.
