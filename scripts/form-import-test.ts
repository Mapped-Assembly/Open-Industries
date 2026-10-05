import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importForm, readFormDocument } from '../src/lib/form.ts';
import { ImportService } from '../src/lib/imports.ts';
import { scrubPortableData } from '../src/lib/portable-data.mjs';
import { appendAssets, emptyWorkspace, makeManifest, readManifest, hydrateManifest } from '../src/lib/workspace.ts';

const fixtures = ['0.1', '0.2'].map(version => JSON.parse(readFileSync(`scripts/fixtures/form-import/hardware-ir-${version}.json`, 'utf8')));
function namespace(ir: typeof fixtures[number], object_type = 'form.project') {
  const { hardware_ir_version, overview, components, part_definitions, nets, bom, validation, mechanical, assembly, assembly_metadata, artifacts, system_architecture, ...docs } = ir;
  return { object_type, object_id: 'import-fixture', version: 7, namespaces: [
    { name: 'project.meta', payload: { hardware_ir_version, assembly_metadata, artifacts } },
    { name: 'product.overview', payload: { overview } },
    { name: 'product.architecture', payload: { system_architecture } },
    { name: 'product.electrical', payload: { components, ...(part_definitions ? { part_definitions } : {}), nets } },
    { name: 'product.bom', payload: { line_items: bom } },
    { name: 'product.validation', payload: { validation } },
    { name: 'product.mech', payload: { mechanical } },
    { name: 'product.assembly', payload: { assembly } },
    { name: 'project.docs', payload: docs },
    { name: 'vendor.custom', payload: { retained: true } },
  ] };
}
let variants = 0;
for (const fixture of fixtures) for (const agent of ['sdk', 'opencode', 'codex']) {
  const ir = structuredClone(fixture);
  ir.assembly_metadata.source_agent = agent;
  ir.assembly_metadata.runtime_config = { provider: 'remove-runtime', api_key: 'remove-secret' };
  const manifest = { format: 'form-project', version: 1, project_id: 'import-fixture', revision: 7, agent, project_ir: ir, artifacts: ir.artifacts };
  for (const input of [ir, { project_ir: ir }, { hardware_ir: ir }, manifest,
    { ...manifest, format: 'forma-project' }, { response: manifest }, namespace(ir),
    { project_object: namespace(ir, 'forma.project') }, { response: { project_object: namespace(ir) } }]) {
    const original = structuredClone(input);
    const doc = readFormDocument(input, 'fixture.json');
    assert.equal(doc.project.hardwareIrVersion, ir.hardware_ir_version);
    assert.equal(doc.project.agent, agent); assert.equal(doc.project.revision, '7');
    assert.equal(doc.projectId, 'import-fixture');
    assert.deepEqual(doc.project.ir, scrubPortableData(ir), 'Supported and extension fields must survive import');
    assert.deepEqual(doc.project.sourceDocument, scrubPortableData(input));
    assert.deepEqual(doc.artifacts, ir.artifacts);
    assert.deepEqual(input, original, 'Caller data must not be mutated');
    const asset = importForm(input, 'fixture.json', 'digest');
    assert.deepEqual(asset.dimensions.map(n => Math.round(n * 1000)), [100, 100, 200]);
    assert.equal(asset.parts[0].metadata.ref, 'U1');
    assert.deepEqual(asset.formProject?.ir, doc.project.ir);
    const workspace = appendAssets(emptyWorkspace(), [asset]);
    const reopened = hydrateManifest(readManifest(makeManifest(workspace, true)), []);
    assert.deepEqual(reopened.items[0].asset.formProject, asset.formProject);
    variants++;
  }
}
console.log(`PASS ${variants} version/agent/wrapper variants with complete retained data, normalized geometry and portable round trips`);

// Missing optional sections stay missing; an omitted legacy schema defaults only
// the document descriptor, never rewrites the retained authored IR.
const sparse = { mechanical: { render_dimensions: { x_mm: 10, y_mm: 20, z_mm: 30 } } };
assert.equal(readFormDocument(sparse, 'sparse.json').version, '0.1');
assert.deepEqual(readFormDocument(sparse, 'sparse.json').project.ir, sparse);
assert.equal(importForm(sparse, 'sparse.json', 'sparse').parts.length, 1);
const nullable = { hardware_ir_version: '0.2', overview: null, mechanical: null, validation: null, assembly_metadata: null };
assert.deepEqual(readFormDocument(nullable, 'nullable.json').project.ir, nullable);
assert.throws(() => importForm(nullable, 'nullable.json', 'none'), /no usable geometry/);

