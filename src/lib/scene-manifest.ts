import type { Asset, Vec3 } from './scene';
import { readManifest, type SceneManifest } from './workspace';
import type { SavedScene } from './scene-repository';

export const ASTRA_SCENE_SCHEMA_VERSION = 1 as const;

export type SceneSource = {
  projectId?: string;
  revision?: string;
};

export type SceneRoom = {
  width: number;
  depth: number;
  height: number;
};

export type SceneInstance = {
  id: string;
  assetId: string;
  name: string;
  position: Vec3;
  rotation: Vec3;
  visible: boolean;
};

export type Keyframe = {
  timeSeconds: number;
  position?: Vec3;
  rotation?: Vec3;
  visible?: boolean;
};

export type AnimationTrack = {
  instanceId: string;
  keyframes: Keyframe[];
};

export type AnimationTimeline = {
  durationSeconds: number;
  fps: number;
  tracks: AnimationTrack[];
};

export type MergenceScene = {
  workspaceDocument?: SceneManifest;
  activeCloudScene?: SavedScene | null;
  schemaVersion: typeof ASTRA_SCENE_SCHEMA_VERSION;
  id: string;
  source: SceneSource;
  room: SceneRoom;
  instances: SceneInstance[];
  animation?: AnimationTimeline;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function validateVector(vector: unknown, label: string, errors: string[]) {
  if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(isFiniteNumber)) errors.push(`${label} must contain exactly three finite numbers.`);
}

/** Persisted browser data is unknown, even when it was originally written by us. */
export function validateScene(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['Saved scene must be an object.'];
  const scene = value;
  if (scene.schemaVersion !== ASTRA_SCENE_SCHEMA_VERSION) errors.push('Unsupported scene schema version.');
  if (!isString(scene.id)) errors.push('Scene ID is required.');
  if (!isRecord(scene.source)) errors.push('Scene source must be an object.');
  else for (const key of ['projectId','revision']) if (scene.source[key] !== undefined && !isString(scene.source[key])) errors.push(`source.${key} must be a non-empty string.`);
  if (!isRecord(scene.room)) errors.push('Saved room dimensions are missing or invalid.');
  else for (const key of ['width','depth','height']) if (!isFiniteNumber(scene.room[key]) || scene.room[key] < 1 || scene.room[key] > 100) errors.push(`room.${key} must be between 1 and 100 meters.`);
  if (!Array.isArray(scene.instances) || scene.instances.length > 1000) return [...errors,'Scene instances must be an array of at most 1,000 entries.'];
  const ids = new Set<string>();
  for (const instance of scene.instances) {
    if (!isRecord(instance)) { errors.push('A scene instance is not an object.'); continue; }
    if (!isString(instance.id)) errors.push('Scene instance ID is required.');
    else { if (ids.has(instance.id)) errors.push('Duplicate scene instance ID.'); ids.add(instance.id); }
    if (!isString(instance.assetId)) errors.push('Scene instance asset ID is required.');
    if (!isString(instance.name)) errors.push('Scene instance name is required.');
    if (typeof instance.visible !== 'boolean') errors.push('Scene instance visibility must be a boolean.');
    validateVector(instance.position, 'Instance position', errors);
    validateVector(instance.rotation, 'Instance rotation', errors);
  }
  if (scene.animation !== undefined) {
    if (!isRecord(scene.animation) || !Array.isArray(scene.animation.tracks) || scene.animation.tracks.length > 1000) return [...errors,'Invalid saved animation tracks.'];
    if (!isFiniteNumber(scene.animation.durationSeconds) || scene.animation.durationSeconds < 0 || scene.animation.durationSeconds > 120) errors.push('Animation duration must be between 0 and 120 seconds.');
    if (!isFiniteNumber(scene.animation.fps) || scene.animation.fps <= 0) errors.push('Animation frame rate must be positive.');
    let keyCount = 0;
    for (const track of scene.animation.tracks) {
      if (!isRecord(track) || !Array.isArray(track.keyframes)) { errors.push('Invalid animation track.'); continue; }
      if (!isString(track.instanceId) || !ids.has(track.instanceId)) errors.push('Animation track references a missing instance.');
      let previous = -1;
      for (const keyframe of track.keyframes) {
        if (++keyCount > 10000) return [...errors,'Saved animation exceeds 10,000 keys.'];
        if (!isRecord(keyframe)) { errors.push('Invalid animation keyframe.'); continue; }
        if (!isFiniteNumber(keyframe.timeSeconds) || keyframe.timeSeconds < 0 || keyframe.timeSeconds < previous || (isFiniteNumber(scene.animation.durationSeconds) && keyframe.timeSeconds > scene.animation.durationSeconds)) errors.push('Invalid or unordered keyframe time.');
        if (isFiniteNumber(keyframe.timeSeconds)) previous = keyframe.timeSeconds;
        if (keyframe.position !== undefined) validateVector(keyframe.position,'Keyframe position',errors);
        if (keyframe.rotation !== undefined) validateVector(keyframe.rotation,'Keyframe rotation',errors);
        if (keyframe.visible !== undefined && typeof keyframe.visible !== 'boolean') errors.push('Keyframe visibility must be a boolean.');
      }
    }
  }
  if (scene.workspaceDocument !== undefined) {
    try { readManifest(scene.workspaceDocument); } catch { errors.push('The saved workspace document is invalid or unsupported.'); }
  }
  if (scene.activeCloudScene !== undefined && scene.activeCloudScene !== null) {
    const cloud=scene.activeCloudScene;
    if (!isRecord(cloud) || !isString(cloud.id) || !isString(cloud.owner_id) || !isString(cloud.name) || !isFiniteNumber(cloud.revision) || !Number.isInteger(cloud.revision) || cloud.revision < 0 || !isString(cloud.updated_at)) errors.push('The saved cloud scene reference is invalid.');
    else if (cloud.document !== undefined) { try { readManifest(cloud.document); } catch { errors.push('The saved cloud revision document is invalid.'); } }
  }
  return errors;
}

export function migratePositions(assets: Asset[], room: number[], positions: Vec3[], id = `scene-${crypto.randomUUID()}`): MergenceScene {
  const scene: MergenceScene = {
    schemaVersion: ASTRA_SCENE_SCHEMA_VERSION,
    id,
    source: {},
    room: { width: room[0], depth: room[1], height: room[2] },
    instances: assets.map((asset, index) => ({
      id: `${asset.id}/instance/${index}`,
      assetId: asset.id,
      name: asset.name,
      position: positions[index] || [0, 0, 0],
      rotation: [0, 0, 0],
      visible: true,
    })),
  };
  const errors = validateScene(scene);
  if (errors.length) throw new Error(`Could not migrate workspace: ${errors.join(' ')}`);
  return scene;
}
