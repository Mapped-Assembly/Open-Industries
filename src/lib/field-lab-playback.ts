import type { EventJob } from '../../server/simulation/event-runtime-contracts';

/** Public, authorized field-lab snapshot fields used by the scene projection. */
export interface LabSceneSnapshot {
  instance_id: string;
  revision: number;
  cursor_ms: number;
  origin_ms: number;
  scenario: string;
  recipe: { duration_ms: number };
  bindings: { id: string; data: { scene_sha256: string; scene_instance_id: string } }[];
  jobs: EventJob[];
  resources: { balances: { account_id: string; resource_id: string; quantity: number }[] };
}

/** Portable read-only scene checkpoint; progress is paid runtime work, never wall time. */
export interface LabSceneFrame {
  version: 1;
  event_id: string;
  instance_id: string;
  revision: number;
  elapsed_ms: number;
  scenario: string;
  scene_sha256: string;
  units: { position: 'm'; time: 'ms'; frame: 'right-handed-Y-up' };
  occurrence_id: 'pipette';
  job: { id: string; state: EventJob['state']; reason: string | null; progress_ms: number } | null;
  pose_fraction: number;
  processed: number;
  waiting_reasons: string[];
  stock: { batteryWh: number; waterL: number; tips: number; kits: number };
  mechanics: 'kinematic-only';
}

/** Project an authorized recorded post-state without dispatching commands or inventing work. */
export function projectLabScene(snapshot: LabSceneSnapshot, eventId: string): LabSceneFrame {
  const binding = snapshot.bindings.find((item) => item.id === 'pipette');
  if (!eventId || !binding || binding.data.scene_instance_id !== 'pipette'
    || !/^[a-f0-9]{64}$/.test(binding.data.scene_sha256)
    || !Number.isSafeInteger(snapshot.recipe.duration_ms) || snapshot.recipe.duration_ms <= 0
    || !Number.isSafeInteger(snapshot.cursor_ms) || snapshot.cursor_ms < snapshot.origin_ms
    || snapshot.jobs.some((job) => !Number.isSafeInteger(job.progress_ms)
      || job.progress_ms < 0 || job.progress_ms > snapshot.recipe.duration_ms)) {
    throw new Error('INVALID_LAB_SCENE_SNAPSHOT');
  }
  // The frozen runtime admits samples in order. Prefer its active reservation; otherwise
  // retain the most recently started job, including failed/cancelled terminal checkpoints.
  const job = snapshot.jobs.find((item) => item.checkpoint.reserved)
    ?? snapshot.jobs.slice().reverse().find((item) => item.checkpoint.started);
  const stock = (resource: string): number => snapshot.resources.balances
    .filter((item) => item.account_id === resource && item.resource_id === resource)
    .reduce((sum, item) => sum + item.quantity, 0);
  return {
    version: 1, event_id: eventId, instance_id: snapshot.instance_id,
    revision: snapshot.revision, elapsed_ms: snapshot.cursor_ms - snapshot.origin_ms,
    scenario: snapshot.scenario, scene_sha256: binding.data.scene_sha256,
    units: { position: 'm', time: 'ms', frame: 'right-handed-Y-up' },
    occurrence_id: 'pipette',
    job: job ? { id: job.id, state: job.state, reason: job.reason, progress_ms: job.progress_ms } : null,
    pose_fraction: job ? job.progress_ms / snapshot.recipe.duration_ms : 0,
    processed: snapshot.jobs.filter((item) => item.state === 'completed').length,
    waiting_reasons: [...new Set(snapshot.jobs.flatMap((item) => item.reason ? [item.reason] : []))],
    stock: { batteryWh: stock('energy') / 3600000, waterL: stock('water') / 1000000,
      tips: stock('tips'), kits: stock('kits') },
    mechanics: 'kinematic-only',
  };
}

/** Validate a recording once on import, including duplicate, ordering and source checks. */
export function validateLabRecording(frames: LabSceneFrame[], sceneSha256: string): void {
  if (!frames.length) throw new Error('EMPTY_LAB_RECORDING');
  const ids = new Set<string>();
  let previous = -1;
  let revision = -1;
  for (const frame of frames) {
    if (frame.version !== 1 || frame.scene_sha256 !== sceneSha256
      || frame.instance_id !== frames[0].instance_id || frame.scenario !== frames[0].scenario
      || !frame.event_id || ids.has(frame.event_id)
      || !Number.isSafeInteger(frame.elapsed_ms) || frame.elapsed_ms < previous
      || !Number.isSafeInteger(frame.revision) || frame.revision < revision
      || frame.occurrence_id !== 'pipette' || frame.units?.position !== 'm'
      || frame.units?.time !== 'ms' || frame.units?.frame !== 'right-handed-Y-up'
      || !Number.isSafeInteger(frame.processed) || frame.processed < 0 || frame.processed > 24
      || !Array.isArray(frame.waiting_reasons) || frame.waiting_reasons.some(reason => typeof reason !== 'string')
      || !frame.stock || ['batteryWh', 'waterL', 'tips', 'kits'].some(key => {
        const value = frame.stock[key as keyof LabSceneFrame['stock']];
        return !Number.isFinite(value) || value < 0;
      })
      || !Number.isFinite(frame.pose_fraction) || frame.pose_fraction < 0 || frame.pose_fraction > 1
      || frame.mechanics !== 'kinematic-only') throw new Error('INVALID_OR_STALE_LAB_RECORDING');
    ids.add(frame.event_id);
    previous = frame.elapsed_ms;
    revision = frame.revision;
  }
}

/** Scrubbing, reconnect and export all use the last recorded post-state; no extrapolation. */
export function sampleLabRecording(frames: readonly LabSceneFrame[], elapsedMs: number): LabSceneFrame {
  if (!frames.length || !Number.isFinite(elapsedMs) || elapsedMs < frames[0].elapsed_ms)
    throw new Error('LAB_RECORDING_TIME_UNAVAILABLE');
  let low = 0, high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].elapsed_ms <= elapsedMs) low = middle + 1;
    else high = middle;
  }
  return frames[low - 1];
}
