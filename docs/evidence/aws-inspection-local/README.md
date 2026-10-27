# Local inspection-station verification — not AWS evidence

Captured on **2026-10-27 UTC** against clean application commit
`b61fa7485e0dc16745eaa6454dd410dacde9ecba` using Python 3.12.3, Node 22.23.4 and
OpenCV 5.0.0 (`opencv-python-headless==5.0.0.93`). These files were produced by
`oi_vision.station_evidence` through the launcher's exported stdio MCP command,
with separate real game, camera and vision services. No LLM was invoked.

**Camera: synthetic. Movement: simulated. AWS instance/region: not applicable to
this run. EC2/systemd recovery and host reboot: not performed.** The cloud plan
selects `us-east-1`, but that is not the location of this observed run.

| Observed check | Result |
| --- | --- |
| Live scheduler, OpenCV API and camera | Passed |
| Marker hidden | `needs_review`, `TARGET_NOT_OBSERVED`, two zero-detection observations, no robot command/job |
| Marker visible | One authorized `survey_robot` job completed; changed robot position and follow-up pixels |
| Same run UUID retries | Same terminal review/action checkpoint, exactly one runtime job |
| Agent disconnect after accepted command | Services stayed healthy; reconnect retained the command/job and completed the inspection |
| Graceful launcher restart | Same match, robot, ports, credential identity, observations and inspection records |
| Complete offline backup/restore | All three stores and private configuration restored; same checkpoints and images verified |

## Files

- [exercise.json](exercise.json): actual versions, commit, timestamps, health, review
  and action records, verification booleans, preview/source image hashes.
- [tool-trace.json](tool-trace.json): sanitized deterministic MCP calls and connection events.
- [verified-restart.json](verified-restart.json): observed local launcher restart, not a systemd restart.
- [verified-restore.json](verified-restore.json): observed complete offline state restore.
- [checksums.json](checksums.json): SHA-256 of the six original exported artifacts.
- [verification.json](verification.json): 31-test suite, MCP, dependency-install and
  deployment-syntax results, plus explicit cloud/model blockers.

| Before authorized simulated survey | After runtime completion |
| --- | --- |
| ![Synthetic camera before simulated movement](before.jpg) | ![Synthetic camera after simulated movement](after.jpg) |

These JPEGs are the actual MCP image previews, with their own hashes. The separately
recorded PNG hashes identify the source evidence retained in the private observation
store. The white robot moves; the yellow marker gates a configured survey, not a
camera-coordinate motion plan.

Only allowlisted public evidence files were exported. The private state and backup
contain credentials and were not committed. The identity digest compares generated
high-entropy credentials and bindings without disclosing them; expiring sessions are
excluded. Local absolute paths, loopback ports, boot ID and process IDs are provenance,
not remotely reachable service credentials.

For a real AWS submission, run the [deployment and recording procedure](../../aws-inspection-station.md).
It must produce **new** IMDSv2-backed instance metadata, real systemd recovery results
and `verified-reboot.json`; these local files cannot substitute for those observations.
