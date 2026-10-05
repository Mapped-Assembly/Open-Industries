import { Box3, BoxGeometry, Euler, Matrix4, Quaternion, MathUtils, Vector3 } from 'three';
import type { Asset, Vec3 } from './scene';
import { parseCloudBundle, scrubCloudData } from './cloud-storage';

export type VersionedAsset = { cloudVersionId: string; asset: Asset };
export type Pose = { position: Vec3; rotation: Vec3 };
export type SceneItem = Pose & { id: string; name: string; asset: Asset; visible: boolean; cloudVersionId?: string; missing?: boolean };
export type Keyframe = Pose & { id: string; time: number; visible?: boolean };
export type Track = { id: string; instanceId: string; partId?: string; keys: Keyframe[] };
export type Animation = { duration: number; loop: boolean; tracks: Track[] };
export type Workspace = { room: Vec3; items: SceneItem[]; animation: Animation };
export type EvaluatedPose = Pose & { visible: boolean; parts: Record<string, Pose> };
export type AssetReference = Pick<Asset, 'id' | 'name' | 'source' | 'dimensions'> & { projectRevision?: string };
export type SceneManifest = {
  format: 'astra.scene'; version: 1; units: 'm'; upAxis: 'Y'; room: Vec3;
  assets: AssetReference[]; instances: (Pose & { id: string; name: string; assetId: string; visible: boolean; cloudVersionId?: string })[];
  animation: Animation; bundledAssets?: Asset[]; bundledVersions?: VersionedAsset[];
};

export const zeroPose = (): Pose => ({ position: [0, 0, 0], rotation: [0, 0, 0] });
export const emptyWorkspace = (): Workspace => ({ room: [6, 5, 3], items: [], animation: { duration: 3, loop: true, tracks: [] } });
export function canonicalJSON(value: unknown): string {
  const order=(v:unknown):unknown=>Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,order(item)])):v;
  return JSON.stringify(order(value));
}
export function appendAssets(workspace: Workspace, assets: Asset[], cloudVersionId?: string): Workspace {
  let items = [...workspace.items];
  for (const asset of assets) {
    const canRepair = (item: SceneItem) => item.missing && item.asset.id === asset.id && (!item.cloudVersionId || item.cloudVersionId === cloudVersionId);
    const missing = items.some(canRepair);
    if (missing) {
      for (const item of items.filter(canRepair)) assertSourceMatches({ ...item.asset, projectRevision: item.asset.formProject?.revision }, asset);
      items = items.map(item => canRepair(item) ? { ...item, asset, missing: false, cloudVersionId } : item);
      continue;
    }
    const right = items.length ? Math.max(...items.map(item => {
      const [x,y,z]=item.asset.dimensions;
      const box=new Box3(new Vector3(-x/2,0,-z/2),new Vector3(x/2,y,z/2));
      const matrix=new Matrix4().compose(new Vector3(...item.position),new Quaternion().setFromEuler(new Euler(...item.rotation.map(MathUtils.degToRad) as Vec3)),new Vector3(1,1,1));
      return box.applyMatrix4(matrix).max.x;
    })) : -asset.dimensions[0] / 2 - .25;
    items.push({ id: crypto.randomUUID(), asset, name: asset.name, position: [right + .25 + asset.dimensions[0] / 2, 0, 0], rotation: [0, 0, 0], visible: true, cloudVersionId });
  }
  return { ...workspace, items };
}

