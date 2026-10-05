import { canonicalJSON, readManifest } from './workspace';
import type { SavedScene } from './scene-repository';

export type ChangeCounts = { added: number; removed: number; changed: number };
export type RevisionSummary = { baseline: boolean; name_changed: boolean; room_changed: boolean; animation_changed: boolean; instances: ChangeCounts; assets: ChangeCounts };
export type SceneRevision = { revision: number; parent_revision: number | null; created_at: string; author_id: string | null; author_source: string; author_agent: string | null; restored_from_revision: number | null; change_summary: RevisionSummary };
export type SceneHistoryPage = { scene_id: string; head_revision: number; revisions: SceneRevision[]; next_before: number | null };
export type RevisionChange = { section: string; target: string; field: string; before: string; after: string };
export type RevisionComparison = { from_revision: number; to_revision: number; changes: RevisionChange[]; total_changes: number };

export class SceneConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`Scene changed on another device. Current revision: ${currentRevision}. Refresh history, compare your changes, and retry from the current revision.`);
    this.name = 'SceneConflictError';
  }
}
export function sceneRPCError(error: { message: string; code?: string; details?: string }) {
  if (error.code === '40001') {
    try { const detail = JSON.parse(error.details ?? '{}'); if (Number.isInteger(detail.current_revision)) return new SceneConflictError(detail.current_revision); } catch { /* Use the safe existing message below. */ }
  }
  return new Error(error.message);
}
export function describeRevision(revision: SceneRevision): string {
  const s = revision.change_summary;
  if (s.baseline) return `${revision.revision === 1 ? 'Created scene' : 'First recorded snapshot'} · ${s.instances.added} instances`;
  const changes: string[] = [];
  if (revision.restored_from_revision) changes.push(`Restored revision ${revision.restored_from_revision}`);
  if (s.name_changed) changes.push('Renamed scene');
  if (s.room_changed) changes.push('Room dimensions changed');
  for (const [kind, counts] of [['instances', s.instances], ['assets', s.assets]] as const) {
    for (const [action, count] of Object.entries(counts)) if (count) changes.push(`${count} ${kind} ${action}`);
  }
  if (s.animation_changed) changes.push('Animation changed');
  return changes.join(' · ') || 'No layout changes';
}

/** Diff only known scene fields; never stringify arbitrary documents or provider data. */
export function compareSceneRevisions(before: SavedScene, after: SavedScene, limit = 200): RevisionComparison {
  const a = readManifest(before.document), b = readManifest(after.document);
  const changes: RevisionChange[] = []; let total = 0;
  const text = (value: unknown) => value === undefined ? '—' : Array.isArray(value) ? value.join(', ') : String(value);
  const add = (section: string, target: string, field: string, left: unknown, right: unknown) => {
    if (canonicalJSON(left) === canonicalJSON(right)) return;
    total++;
    if (changes.length < limit) changes.push({ section, target, field, before: text(left), after: text(right) });
  };
  add('Scene', 'Scene', 'Name', before.name, after.name);
  for (const [i, field] of ['Width (m)', 'Depth (m)', 'Height (m)'].entries()) add('Scene', 'Room', field, a.room[i], b.room[i]);
  const ai = new Map(a.instances.map(item => [item.id, item])), bi = new Map(b.instances.map(item => [item.id, item]));
  for (const id of new Set([...ai.keys(), ...bi.keys()])) {
    const left = ai.get(id), right = bi.get(id), target = `${right?.name ?? left!.name} (${id})`;
    if (!left || !right) { add('Instance', target, 'Presence', left ? 'Present' : undefined, right ? 'Present' : undefined); continue; }
    for (const [field, key] of [['Name','name'],['Position (m)','position'],['Rotation (°)','rotation'],['Visible','visible'],['Asset ID','assetId'],['Cloud file version','cloudVersionId']] as const) add('Instance', target, field, left[key], right[key]);
  }
  const aa = new Map(a.assets.map(asset => [asset.id, asset])), ba = new Map(b.assets.map(asset => [asset.id, asset]));
  for (const id of new Set([...aa.keys(), ...ba.keys()])) {
    const left = aa.get(id), right = ba.get(id), target = `${right?.name ?? left!.name} (${id})`;
    if (!left || !right) { add('Asset', target, 'Presence', left ? 'Present' : undefined, right ? 'Present' : undefined); continue; }
    add('Asset', target, 'Dimensions (m)', left.dimensions, right.dimensions);
    add('Asset', target, 'Project revision', left.projectRevision, right.projectRevision);
    for (const key of ['kind','filename','digest','projectId','version'] as const) add('Asset', target, `Source ${key}`, left.source[key], right.source[key]);
  }
  add('Animation', 'Timeline', 'Duration (s)', a.animation.duration, b.animation.duration);
  add('Animation', 'Timeline', 'Loop', a.animation.loop, b.animation.loop);
  const at = new Map(a.animation.tracks.map(track => [track.id, track])), bt = new Map(b.animation.tracks.map(track => [track.id, track]));
  for (const id of new Set([...at.keys(), ...bt.keys()])) {
    const left = at.get(id), right = bt.get(id);
    if (!left || !right) { add('Animation', id, 'Track', left ? `${left.keys.length} keys` : undefined, right ? `${right.keys.length} keys` : undefined); continue; }
    const ak = new Map(left.keys.map(key => [key.time, key])), bk = new Map(right.keys.map(key => [key.time, key]));
    for (const time of [...new Set([...ak.keys(), ...bk.keys()])].sort((x,y) => x-y)) {
      add('Animation', id, `Position at ${time}s (m)`, ak.get(time)?.position, bk.get(time)?.position);
      add('Animation', id, `Rotation at ${time}s (°)`, ak.get(time)?.rotation, bk.get(time)?.rotation);
      add('Animation', id, `Visible at ${time}s`, ak.get(time)?.visible, bk.get(time)?.visible);
    }
  }
  return { from_revision: before.revision, to_revision: after.revision, changes, total_changes: total };
}
