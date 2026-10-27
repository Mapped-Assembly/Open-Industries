# Combined farm demo rehearsal

The combined screen was exercised against the existing AWS farm through
`http://127.0.0.1:8795` on 2026-10-27 using Playwright Chromium.
Deployed application: `5dbe355`.

Passed: New run, Start harvest, Pause, browser reload while paused, Resume,
seven completed segments, all three deposits, six loaded before/after images,
and preservation of the original model-issued run in history. No browser page
errors occurred. `browser-run.json` records the observed final state, jobs,
frame metadata and history; `viewer-complete.png` shows the completed screen.

These buttons run a deterministic controller, not an LLM. Images and movement
are simulated. The separate [model-issued run](../farm-agent-aws/README.md)
remains preserved. Six focused farm tests also passed, covering actual MuJoCo
pixels, stale/absent evidence, authorization, restart, reset preservation and
idempotent controls.

## Present it

1. Open **http://127.0.0.1:8795** on the workstation with the SSH tunnel.
2. Click **New run**, then **Start harvest**.
3. Show **Pause / Resume**, the live robot, and before/after pickup images.
4. After about 80 seconds, show **Box 3/3** and the return home.

If the tunnel has closed: `ssh -N -L 8795:127.0.0.1:8794 oi-inspection`.
Prior runs are retained; the completed rehearsal is ready for another New run.