const invalidCases: [unknown, RegExp][] = [
  [null, /document/], [[], /document/], [{ response: false }, /response/],
  [{ project_ir: null }, /project_ir/], [{ hardware_ir: [] }, /hardware_ir/],
  [{ format: 'form-project', version: 1 }, /missing project_ir/],
  [{ format: 'forma-project', version: 2 }, /manifest version/],
  [{ format: 'other', version: 1 }, /Unsupported project format/],
  [{ format: ['form-project'], version: 1 }, /Unsupported project format/],
  [{ project_object: null }, /object type|project_object/],
];
for (const version of ['0.3', '', 0.2, null, false]) invalidCases.push([{ ...sparse, hardware_ir_version: version }, /hardware_ir_version/]);
const malformed: [string, unknown, RegExp][] = [
  ['overview', { title: 4 }, /overview.title/], ['components', [{ ref_des: '' }], /components\[0\].ref_des/],
  ['components', [{ ref_des: 'U1', quantity: '2' }], /quantity/],
  ['components', [{ ref_des: 'U1', configuration: [] }], /configuration/],
  ['components', [{ ref_des: 'U1' }, { ref_des: 'U1' }], /Duplicate/],
  ['part_definitions', [{ part_definition_id: 'P', unit_price: -1 }], /unit_price/],
  ['part_definitions', [{ part_definition_id: 'P', pins: [{ pin_id: 1 }] }], /pins\[0\].pin_id/],
  ['bom', [{ quantity: 1.5 }], /quantity/], ['bom', [{ instance_refs: [123] }], /instance_refs\[0\]/],
  ['nets', [{ net_id: 'NET', pins: [{ ref_des: 'U1', pin_id: 2 }] }], /pins\[0\].pin_id/],
  ['validation', { warning: 'bad' }, /validation.warning/], ['validation', { critical: [42] }, /critical\[0\]/],
  ['validation', { info: [{ description: false }] }, /description/],
  ['mechanical', { render_dimensions: { x_mm: 10, y_mm: 10, z_mm: Infinity } }, /z_mm/],
  ['mechanical', { component_placements: [{ ref_des: 'U1', position: {}, size: {} }] }, /position.x_mm/],
  ['assembly_metadata', { revision: {} }, /assembly_metadata.revision/],
  ['assembly_metadata', { source_agent: false }, /source_agent/],
  ['assembly', [{ step_num: 0 }], /step_num/],
  ['system_architecture', { root: { system_id: 'product', children: [42] } }, /children\[0\]/],
  ['mechanical', { motion_intents: [{ type: 'prismatic', target_ref: 'U1', pivot_mm: [0, 0] }] }, /pivot_mm/],
  ['mechanical', { motion_intents: [{ type: 'unknown', target_ref: 'U1' }] }, /type/], ['artifacts', [{ path: 123 }], /artifacts\[0\].path/],
  ['artifacts', [{ path: 'part.step', sha256: false }], /sha256/],
  ['artifacts', [{ path: 'part.step', sha256: '' }], /sha256/],
];
for (const [field, value, message] of malformed) invalidCases.push([{ ...sparse, [field]: value }, message]);
const badNamespace = namespace(fixtures[1]);
badNamespace.namespaces.find(n => n.name === 'product.bom')!.payload = { line_items: 'invalid' };
invalidCases.push([badNamespace, /product.bom.line_items/]);
invalidCases.push([{ ...namespace(fixtures[1]), namespaces: [{ name: 'product.mech', payload: false }] }, /payload/]);
invalidCases.push([{ ...namespace(fixtures[1]), namespaces: [{ name: '', payload: {} }] }, /name/]);
invalidCases.push([{ ...namespace(fixtures[1]), version: '7' }, /revision/]);
const duplicateNamespace = namespace(fixtures[1]); duplicateNamespace.namespaces.push(duplicateNamespace.namespaces[0]);
invalidCases.push([duplicateNamespace, /Duplicate Form namespace/]);
for (const [input, message] of invalidCases) assert.throws(() => readFormDocument(input, 'invalid.json'), message);
console.log(`PASS ${invalidCases.length} actionable malformed/unsupported inputs and optional-field compatibility`);

// Both canonical filenames select the manifest, even alongside unrelated JSON.
const converter = async () => ({ success: true, root: { name: 'CAD', meshes: [0], children: [] }, meshes: [
  { name: 'Sensor CAD', attributes: { position: { array: [0, 0, 0, 10, 0, 0, 0, 10, 0] } }, index: { array: [0, 1, 2] } },
] });
for (const name of ['form-project.json', 'forma-project.json']) {
  const ir = { ...fixtures[1], cad_model: 'sensor.step', artifacts: [] };
  const manifest = { format: name.replace('.json', ''), version: 1, project_ir: ir };
  const inputs = [new File([JSON.stringify(manifest)], name), new File(['not-json'], 'unrelated.json'), new File(['STEP fixture'], 'sensor.step')];
  const result = await new ImportService(converter).files(inputs, { upAxis: 'Y', scale: 10 }, () => {});
  assert.equal(result.length, 1); assert.deepEqual(result[0].formProject?.ir, ir);
  const invalid = structuredClone(manifest); invalid.project_ir.mechanical.component_placements[0].size.x_mm = -10;
  await assert.rejects(() => new ImportService(converter).files([new File([JSON.stringify(invalid)], name), inputs[2]], { upAxis: 'Z', scale: 1 }, () => {}), /size.x_mm/);
}
console.log('PASS legacy/current manifest filenames and validation on companion-CAD path');
