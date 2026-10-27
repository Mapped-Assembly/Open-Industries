# Observed AWS inspection station

Captured **2026-10-27 UTC** on EC2 `i-0fc59dacd62a60f0a`, `us-east-1a`,
`t3.small`, Canonical Ubuntu 24.04 AMI `ami-0d6dd9e8265d48906`.
Application commit **`63ed09bb2500260fbb3936ac8557fd5334eed08a`**, clean checkout.
Python **3.12.3**, Node **22.23.4**, OpenCV **5.0.0** (distribution **5.0.0.93**).

**Synthetic camera; simulated robot movement; deterministic MCP verification.
No LLM was invoked by the recorder.** Infrastructure provisioning used the official
AWS MCP server with browser OAuth. The recorder used the installed systemd stdio
MCP wrapper, invoked over authenticated SSH. AWS identity came from IMDSv2.

## Observed results

| Check | Evidence |
| --- | --- |
| Hidden marker → `needs_review`, `TARGET_NOT_OBSERVED`, no command/job | `exercise.json`, `tool-trace.json` |
| Visible marker → one authorized survey completed, changed robot position and pixels | `exercise.json`, before/after images |
| Same UUID retries preserve terminal records and exactly one runtime job | `exercise.json` |
| Agent disconnect during accepted job, reconnect to same intent/job | `tool-trace.json`, `exercise.json` |
| systemd service restart preserves identities, credentials, ports, checkpoints and images | `verified-restart.json` |
| Actual EC2 reboot, changed boot ID, same station and evidence | `verified-reboot.json` |
| SIGKILL launcher → automatic systemd recovery; old launcher and worker gone | `verified-crash-recovery.json` |
| Complete offline backup and restore of all state; original quarantined | `verified-restore.json` |

| Before simulated survey | After completion |
| --- | --- |
| ![Synthetic image before movement](before.jpg) | ![Synthetic image after movement](after.jpg) |

`checksums.json` records SHA-256 for each original exported artifact. Source PNG hashes
and MCP JPEG preview hashes are recorded separately. Private station configuration,
credentials and backups were not exported. Backups remain private on the host; an
off-host backup retention policy remains an operator responsibility.

## Findings and corrections

1. Initial cloud-init failed because the installer PATH excluded `/usr/sbin` and
   could not locate `visudo`. Fixed in `97b6459`; installation was rerun in place.
   The historical cloud-init failure remains in its logs; subsequent installation
   and running services were directly verified.
2. Root-run recording replaced the marker file with root ownership, denying the
   service access. Fixed in `63ed09b`: atomic private writes inherit directory
   ownership when executed by root. Marker ownership was verified as
   `oi-station`, mode 0600 after the successful run.
3. A reboot check reached the machine before the systemd startup job completed.
   Retrying after active readiness passed. The updated `record.sh` joins the
   service start job before invoking the wrapper.
4. Standard CPU credits were insufficient on the new instance. Empty credit
   balance and substantial CPU steal were observed. Acceptance ran in **Unlimited**
   mode. A short idle sample measured 25–32% aggregate CPU, above the 20% baseline.
   The provisioning template now exposes `CpuCredits`, defaulting to Unlimited.

## Cost and current access

Base infrastructure is about **$21.24/730-hour month**. Linux T3 Unlimited surplus
CPU adds **$0.05/vCPU-hour**; the short idle sample suggests about **$25–30/month**
total if sustained. Active inspections consume more CPU. This is not a long-duration
billing measurement. Sustained full CPU can raise the total to about **$79.64/month**,
excluding transfer, backups, tax and model usage.

AWS reported **$100 remaining credits**, an **ACTIVE FREE** plan and plan expiration
**2027-04-16**. These are gross usage estimates before eligible credits. The instance
remains running in Unlimited mode; retained EBS remains billable after stop/termination.

On the deployment workstation:

```bash
ssh oi-inspection
ssh -T oi-inspection sudo -n /usr/local/bin/oi-station-mcp
```

The alias uses a dedicated key outside Git and a host key checked against authenticated
EC2 console output. Public IP at recording: `100.52.194.24`. The retained root volume is
`vol-095bc714cfb81f0dc`; stack name is `oi-inspection`. The CloudFormation stack initially
used `4a2d440`, followed by fixed-path upgrades to the recorded commit. Its original
Release output and credit setting therefore do not describe the later in-place
updates; use the recorded checkout and actual EC2 credit specification as authority.

The deployed runtime remains pinned to the recorded commit. Later PR changes add
the recording readiness guard, configurable credit mode and this evidence; they do
not change the observed runtime result. See [operations and teardown](../../aws-inspection-station.md).

## Checks

- Full vision/MCP suite: **31 tests passed** after the ownership fix.
- `npm run test:mcp`: passed.
- Updated deployment checks: **5 passed**.
- CloudFormation cfn-lint 1.58.0, shell syntax and `git diff --check`: passed.
