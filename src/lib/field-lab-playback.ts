import type { Vec3 } from './scene';
import { digestBytes } from './scene';
import { evaluateWorkspace, hydrateManifest, readManifest, type Workspace, type EvaluatedPose } from './workspace';

export interface LabJob {
  id: string;
  state: string;
  reason: string | null;
  progress_ms: number;
  checkpoint: { started: boolean; pipette_id: string; instrument_id: string; phase: string };
}
export interface LabSnapshot {
  instance_id: string;
  revision: number;
  simulation_time_ms: number;
  origin_ms: number;
  recipe: { duration_ms: number };
  bindings: { id: string; data: { scene_sha256: string; scene_instance_id: string } }[];
  jobs: LabJob[];
}
export interface LabFrame {
  id: string;
  action: string;
  snapshot: LabSnapshot;
}
export interface MotionHandoff {
  schema: 'oi.opencad-motion/v1';
  occurrence_id: string;
  source_scene_sha256: string;
  source_form_sha256: string;
  opencad_revision: string;
  duration_s: number;
  component_ids: Record<string, string>;
  samples: { time_s: number; offsets_m: Record<string, Vec3> }[];
  checks: { motion: { status: string }; unsupported: string[]; scope: string };
}
export interface LabRecording {
  schema: 'oi.field-lab-recording/v1';
  scene_json: string;
  motion_json: string;
  source_revision: string;
  source_form_sha256: string;
  frames: LabFrame[];
  cursor: number;
  history_scope: string;
}
export interface LoadedLab {
  recording: LabRecording;
  workspace: Workspace;
  motion: MotionHandoff | null;
  finding: string;
  scene_sha256: string;
}

