import { BoxGeometry, Euler, Matrix4 } from 'three';
import { finalizeAsset, type Asset, type FormProject, type Part, type Vec3 } from './scene';
import { scrubCloudData } from './cloud-storage';
import { objectRecord, readHardwareIR, readHardwareVersion, readArtifacts, readProvenance, readBOM,
  type FormMechanical, type FormComponent, type FormPartDefinition, type FormArtifact } from './form-model';

type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
const text = (value: unknown, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}
function vector(value: unknown, label: string, positive = false): Vec3 {
  const item = record(value);
  return ['x_mm', 'y_mm', 'z_mm'].map(key => {
    const n = finite(item[key], `${label}.${key}`);
    if (positive && n <= 0) throw new Error(`${label}.${key} must be greater than zero.`);
    return n;
  }) as Vec3;
}

export type FormDocument = {
  name: string; projectId?: string; version: string; mechanical: FormMechanical;
  cad: unknown; definitions: FormPartDefinition[]; components: FormComponent[]; artifacts: FormArtifact[]; project: FormProject;
};

export function readFormDocument(input: unknown, filename: string): FormDocument {
  const sourceDocument = objectRecord(scrubCloudData(structuredClone(input)), 'document');
  let root = sourceDocument;
  if (!Object.keys(root).length) throw new Error('Expected a Form project JSON object.');
  if (root.response !== undefined) root = objectRecord(root.response, 'response');
  if (root.format !== undefined && (typeof root.format !== 'string' || !['form-project', 'forma-project'].includes(root.format))) {
    throw new Error(`Unsupported project format: ${root.format}. Expected form-project or forma-project.`);
  }
  if (root.format !== undefined && root.version !== 1) throw new Error(`Unsupported Form manifest version: ${root.version}. Expected 1.`);
  if (root.format !== undefined && root.project_ir === undefined && root.hardware_ir === undefined && root.project_object === undefined && root.object_type === undefined) {
    throw new Error('Form manifest is missing project_ir, hardware_ir, or project_object. Import the compiled project artifact.');
  }
  const author = readProvenance(root, 'document');
  const wrappedIR = root.project_ir !== undefined ? 'project_ir' : root.hardware_ir !== undefined ? 'hardware_ir' : undefined;
  let source: FormProject['source'] = wrappedIR ?? 'raw_ir';
  let rawIR = wrappedIR ? objectRecord(root[wrappedIR], wrappedIR) : root;
  let revision: string | undefined;
  let projectId = text(author.project_id);
  let version: string;
  if (!wrappedIR && (root.project_object !== undefined || root.object_type !== undefined)) {
    const object = objectRecord(root.project_object !== undefined ? root.project_object : root, 'project_object');
    if (typeof object.object_type !== 'string' || !['form.project', 'forma.project'].includes(object.object_type)) throw new Error('Unsupported project object type. Expected form.project or forma.project.');
    // Object versions identify source revisions, not Hardware IR schemas.
    if (!Number.isSafeInteger(object.version) || Number(object.version) < 1) throw new Error('Invalid Form project revision. Expected a positive integer.');
    if (object.object_id !== undefined && typeof object.object_id !== 'string') throw new Error('Invalid Form project_object.object_id: expected a string.');
    if (!Array.isArray(object.namespaces)) throw new Error('Form project namespaces must be an array.');
    const namespaces = new Map<string, RecordValue>();
    for (const [i, value] of object.namespaces.entries()) {
      const namespace = objectRecord(value, `project_object.namespaces[${i}]`);
      if (typeof namespace.name !== 'string' || !namespace.name.trim()) throw new Error(`Invalid Form project_object.namespaces[${i}].name: expected a non-empty string.`);
      if (namespaces.has(namespace.name)) throw new Error(`Duplicate Form namespace name: ${namespace.name}`);
      namespaces.set(namespace.name, objectRecord(namespace.payload, `project_object.namespaces[${i}].payload`));
    }
    const payload = (name: string) => namespaces.get(name) ?? {};
    const schema = readHardwareVersion(payload('project.meta').hardware_ir_version, '0.2', 'project.meta.hardware_ir_version');
    rawIR = { ...payload('project.meta'), ...payload('project.docs'), ...payload('project.history'), ...payload('product.overview'), ...payload('product.architecture'), ...payload('product.electrical'), ...payload('product.mech'), ...payload('product.assembly'), ...payload('product.validation') };
    const bom = payload('product.bom');
    if (bom.line_items !== undefined) rawIR.bom = readBOM(bom.line_items, 'product.bom.line_items');
    else if (bom.bom !== undefined) rawIR.bom = readBOM(bom.bom, 'product.bom.bom');
    rawIR.hardware_ir_version = schema;
    source = 'namespace';
    projectId = text(object.object_id);
    revision = String(object.version);
    version = `${schema} / revision ${object.version}`;
  } else {
    version = readHardwareVersion(rawIR.hardware_ir_version, '0.1', `${source}.hardware_ir_version`);
  }
  const ir = readHardwareIR(rawIR, source);
  const metadata = ir.assembly_metadata;
  projectId ||= text(metadata?.project_id);
  const revisionValue = author.revision ?? author.compile_revision ?? metadata?.revision ?? metadata?.compile_revision;
  revision ||= revisionValue === undefined ? undefined : String(revisionValue);
  const artifacts = readArtifacts(root.artifacts !== undefined ? root.artifacts : ir.artifacts, 'artifacts');
  const project: FormProject = { projectId: projectId || undefined, revision,
    agent: text(author.agent ?? author.authoring_agent ?? ir.agent ?? metadata?.source_agent ?? metadata?.agent ?? metadata?.authoring_agent) || undefined,
    hardwareIrVersion: version.split(' / ')[0], ir, source, sourceDocument, artifacts };
  return {
    name: text(root.title, text(ir.overview?.title, filename.replace(/\.json$/i, ''))),
    projectId: projectId || undefined,
    version,
    mechanical: ir.mechanical ?? {},
    cad: ir.cad_model,
    definitions: ir.part_definitions ?? [],
    components: ir.components ?? [], artifacts, project,
  };
}

