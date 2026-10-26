import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FieldLabDatabase } from '../server/simulation/field-lab-runtime.js';
import { labDayMs } from '../server/domains/field-lab.js';
import { validateLabRecording } from '../src/lib/field-lab-playback.js';
import type { LabSceneFrame, LabSceneSnapshot } from '../src/lib/field-lab-playback.js';

/** Record authorized post-state events before bounded server history can compact them. */
async function main(): Promise<void> {
  const output = resolve(process.argv[2] ?? 'deliverables/field-lab');
  const temporary = await mkdtemp(join(tmpdir(), 'oi-lab-recording-'));
  let now = 1000;
  const db = new FieldLabDatabase(join(temporary, 'lab.sqlite'), { clock: () => now });
  // This private fixture DB retains one event: the recorder consumes each head before
  // the next tick. Production retention remains unchanged; cutover is exercised each minute.
  db.history.maxEvents = 1;
  try {
    const { token } = await db.authenticate({ username: 'scene-recorder', password: 'local-recording-fixture' }, true);
    const cases = ['baseline', 'combined', 'resilience'].map((scenario) => {
      const result = db.create(token, { command_id: `record-${scenario}`, scenario, dispatch: 'automatic' });
      return { scenario, id: (result.snapshot as unknown as LabSceneSnapshot).instance_id, frames: [] as LabSceneFrame[] };
    });
    for (let elapsed = 0; elapsed <= labDayMs; elapsed += 60000) {
      now = 1000 + elapsed;
      db.tick();
      if (elapsed % 3600000 === 0) console.log(`Recording hour ${elapsed / 3600000}/8`);
      for (const item of cases) {
        const page = db.sceneHistoryPage(token, { instance_id: item.id, cursor: null, limit: 64 }) as {
          events: LabSceneFrame[]; next_cursor: string | null;
        };
        if (page.next_cursor) throw new Error('INCOMPLETE_RECORDING_HISTORY');
        const event = page.events.at(-1);
        if (!event) throw new Error('MISSING_RECORDED_EVENT');
        if (event.event_id !== item.frames.at(-1)?.event_id) item.frames.push(event);
      }
    }
    for (const item of cases) validateLabRecording(item.frames, item.frames[0].scene_sha256);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'field-lab-recording.json'), JSON.stringify({
      schema: 'field-lab-scene-recording/v1', sampling_ms: 60000,
      scope: 'Recorded modeled job progress. Kinematic-only; no physical verification or interpolation.',
      cases,
    }));
    console.log('Recorded three durable lab days at one-minute checkpoints.');
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
await main();