/** Match the runtime's canonical source hash, independently of object key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
/** Hash source text in browsers and Node using LF newlines without changing number spelling. */
export async function hashText(text: string): Promise<string> {
  return digestBytes(new TextEncoder().encode(text.replace(/\r\n/g, '\n')).buffer as ArrayBuffer);
}
/** Validate a portable recording; stale mechanics retain renderable, explicitly unchecked geometry. */
export async function loadLabRecording(value: unknown): Promise<LoadedLab> {
  const r = value as LabRecording;
  if (!r || r.schema !== 'oi.field-lab-recording/v1' || typeof r.scene_json !== 'string'
    || r.scene_json.length > 25 * 1024 * 1024 || typeof r.motion_json !== 'string'
    || r.motion_json.length > 2 * 1024 * 1024 || typeof r.source_revision !== 'string'
    || !Array.isArray(r.frames) || !r.frames.length || r.frames.length > 10000
    || !Number.isInteger(r.cursor) || r.cursor < 0 || r.cursor >= r.frames.length) throw Error('Invalid lab recording');
  const raw = JSON.parse(r.scene_json), workspace = hydrateManifest(readManifest(raw), []);
  const sceneHash = await hashText(r.scene_json), canonicalHash = await hashText(canonical(raw));
  const ids = new Set<string>();
  let previous = -1, previousRevision = -1, instance = '';
  const progress = new Map<string, number>();
  for (const frame of r.frames) {
    const s = frame.snapshot;
    if (!frame.id || ids.has(frame.id) || typeof frame.action !== 'string' || !s
      || typeof s.instance_id !== 'string' || (instance && instance !== s.instance_id)
      || !Number.isSafeInteger(s.simulation_time_ms) || s.simulation_time_ms < previous
      || !Number.isSafeInteger(s.revision) || s.revision < previousRevision
      || !Number.isSafeInteger(s.origin_ms) || !s.recipe || s.recipe.duration_ms !== 900000
      || !Array.isArray(s.jobs) || s.jobs.length !== 24 || new Set(s.jobs.map(j => j.id)).size !== 24
      || !Array.isArray(s.bindings)) throw Error('Invalid or unordered lab event timeline');
    ids.add(frame.id); instance = s.instance_id; previous = s.simulation_time_ms; previousRevision = s.revision;
    for (const j of s.jobs) {
      if (!/^sample-([1-9]|1[0-9]|2[0-4])$/.test(j.id)
        || !['queued', 'waiting-for-resource', 'running', 'paused', 'failed', 'cancelled', 'completed'].includes(j.state)
        || !Number.isSafeInteger(j.progress_ms) || j.progress_ms < (progress.get(j.id) ?? 0)
        || j.progress_ms > s.recipe.duration_ms || !j.checkpoint
        || j.checkpoint.pipette_id !== 'pipette' || j.checkpoint.instrument_id !== 'instruments'
        || typeof j.checkpoint.started !== 'boolean'
        || (!j.checkpoint.started && j.progress_ms !== 0)
        || (j.state === 'completed' && j.progress_ms !== s.recipe.duration_ms)) throw Error('Invalid job progress');
      progress.set(j.id, j.progress_ms);
    }
  }
  let motion: MotionHandoff | null = null;
  let finding = 'Kinematic-only: motion handoff unavailable';
  if (r.motion_json) {
    const m = JSON.parse(r.motion_json) as MotionHandoff;
    const partIds = new Set(workspace.items.find(i => i.id === 'pipette')?.asset.parts.map(p => p.id) ?? []);
    const mappings = Object.values(m.component_ids ?? {});
    if (m.schema !== 'oi.opencad-motion/v1' || m.occurrence_id !== 'pipette' || m.duration_s !== 24
      || !Array.isArray(m.samples) || m.samples.length !== 97 || mappings.length !== 6
      || new Set(mappings).size !== 6 || !mappings.every(id => partIds.has(id))
      || !m.samples.every((s, i) => s.time_s === i / 4 && s.offsets_m
        && Object.keys(s.offsets_m).length === 6 && mappings.every(id => Array.isArray(s.offsets_m[id])
          && s.offsets_m[id].length === 3 && s.offsets_m[id].every(v => Number.isFinite(v) && Math.abs(v) <= 1)))) {
      throw Error('Invalid OpenCAD motion handoff');
    }
    const bound = r.frames.every(f => ['pipette', 'instruments'].every(id => f.snapshot.bindings.some(b =>
      b.id === id && b.data.scene_instance_id === id && b.data.scene_sha256 === canonicalHash)));
    if (m.source_scene_sha256 !== sceneHash || m.source_form_sha256 !== r.source_form_sha256 || !bound) finding = 'STALE motion: scene/CAD frames changed; revalidation required. Geometry only.';
    else if (!['clear', 'unchecked'].includes(m.checks?.motion?.status)) finding = 'Motion findings failed: geometry only';
    else { motion = m; finding = `OpenCAD ${m.checks.motion.status}: selected box proxies only; remaining mechanics unvalidated`; }
  }
  return { recording: structuredClone(r), workspace, motion, finding, scene_sha256: sceneHash };
}
/** Project only recorded paid work: no renderer clock can complete or advance a job. */
export function labFramePoses(lab: LoadedLab, index: number): { poses: EvaluatedPose[]; job: LabJob | null; frame: LabFrame } {
  if (!Number.isInteger(index) || index < 0 || index >= lab.recording.frames.length) throw Error('Invalid replay cursor');
  const frame = lab.recording.frames[index], s = frame.snapshot;
  const started = s.jobs.filter(j => j.checkpoint.started);
  const job = started.find(j => ['running', 'paused'].includes(j.state)) ?? started.at(-1) ?? null;
  const poses = evaluateWorkspace(lab.workspace.items, lab.workspace.animation, null);
  if (lab.motion) {
    const time = (job?.progress_ms ?? 0) / s.recipe.duration_ms * lab.motion.duration_s;
    // Held samples, never interpolation across a missing event or pause boundary.
    const sample = lab.motion.samples[Math.min(96, Math.floor(time * 4))];
    const pose = poses[lab.workspace.items.findIndex(i => i.id === lab.motion!.occurrence_id)];
    for (const [id, position] of Object.entries(sample.offsets_m)) pose.parts[id] = { position: [...position], rotation: [0, 0, 0] };
  }
  return { poses, job, frame };
}
