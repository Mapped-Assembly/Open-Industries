import { BoxGeometry } from 'three';
import { finalizeAsset, type Asset, type Vec3 } from './scene';
import { emptyWorkspace, writeKeyframe, type Workspace } from './workspace';

export type SpaceBriefKey = 'biofab' | 'manufacturing' | 'maker';
type EnvelopeSpec = { name: string; zone: string; size: Vec3; position: Vec3; color: Vec3; moving?: boolean };
export type SpaceBrief = { key: SpaceBriefKey; label: string; description: string; room: Vec3; envelopes: EnvelopeSpec[] };

export const SPACE_BRIEFS: Record<SpaceBriefKey, SpaceBrief> = {
  biofab: {
    key: 'biofab', label: 'Biofab / wet lab', description: 'Cleanable wet work, incubation, cold storage, and controlled material flow.', room: [10, 8, 3.2], envelopes: [
      { name: 'Aseptic workcell', zone: 'Clean work', size: [2.4, 1.5, 1.2], position: [-2.7, 0, -2.2], color: [0.48, 0.78, 0.67] },
      { name: 'Incubation bay', zone: 'Culture', size: [1.6, 2, 1.2], position: [0, 0, -2.2], color: [0.78, 0.7, 0.35] },
      { name: 'Cold storage', zone: 'Storage', size: [1.4, 2, 1.1], position: [2.2, 0, -2.2], color: [0.35, 0.65, 0.82] },
      { name: 'Wash and waste station', zone: 'Decontamination', size: [2.2, 1.2, 1], position: [-2.3, 0, 1.6], color: [0.5, 0.6, 0.72] },
      { name: 'Material transfer cart', zone: 'Flow', size: [1, .9, .8], position: [1.8, 0, 1.5], color: [0.83, 0.52, 0.32], moving: true },
    ],
  },
  manufacturing: {
    key: 'manufacturing', label: 'Small manufacturing plant', description: 'Receiving, fabrication, inspection, assembly, and outbound flow.', room: [14, 9, 4], envelopes: [
      { name: 'Receiving rack', zone: 'Inbound', size: [2.4, 2.4, 1.1], position: [-5, 0, -2.7], color: [0.43, 0.55, 0.68] },
      { name: 'CNC workcell', zone: 'Fabrication', size: [2.8, 1.8, 1.4], position: [-1.7, 0, -2.4], color: [0.56, 0.61, 0.68] },
      { name: 'Inspection bench', zone: 'Quality', size: [2.3, 1.4, 1], position: [1.8, 0, -2.4], color: [0.7, 0.7, 0.4] },
      { name: 'Assembly cell', zone: 'Assembly', size: [2.8, 1.8, 1.2], position: [5, 0, -2.3], color: [0.54, 0.72, 0.48] },
      { name: 'Pallet transfer cart', zone: 'Material flow', size: [1.4, 1, .9], position: [-2.5, 0, 1.8], color: [0.84, 0.5, 0.28], moving: true },
      { name: 'Outbound staging', zone: 'Outbound', size: [2.5, 1.5, 1], position: [3, 0, 1.8], color: [0.42, 0.65, 0.7] },
    ],
  },
  maker: {
    key: 'maker', label: 'DIY maker space', description: 'Flexible benches, digital fabrication, electronics, and shared material storage.', room: [9, 7, 3.2], envelopes: [
      { name: 'Electronics bench', zone: 'Electronics', size: [2.4, 1.2, .95], position: [-2.5, 0, -1.9], color: [0.4, 0.7, 0.78] },
      { name: 'Digital fabrication bench', zone: 'Fabrication', size: [2.4, 1.4, 1.1], position: [0.5, 0, -1.9], color: [0.72, 0.5, 0.75] },
      { name: 'Hand tools wall', zone: 'Tools', size: [1.3, .5, 2.2], position: [3.2, 0, -1.6], color: [0.7, 0.52, 0.35] },
      { name: 'Shared assembly table', zone: 'Collaboration', size: [2.8, 1.5, .9], position: [-1.4, 0, 1.7], color: [0.66, 0.56, 0.36] },
      { name: 'Parts trolley', zone: 'Flow', size: [1, .8, .8], position: [2, 0, 1.6], color: [0.82, 0.48, 0.3], moving: true },
    ],
  },
};

function envelopeAsset(key: SpaceBriefKey, index: number, spec: EnvelopeSpec): Asset {
  const geometry = new BoxGeometry(...spec.size);
  const asset = finalizeAsset({
    id: `space-${key}-${index}`,
    name: spec.name,
    source: { kind: 'form', filename: `form-${key}-equipment-brief.json`, digest: `planning-${key}-${index}` },
    parts: [{ id: `space-${key}-${index}/envelope`, name: spec.name, vertices: Array.from(geometry.attributes.position.array), indices: Array.from(geometry.index!.array), color: spec.color, metadata: { representation: 'Form equipment planning envelope', zone: spec.zone, status: 'Replace with Form-authored equipment artifact' } }],
    hierarchy: { id: `space-${key}-${index}/root`, name: spec.name, partIds: [`space-${key}-${index}/envelope`], children: [] },
    warnings: ['Planning envelope only. Author and replace this equipment with Form OSS before fabrication.'],
  });
  geometry.dispose();
  return asset;
}

export function inferSpaceBrief(requirements: string): SpaceBriefKey {
  const value = requirements.toLowerCase();
  if (/bio|lab|culture|sterile|wet/.test(value)) return 'biofab';
  if (/manufactur|factory|cnc|production|plant/.test(value)) return 'manufacturing';
  return 'maker';
}

export function buildSpace(key: SpaceBriefKey, requirements: string): { workspace: Workspace; movingIndex: number; brief: SpaceBrief; requirements: string } {
  const brief = SPACE_BRIEFS[key];
  const normalized = requirements.trim().slice(0, 2000);
  const items = brief.envelopes.map((spec, index) => ({
    id: crypto.randomUUID(), asset: envelopeAsset(key, index, spec), name: spec.name,
    position: [...spec.position] as Vec3, rotation: [0, 0, 0] as Vec3, visible: true,
  }));
  let workspace: Workspace = { ...emptyWorkspace(), room: [...brief.room], items, animation: { duration: 8, loop: true, tracks: [] } };
  const movingIndex = brief.envelopes.findIndex(spec => spec.moving);
  if (movingIndex >= 0) {
    const item = items[movingIndex]; const start = item.position; const end: Vec3 = [start[0] + (key === 'manufacturing' ? 6 : 3), start[1], start[2] - (key === 'biofab' ? 3 : 2)];
    workspace.animation = writeKeyframe(workspace.animation, item.id, undefined, { id: `${item.id}-start`, time: 0, position: start, rotation: [0, 0, 0] });
    workspace.animation = writeKeyframe(workspace.animation, item.id, undefined, { id: `${item.id}-mid`, time: 4, position: end, rotation: [0, key === 'manufacturing' ? 180 : 90, 0] });
    workspace.animation = writeKeyframe(workspace.animation, item.id, undefined, { id: `${item.id}-end`, time: 8, position: start, rotation: [0, 360, 0] });
  }
  return { workspace, movingIndex, brief, requirements: normalized };
}
