# Local runtime verification

Implementation based on main `44eccbf4138f628f4319a4a55d5dd682e3a74160` (merged #65).
The containing PR/commit identifies the exact changed source; no cloud deployment was used.

Environment: Ubuntu 24.04.3 container, Linux 6.18.57, Node v24.22.1, Python 3.12.14.
PID 1 is supervisord, not systemd. Chromium uses local SwiftShader software rendering.

Reproduce software checks from the checkout:

```bash
npm ci
npm run test:local-runtime
# Include real built-page WebGL connect/disconnect/reconnect checks:
OI_TEST_BROWSER=true npm run test:local-runtime
# Or set ASTRA_CHROME_PATH to an existing Chromium executable.
npm run test:simulation
npm run test:field-lab
npm run test:field-lab-scene
npm run test:field-lab-scene-browser
npm run build
python3 -m py_compile scripts/install_local_runtime.py scripts/local_runtime_backup.py
systemd-analyze verify deploy/local-runtime/oi-local.service
```

Local results: **113/113 simulation tests passed**, including the station lifecycle test;
six complete durable FIELD-LAB scenarios passed; scene playback and both the built
viewer and foreground viewer browser checks passed; application build, Python syntax
checks and systemd unit validation passed. The actual systemd install/restart CI result
and host reboot results are not claimed here.

The local integration test launches the shipped static HTTP entrypoint in a child
process with stdin disconnected. It verifies persistent progress without clients,
authentication/origin denial, absence of development source routes, command receipt
replay after SIGKILL, session renewal, real MCP stdio retrieval of the same instance,
built viewer reconnect, online backup and isolated complete restore, jobs/resources
preserved through compatible process restart, nonzero worker-failure exit, and refusal
to replace incomplete state. Existing runtime tests cover cross-account ACLs, transactional
resource spending/output deduplication, immutable receipts and unsupported saves.

The compatible-restart test reuses the same source build; it does not prove compatibility
with an unknown future version. No physical action is inferred from these simulated jobs.

The `Local persistent runtime` GitHub Actions workflow installs the actual systemd unit
on Ubuntu 24.04 with Node 22, checks enablement/readiness, kills its main PID and verifies
automatic restart and preserved identity/progress. Consult the PR checks for its result;
this container cannot execute that host-level test. The optional remote-host/Caddy test
remains separate and is not a prerequisite for local use.

**Still requires real host evidence:** closing the installation terminal under systemd,
a Linux machine reboot, WSL distro shutdown/relaunch, and a Windows reboot (including
whether Windows automatically starts the distro). No WSL/Windows/native macOS service
lifecycle result is claimed. Follow the checklist in `docs/persistent-runtime.md` and
record OS, runtime versions, release SHA, before/after identity and receipts, PID/startup
state and health/log outcomes. Keep #52 open for this evidence; AWS is not a gate.