export function cadFileReference(cad: unknown): string | undefined {
  if (typeof cad === 'string') return cad;
  const source = record(cad);
  for (const key of ['path', 'file_path', 'model_path', 'url', 'file_url', 'download_url', 'filename']) {
    if (typeof source[key] === 'string') return source[key] as string;
  }
  for (const key of ['adapter', 'model', 'payload']) {
    if (source[key]) { const nested = cadFileReference(source[key]); if (nested) return nested; }
  }
}

function meshRecords(cad: unknown): unknown[] | undefined {
  if (Array.isArray(cad)) return cad;
  const source = record(cad);
  if (source.vertices || source.faces) return [source];
  for (const key of ['meshes', 'mesh_payloads', 'render_meshes', 'mesh', 'adapter', 'model', 'payload']) {
    if (source[key]) { const nested = meshRecords(source[key]); if (nested) return nested; }
  }
}

export function importForm(input: unknown, filename: string, digest: string): Asset {
  const doc = readFormDocument(input, filename);
  const id = `form-${digest}`;
  const parts: Part[] = [];
  const warnings: string[] = [];
  const placements = doc.mechanical.component_placements;
  const represented = new Set<string>();
  const meshes = meshRecords(doc.cad);
  if (meshes?.length) {
    for (const [index, value] of meshes.entries()) {
      const mesh = record(value);
      const ref = text(mesh.ref_des, doc.components.some(c=>c.ref_des===mesh.name) ? String(mesh.name) : '');
      if (ref) represented.add(ref);
      if (!Array.isArray(mesh.vertices) || !Array.isArray(mesh.faces)) throw new Error('CAD meshes require vertices and faces arrays.');
      const source = mesh.vertices.map(v => finite(v, 'CAD vertex'));
      const vertices: number[] = [];
      for (let i = 0; i < source.length; i += 3) vertices.push(source[i] / 1000, source[i + 2] / 1000, -source[i + 1] / 1000);
      parts.push({ id: `${id}/mesh/${index}`, name: text(mesh.name, `CAD part ${index + 1}`), vertices,
        indices: mesh.faces.map(v => finite(v, 'CAD face')), metadata: { representation: 'CAD mesh', ref, sourceId: text(mesh.shapeId ?? mesh.shape_id ?? mesh.id) } });
    }
  }
  if (!meshes?.length || (represented.size > 0 && Array.isArray(placements) && placements.some(p=>!represented.has(p.ref_des)))) {
    if (Array.isArray(placements) && placements.length) {
      for (const item of placements) {
        const ref = text(item.ref_des);
        if (represented.has(ref)) continue;
        if (!ref) throw new Error('Each mechanical placement needs a ref_des.');
        const component = doc.components.find(c => c.ref_des === ref);
        const definition = doc.definitions.find(d => d.part_definition_id === component?.part_definition_id) ?? component;
        const size = vector(item.size, `${ref} size`, true);
        const position = vector(item.position, `${ref} position`);
        const rotation = item.orientation_deg ?? {};
        const angles = (['x_deg', 'y_deg', 'z_deg'] as const).map(key => finite(rotation[key] ?? 0, `${ref} ${key}`) * Math.PI / 180);
        const geometry = new BoxGeometry(...size);
        geometry.applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(angles[0], angles[1], angles[2], 'XYZ')));
        geometry.translate(...position);
        geometry.rotateX(-Math.PI / 2);
        geometry.scale(0.001, 0.001, 0.001);
        parts.push({ id: `${id}/placement/${ref}`, name: text(item.label, text(definition?.name, ref)),
          vertices: Array.from(geometry.attributes.position.array), indices: Array.from(geometry.index!.array),
          metadata: { ref, category: text(item.category, text(definition?.category)), layer: text(item.layer),
            partNumber: text(definition?.part_number), representation: 'Approximate component envelope' } });
        geometry.dispose();
      }
      warnings.push('Showing approximate component envelopes from Form mechanical placements, not fabrication-ready CAD surfaces.');
    } else if (doc.mechanical.render_dimensions) {
      const geometry = new BoxGeometry(...vector(doc.mechanical.render_dimensions, 'render_dimensions', true));
      geometry.rotateX(-Math.PI / 2); geometry.scale(0.001, 0.001, 0.001);
      parts.push({ id: `${id}/envelope`, name: doc.name, vertices: Array.from(geometry.attributes.position.array),
        indices: Array.from(geometry.index!.array), metadata: { representation: 'Approximate overall envelope' } });
      geometry.dispose();
      warnings.push('Only overall dimensions are available. Showing an approximate envelope.');
    }
    if (doc.cad && !meshes?.length) warnings.push('Referenced CAD is unavailable or unsupported. Select its STEP file together with the JSON to resolve local geometry.');
  }
  if (!parts.length) throw new Error('This Form project has no usable geometry. Include its referenced STEP file, inline CAD meshes, or mechanical placements.');
  const hierarchy = { id: `${id}/root`, name: doc.name, partIds: [], children: parts.map(part => ({ id: part.id, name: part.name, partIds: [part.id], children: [] })) };
  return finalizeAsset({ id, name: doc.name, source: { kind: 'form', filename, digest, projectId: doc.projectId, version: doc.version }, parts,
    formProject: doc.project,
    hierarchy, warnings });
}
