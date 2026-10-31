"""Install a reviewed checkout as a local systemd FIELD-LAB service (Linux, root)."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time

from runtime_health import check_health


def run(*args: str, cwd: Path | None = None) -> str:
    """Run a checked command without shell interpolation."""
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def install(source: Path) -> None:
    """Copy an immutable release, initialize once, and enable supervised local execution."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Run with sudo on Linux with systemd as PID 1')
    if Path('/proc/1/comm').read_text().strip() != 'systemd':
        raise ValueError('systemd is not PID 1; see WSL2 instructions in docs/persistent-runtime.md')
    source = source.resolve(strict=True)
    revision = run('git', 'rev-parse', 'HEAD', cwd=source)
    if run('git', 'status', '--porcelain', '--untracked-files=no', cwd=source):
        raise ValueError('Commit or discard tracked edits before installing a pinned release')
    if not (source / 'dist-field-lab/benchmarks/field-lab/runtime.html').is_file():
        raise ValueError('Run npm ci and npm run build:local-runtime first')
    node = next((Path(p) for p in ('/usr/local/bin/node', '/usr/bin/node') if Path(p).is_file()), None)
    if node is None:
        raise ValueError('Install Node 22.16+ in /usr/bin or /usr/local/bin (not a home-directory nvm installation)')
    major, minor, *_ = map(int, run(str(node), '--version').lstrip('v').split('.'))
    if major < 22 or (major == 22 and minor < 16):
        raise ValueError('Node 22.16+ is required')
    try:
        account = pwd.getpwnam('oi-runtime')
    except KeyError:
        run('useradd', '--system', '--home-dir', '/var/lib/open-industries', '--shell', '/usr/sbin/nologin', 'oi-runtime')
        account = pwd.getpwnam('oi-runtime')
    release = Path('/opt/open-industries/local-releases') / revision
    if release.exists():
        if not (release / 'RELEASE').is_file() or (release / 'RELEASE').read_text().strip() != revision:
            raise ValueError(f'Incomplete release: {release}; inspect it before retrying')
    else:
        release.mkdir(parents=True, mode=0o755)
        try:
            names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=source).decode().split('\0')
            for name in filter(None, names):
                target = release / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / name, target)
            for name in ('node_modules', 'dist-field-lab'):
                shutil.copytree(source / name, release / name, symlinks=True)
            (release / 'RELEASE').write_text(revision + '\n')
        except BaseException:
            shutil.rmtree(release)
            raise
    state = Path('/var/lib/open-industries/local-lab')
    if not state.exists():
        state.mkdir(parents=True, mode=0o700)
        os.chown(state, account.pw_uid, account.pw_gid)
        # Parent permits the unprivileged runtime to reach its private station.
        os.chown(state.parent, account.pw_uid, account.pw_gid)
        run('runuser', '-u', 'oi-runtime', '--', 'env', 'FIELD_LAB_INSTALLED=true',
            f'FIELD_LAB_VIEWER_STATE_DIR={state}', str(node), '--import', 'tsx',
            'scripts/field-lab-viewer.ts', '--init-only', cwd=release)
    elif not (state / 'operator.json').is_file() or not (state / 'lab.sqlite').is_file():
        raise ValueError('Existing local state is incomplete; restore it before installing')
    current = Path('/opt/open-industries/local-current')
    temporary = current.with_name('local-current.next')
    temporary.symlink_to(release, target_is_directory=True)
    temporary.replace(current)
    shutil.copyfile(release / 'deploy/local-runtime/oi-local.service', '/etc/systemd/system/oi-local.service')
    journal = Path('/etc/systemd/journald@oi-local.conf.d')
    journal.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(release / 'deploy/runtime/journald.conf', journal / 'limits.conf')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'oi-local.service')
    run('systemctl', 'restart', 'oi-local.service')
    for _ in range(60):
        if check_health('http://127.0.0.1:4193'):
            break
        time.sleep(0.5)
    else:
        raise ValueError('Service did not become ready; inspect systemctl status oi-local and journalctl --namespace=oi-local -u oi-local')
    print('Local station installed: http://127.0.0.1:4193/\nState: ' + str(state))
    print('Check readiness: python3 scripts/runtime_health.py http://127.0.0.1:4193')


def main() -> int:
    """Install only the explicitly selected source; require a real systemd host."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path.cwd())
    args = parser.parse_args()
    os.umask(0o022)
    try:
        install(args.source)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Local install failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
