import { Box3, Vector3 } from 'three';

export type Vec3 = [number, number, number];
export type Part = {
  id: string;
  name: string;
  vertices: number[];
  indices: number[];
  color?: Vec3;
  metadata: Record<string, string>;
};
export type AssetNode = { id: string; name: string; partIds: string[]; children: AssetNode[] };
export type Instance = { id: string; assetId: string; name: string; position: Vec3 };
export type Room = { width: number; depth: number; height: number; walls: boolean };

import type { FormIR, FormArtifact } from './form-model';
export type { FormIR, FormComponent } from './form-model';
export type FormProject = {
  projectId?: string;
  revision?: string;
  agent?: string;
  hardwareIrVersion: string;
  ir: FormIR;
  source: 'project_ir' | 'hardware_ir' | 'namespace' | 'raw_ir';
  sourceDocument?: Record<string, unknown>;
  artifacts?: FormArtifact[];
};
export type AssetSource =
  | { kind: 'form'; filename: string; digest: string; projectId?: string; version?: string }
  | { kind: 'step'; filename: string; digest: string; projectId?: never; version?: never }
  | { kind: 'generated'; filename: string; digest: string; generator: 'form-industries'; projectId?: never; version?: never };

export type Asset = {
  schemaVersion: 1;
  id: string;
  name: string;
  source: AssetSource;
  units: 'm';
  upAxis: 'Y';
  parts: Part[];
  hierarchy: AssetNode;
  dimensions: Vec3;
  originOffset: Vec3;
  warnings: string[];
  formProject?: FormProject;
};

export function finalizeAsset(asset: Omit<Asset, 'dimensions' | 'originOffset' | 'units' | 'upAxis' | 'schemaVersion'>): Asset {
  if (!asset.parts.length) throw new Error('No renderable geometry was found in this file.');
  const bounds = new Box3();
  const point = new Vector3();
  let vertexCount = 0;
  const ids = new Set<string>();
  for (const part of asset.parts) {
    if (ids.has(part.id)) throw new Error(`Duplicate part ID: ${part.id}`);
    ids.add(part.id);
    if (part.vertices.length < 9 || part.vertices.length % 3 !== 0 || !part.vertices.every(Number.isFinite)) {
      throw new Error(`Invalid vertices in ${part.name}.`);
    }
    if (part.indices.length < 3 || part.indices.length % 3 !== 0 || !part.indices.every(i => Number.isInteger(i) && i >= 0 && i < part.vertices.length / 3)) {
      throw new Error(`Invalid triangle indices in ${part.name}.`);
    }
    vertexCount += part.vertices.length / 3;
    if (vertexCount > 2_000_000) throw new Error('Model exceeds the 2 million vertex limit. Export a simpler model.');
    for (let i = 0; i < part.vertices.length; i += 3) bounds.expandByPoint(point.fromArray(part.vertices, i));
  }
  const center = bounds.getCenter(new Vector3());
  const offset: Vec3 = [center.x, bounds.min.y, center.z];
  for (const part of asset.parts) {
    part.vertices = part.vertices.map((value, i) => value - offset[i % 3]);
  }
  const dimensions = bounds.getSize(new Vector3()).toArray() as Vec3;
  if (Math.max(...dimensions) <= 0) throw new Error('Model has no physical extent.');
  return { ...asset, schemaVersion: 1, units: 'm', upAxis: 'Y', dimensions, originOffset: offset };
}

export async function digestBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export function checkFile(file: Pick<File, 'size' | 'name'>) {
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} exceeds the 25 MiB import limit.`);
}