function sample(track: Track, time: number): Pose {
  const keys = [...track.keys].sort((a, b) => a.time - b.time);
  if (time <= keys[0].time) return keys[0];
  if (time >= keys[keys.length - 1].time) return keys[keys.length - 1];
  const right = keys.findIndex(key => key.time > time); const a = keys[right - 1]; const b = keys[right];
  const t = (time - a.time) / (b.time - a.time);
  const qa = new Quaternion().setFromEuler(new Euler(...a.rotation.map(MathUtils.degToRad) as Vec3));
  const qb = new Quaternion().setFromEuler(new Euler(...b.rotation.map(MathUtils.degToRad) as Vec3));
  const euler = new Euler().setFromQuaternion(qa.slerp(qb, t));
  return { position: a.position.map((n, i) => n + (b.position[i] - n) * t) as Vec3,
    rotation: [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3 };
}
/** Visibility is a held value: omitted keys inherit the last explicit key or base layout. */
function sampleVisibility(track: Track, time: number, base: boolean): boolean {
  let latest: Keyframe | undefined;
  for (const key of track.keys) {
    if (key.visible !== undefined && key.time <= time && (!latest || key.time > latest.time)) latest = key;
  }
  return latest?.visible ?? base;
}
export function evaluateWorkspace(items: SceneItem[], animation: Animation, time: number | null): EvaluatedPose[] {
  return items.map(item => {
    let pose: Pose = item; let visible = item.visible; const parts: Record<string, Pose> = {};
    if (time !== null) for (const track of animation.tracks) {
      if (track.instanceId !== item.id || !track.keys.length) continue;
      if (track.partId) parts[track.partId] = sample(track, time);
      else { pose = sample(track, time); visible = sampleVisibility(track, time, item.visible); }
    }
    return { position: [...pose.position], rotation: [...pose.rotation], visible, parts };
  });
}
export function writeKeyframe(animation: Animation, instanceId: string, partId: string | undefined, key: Keyframe): Animation {
  const id = `${instanceId}:${partId ?? 'instance'}`;
  const track = animation.tracks.find(t => t.id === id) ?? { id, instanceId, partId, keys: [] };
  const keys = [...track.keys.filter(k => k.id !== key.id && Math.abs(k.time - key.time) > .0001), key].sort((a, b) => a.time - b.time);
  return { ...animation, tracks: [...animation.tracks.filter(t => t.id !== id), { ...track, keys }] };
}

export function makeManifest(workspace: Workspace, bundle = false): SceneManifest {
  const assets = [...new Map(workspace.items.map(item => [item.asset.id, item.asset])).values()];
  return scrubCloudData({ format: 'astra.scene', version: 1, units: 'm', upAxis: 'Y', room: workspace.room,
    assets: assets.map(({ id, name, source, dimensions, formProject }) => ({ id, name, source, dimensions, projectRevision: formProject?.revision })),
    instances: workspace.items.map(({ id, name, asset, position, rotation, visible, cloudVersionId }) => ({ id, name, assetId: asset.id, position, rotation, visible, cloudVersionId })),
    animation: workspace.animation,
    ...(bundle ? {
      bundledAssets: [...new Map(workspace.items.filter(item => !item.missing && !item.cloudVersionId).map(item => [item.asset.id, item.asset])).values()],
      bundledVersions: [...new Map(workspace.items.filter(item => !item.missing && item.cloudVersionId).map(item => [item.cloudVersionId!, { cloudVersionId: item.cloudVersionId!, asset: item.asset }])).values()],
    } : {}),
  }) as SceneManifest;
}
const validVector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6);
const validString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
export function readManifest(value: unknown): SceneManifest {
  const m = scrubCloudData(value) as SceneManifest;
  if (!m || m.format !== 'astra.scene' || m.version !== 1 || m.units !== 'm' || m.upAxis !== 'Y' || !validVector(m.room) || !m.room.every(n => n >= 1 && n <= 100)
      || !Array.isArray(m.assets) || m.assets.length > 1000 || !Array.isArray(m.instances) || m.instances.length > 1000) throw new Error('Unsupported or invalid Mergence scene manifest.');
  const assetIds = new Set<string>();
  for (const asset of m.assets) {
    if (!validString(asset.id) || assetIds.has(asset.id) || !validString(asset.name) || !validVector(asset.dimensions) || asset.dimensions.some(n => n < 0)
        || !asset.source || !['form','step','generated'].includes(asset.source.kind) || !validString(asset.source.filename) || !validString(asset.source.digest)
        || (asset.source.kind === 'generated' && asset.source.generator !== 'form-industries')
        || (asset.projectRevision !== undefined && !validString(asset.projectRevision))) throw new Error('Invalid or duplicate scene asset reference.');
    assetIds.add(asset.id);
  }
  const ids = new Set<string>();
  for (const item of m.instances) {
    if (!validString(item.id) || ids.has(item.id) || !assetIds.has(item.assetId) || !validString(item.name) || !validVector(item.position) || !validVector(item.rotation)
        || typeof item.visible !== 'boolean' || (item.cloudVersionId !== undefined && !/^[0-9a-f-]{36}$/i.test(item.cloudVersionId))) throw new Error('Invalid scene instance or transform.');
    ids.add(item.id);
  }
  if (!m.animation || !Number.isFinite(m.animation.duration) || m.animation.duration < .5 || m.animation.duration > 120 || typeof m.animation.loop !== 'boolean'
      || !Array.isArray(m.animation.tracks) || m.animation.tracks.length > 1000) throw new Error('Invalid animation timeline.');
  const targets = new Set<string>(); let keyCount = 0;
  for (const track of m.animation.tracks) {
    const target = `${track.instanceId}:${track.partId ?? 'instance'}`;
    if (track.id !== target || targets.has(target) || !ids.has(track.instanceId) || (track.partId !== undefined && !validString(track.partId)) || !Array.isArray(track.keys) || !track.keys.length) throw new Error('Duplicate or missing animation target.');
    targets.add(target); const times = new Set<number>(); const keyIds = new Set<string>();
    for (const key of track.keys) {
      if (++keyCount > 10000 || !validString(key.id) || keyIds.has(key.id) || !Number.isFinite(key.time) || key.time < 0 || key.time > m.animation.duration || times.has(key.time)
          || !validVector(key.position) || !validVector(key.rotation)) throw new Error('Invalid keyframe value or duplicate keyframe time.');
      if (key.visible !== undefined && (typeof key.visible !== 'boolean' || track.partId !== undefined)) throw new Error('Keyframe visibility must be a boolean on a whole-instance track.');
      times.add(key.time); keyIds.add(key.id);
    }
  }
  if (m.bundledVersions !== undefined) {
    if (!Array.isArray(m.bundledVersions) || m.bundledVersions.length > 1000) throw new Error('Invalid bundled file versions.');
    const versions = new Set<string>();
    for (const entry of m.bundledVersions) {
      if (!entry || !/^[0-9a-f-]{36}$/i.test(entry.cloudVersionId) || versions.has(entry.cloudVersionId)
        || !m.instances.some(item => item.cloudVersionId === entry.cloudVersionId && item.assetId === entry.asset?.id)) throw new Error('Invalid or duplicate bundled file-version binding.');
      versions.add(entry.cloudVersionId);
    }
  }
  return m;
}
export function missingAsset(ref: AssetReference, cloudVersionId?: string): Asset {
  const geometry = new BoxGeometry(...ref.dimensions.map(n => Math.max(n, .01)) as Vec3);
  geometry.translate(0, ref.dimensions[1] / 2, 0);
  const part = { id: `${ref.id}/missing`, name: 'Missing geometry — reimport original source', vertices: Array.from(geometry.attributes.position.array), indices: Array.from(geometry.index!.array), color: [.7,.25,.2] as Vec3, metadata: { representation: 'Missing geometry placeholder' } };
  geometry.dispose();
  return { ...ref, schemaVersion: 1, units: 'm', upAxis: 'Y', originOffset: [0,0,0], parts: [part], hierarchy: { id: `${ref.id}/root`, name: ref.name, partIds: [part.id], children: [] }, warnings: [cloudVersionId ? `Cloud file version ${cloudVersionId} is unavailable. Retrieve that exact version or reopen the saved revision after restoring Storage access.` : 'Geometry unavailable. Reimport the matching source.'], ...(ref.projectRevision ? {formProject:{projectId:ref.source.projectId,revision:ref.projectRevision,hardwareIrVersion:ref.source.version?.split(' / ')[0]??'0.2',ir:{},source:'raw_ir' as const}} : {}) };
}
/** IDs alone cannot prove that a source is the revision used by this scene. */
export function assertSourceMatches(ref: AssetReference, asset: Asset): void {
  if (asset.id !== ref.id || asset.source.kind !== ref.source.kind || asset.source.digest !== ref.source.digest
      || asset.source.version !== ref.source.version || asset.source.projectId !== ref.source.projectId
      || (ref.source.projectId !== undefined && asset.formProject?.projectId !== undefined && asset.formProject.projectId !== ref.source.projectId)
      || (ref.projectRevision !== undefined && asset.formProject?.revision !== ref.projectRevision)) {
    throw new Error(`Source revision mismatch for ${ref.name}. Reimport the original project/revision or open a portable scene containing its matching geometry. The current scene has not been replaced.`);
  }
}
export function hydrateManifest(manifest: SceneManifest, available: Asset[], availableVersions: ReadonlyMap<string, Asset> = new Map()): Workspace {
  const assets = new Map(available.map(asset => [asset.id, asset]));
  for (const raw of manifest.bundledAssets ?? []) {
    const asset = parseCloudBundle(JSON.stringify({ schemaVersion: 1, asset: raw })).asset;
    assets.set(asset.id, asset);
  }
  const versions = new Map(availableVersions);
  for (const entry of manifest.bundledVersions ?? []) {
    const asset = parseCloudBundle(JSON.stringify({ schemaVersion: 1, asset: entry.asset })).asset;
    versions.set(entry.cloudVersionId, asset);
  }
  const items = manifest.instances.map(({ assetId, ...instance }) => {
    const ref = manifest.assets.find(a => a.id === assetId)!;
    // A matching source digest or asset ID is not proof of a file version.
    const candidate = instance.cloudVersionId ? versions.get(instance.cloudVersionId) : assets.get(assetId);
    const asset = candidate?.id === assetId ? candidate : undefined;
    if (asset) assertSourceMatches(ref, asset);
    return { ...instance, asset: asset ?? missingAsset(ref, instance.cloudVersionId), missing: !asset };
  });
  for (const track of manifest.animation.tracks) {
    const item = items.find(i => i.id === track.instanceId)!;
    if (!item.missing && track.partId && !item.asset.parts.some(p => p.id === track.partId)) throw new Error(`Animation component is missing in ${item.name}.`);
  }
  return { room: manifest.room, items, animation: manifest.animation };
}

/** Compare editable content without authorship metadata or portable geometry. */
export function sceneContent(value: unknown) {
  const { format, version, units, upAxis, room, assets, instances, animation } = readManifest(value);
  return { format, version, units, upAxis, room, assets, instances, animation };
}
export function workspaceVersions(workspace: Workspace): VersionedAsset[] {
  return [...new Map(workspace.items.filter(item => item.cloudVersionId && !item.missing)
    .map(item => [item.cloudVersionId!, { cloudVersionId: item.cloudVersionId!, asset: item.asset }])).values()];
}
