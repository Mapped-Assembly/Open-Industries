import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { FieldLabDatabase } from './simulation/field-lab-runtime.js';
import type { LabRecording, LabSnapshot, LabFrame } from '../src/lib/field-lab-playback.js';

/** Export authorized history at one fixed head, including its compacted checkpoint. */
export function recordLab(db: FieldLabDatabase, token: string, instanceId: string, sourceRevision: string, assetDirectory?: string): LabRecording {
  const asset = (name: string): URL | string => assetDirectory ? resolve(assetDirectory, name) : new URL(`../benchmarks/field-lab/fixtures/${name}`, import.meta.url);
  let cursor: string | null = null;
  const frames: LabFrame[] = [];
  do {
    const page = db.sceneHistoryPage(token, { instance_id: instanceId, cursor, limit: 64 }) as {
      checkpoint: LabSnapshot; events: LabFrame[]; next_cursor: string | null;
    };
    if (!frames.length) frames.push({ id: `checkpoint:${instanceId}:${page.checkpoint.revision}`, action: 'retained-checkpoint', snapshot: page.checkpoint });
    frames.push(...page.events);
    cursor = page.next_cursor;
  } while (cursor);
  return {
    schema: 'oi.field-lab-recording/v1', source_revision: sourceRevision,
    source_form_sha256: createHash('sha256').update(readFileSync(asset('field-lab-pipette.form.json'), 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
    scene_json: readFileSync(asset('field-lab.oi.json'), 'utf8'),
    motion_json: readFileSync(asset('pipette-motion.json'), 'utf8'),
    frames, cursor: frames.length - 1,
    history_scope: 'Retained authoritative post-state events plus checkpoint. Earlier compacted history is unavailable; frames hold until the next recorded event.',
  };
}
