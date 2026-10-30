import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FieldLabDatabase } from '../../server/simulation/field-lab-runtime.js';
import { projectLabScene, sampleLabRecording, validateLabRecording } from '../../src/lib/field-lab-playback.js';
import type { LabSceneFrame, LabSceneSnapshot } from '../../src/lib/field-lab-playback.js';
import { advanceLab, createLab, projectLab, labDayMs } from '../../server/domains/field-lab.js';

test('shortage retains completed endpoint while waiting jobs do not invent completions', () => {
  const lab = createLab('shortage-lab', 'operator', 'combined', 1000);
  const blocked = advanceLab(lab, 1000 + 240 * 60000);
  const frame = projectLabScene(projectLab(blocked) as unknown as LabSceneSnapshot, 'blocked-event');
  assert.equal(frame.processed, 12);
  assert.equal(frame.pose_fraction, 1, 'a completed cycle must not wrap to its start');
  assert(frame.waiting_reasons.length > 0);
  const end = advanceLab(blocked, 1000 + labDayMs);
  const final = projectLabScene(projectLab(end) as unknown as LabSceneSnapshot, 'final-event');
  assert.equal(final.processed, 12);
  assert.equal(final.pose_fraction, frame.pose_fraction);
  assert.equal(final.job?.id, frame.job?.id);
});

test('recorded scene holds paused/failed progress across restart, retry and JSON round-trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-scene-test-'));
  const path = join(directory, 'lab.sqlite');
  let now = 1000;
  let db = new FieldLabDatabase(path, { clock: () => now });
  try {
    let { token } = await db.authenticate({ username: 'scene-operator', password: 'test-scene-password' }, true);
    const created = db.create(token, { command_id: 'create', scenario: 'baseline', dispatch: 'automatic' });
    const id = (created.snapshot as unknown as LabSceneSnapshot).instance_id;
    /** Read only the service's authorized event projection, as a reconnecting recorder does. */
    const latest = (): LabSceneFrame => {
      const page = db.historyPage(token, { instance_id: id, cursor: null, limit: 64 }) as {
        events: { id: string; snapshot: LabSceneSnapshot }[];
      };
      const event = page.events.at(-1)!;
      return projectLabScene(event.snapshot, event.id);
    };
    /** Submit a control with the current authoritative revision. */
    const command = (action: string) => ({
      command_id: action, instance_id: id, expected_revision: db.read(token, id).revision,
      action, payload: { job_id: 'sample-1' },
    });
    const initial = latest();
    const compact = db.sceneHistoryPage(token, { instance_id: id, cursor: null, limit: 64 }) as { events: LabSceneFrame[] };
    assert.deepEqual(compact.events.at(-1), initial);
    const other = await db.authenticate({ username: 'other-operator', password: 'test-other-password' }, true);
    assert.throws(() => db.sceneHistoryPage(other.token, { instance_id: id, cursor: null, limit: 64 }));
    assert(initial.stock.batteryWh > 0);
    now += 300000; db.tick();
    const running = latest();
    assert.equal(running.job?.state, 'running');
    assert.equal(running.pose_fraction, 1 / 3);
    const pause = command('pause');
    const receipt = db.execute(token, pause);
    const paused = latest();
    assert.equal(paused.job?.state, 'paused');
    now += 120000; db.tick();
    const held = latest();
    assert.equal(held.pose_fraction, running.pose_fraction);
    db.close(); db = new FieldLabDatabase(path, { clock: () => now });
    ({ token } = await db.authenticate({ username: 'scene-operator', password: 'test-scene-password' }));
    assert.deepEqual(latest(), held);
    assert.deepEqual(db.execute(token, pause), receipt);
    assert.deepEqual(latest(), held, 'receipt replay must not append another event');
    db.execute(token, command('resume'));
    now += 60000; db.tick();
    const resumed = latest();
    assert.equal(resumed.job?.progress_ms, 360000);
    db.execute(token, command('fail'));
    const failed = latest();
    now += 60000; db.tick();
    const afterFailure = latest();
    assert.equal(afterFailure.pose_fraction, resumed.pose_fraction);
    assert.equal(afterFailure.job?.state, 'failed');
    assert.equal(afterFailure.job?.reason, 'modeled-instrument-fault');
    assert.equal(afterFailure.processed, 0);
    const frames = [initial, running, paused, held, resumed, failed, afterFailure];
    validateLabRecording(frames, initial.scene_sha256);
    const imported = JSON.parse(JSON.stringify(frames)) as LabSceneFrame[];
    validateLabRecording(imported, initial.scene_sha256);
    assert.deepEqual(sampleLabRecording(imported, held.elapsed_ms), held);
    assert.deepEqual(sampleLabRecording(imported, 99999999), afterFailure);
    assert.throws(() => validateLabRecording(imported, '0'.repeat(64)), /STALE/);
    assert.throws(() => validateLabRecording([...frames, afterFailure], initial.scene_sha256));
    assert.throws(() => sampleLabRecording(imported, -1));
  } finally {
    db.close(); await rm(directory, { recursive: true, force: true });
  }
});
