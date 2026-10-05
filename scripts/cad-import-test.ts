import assert from 'node:assert/strict';
import { ImportService } from '../src/lib/imports';
import { readFormDocument } from '../src/lib/form';
import { digestBytes } from '../src/lib/scene';
import type { StepResult } from '../src/lib/step';

// Bytes identify which selected file was converted; real OCCT coverage lives in
// test:form-workflows and the browser suite. These tests isolate file resolution.
const converter = async (bytes: ArrayBuffer): Promise<StepResult> => ({
  success: true, root: { name: 'Assembly', meshes: [0], children: [] },
  meshes: [{ name: new TextDecoder().decode(bytes), attributes: { position: { array: [0, 0, 0, 10, 0, 0, 0, 10, 0] } }, index: { array: [0, 1, 2] } }],
});
function file(name: string, contents: string, relativePath = ''): File {
  const result = new File([contents], name);
  Object.defineProperty(result, 'webkitRelativePath', { value: relativePath });
  return result;
}
const fixture = (cad: unknown = 'cad/enclosure.step', artifacts: unknown[] = []) => ({ format: 'form-project', version: 1,
  project_ir: { hardware_ir_version: '0.2', overview: { title: 'Enclosure' },
    mechanical: { render_dimensions: { x_mm: 10, y_mm: 10, z_mm: 10 } }, cad_model: cad }, artifacts });
const manifest = (data: unknown, path = '') => file('form-project.json', JSON.stringify(data), path);
const options = { upAxis: 'Z' as const, scale: 1 };
const open = (files: File[]) => new ImportService(converter).files(files, options, () => {});
const hash = await digestBytes(new TextEncoder().encode('intended').buffer);
const declared = [{ path: 'cad/enclosure.step', sha256: hash }];
const data = fixture('cad/enclosure.step', declared);
let checks = 0;
for (const [jsonPath, reference, cadPath] of [
  ['', 'cad/enclosure.step', 'cad/enclosure.step'],
  ['Root/form-project.json', 'cad/enclosure.step', 'Root/cad/enclosure.step'],
  ['Root/nested/project/form-project.json', 'cad/enclosure.step', 'Root/nested/project/cad/enclosure.step'],
  ['Root\\nested\\form-project.json', '.\\cad\\enclosure.step', 'Root\\nested\\cad\\enclosure.step'],
  ['Root/form-project.json', './cad//./enclosure.step', 'Root/cad/enclosure.step'],
]) {
  const correct = file('enclosure.step', 'intended', cadPath);
  const distractor = file('enclosure.step', 'wrong-folder', 'Root/other/enclosure.step');
  const input = manifest(fixture(reference, declared), jsonPath);
  for (const order of [[distractor, input, correct], [correct, input, distractor]]) {
    const [asset] = await open(order);
    assert.equal(asset.parts[0].name, 'intended', `Resolved ${reference} from ${jsonPath}`);
    assert.deepEqual(asset.formProject?.artifacts, declared);
    checks++;
  }
}
// Each manifest has its own base directory, even in one selected tree.
const pair = await open([
  manifest(data, 'Root/A/form-project.json'), manifest(fixture(), 'Root/B/form-project.json'),
  file('enclosure.step', 'second-project', 'Root/B/cad/enclosure.step'),
  file('enclosure.step', 'intended', 'Root/A/cad/enclosure.step'),
]);
assert.deepEqual(pair.map(a => a.parts[0].name), ['intended', 'second-project']);
// Do not substitute another rooted location when the manifest's path is missing.
const [missing] = await open([manifest(data, 'Root/form-project.json'), file('enclosure.step', 'intended', 'Root/other/enclosure.step')]);
assert.match(missing.warnings.join(' '), /Referenced CAD is unavailable/);
assert.match(missing.parts[0].metadata.representation, /envelope/);
// Directory information is unavailable for ordinary multi-file selection.
for (const jsonPath of ['', 'Root/form-project.json']) {
  const [asset] = await open([manifest(data, jsonPath), file('enclosure.step', 'intended')]);
  assert.equal(asset.parts[0].name, 'intended');
}
assert.equal((await open([manifest(data), file('enclosure.step', 'intended', 'selected/cad/enclosure.step')]))[0].parts[0].name, 'intended');
await assert.rejects(open([manifest(data), file('enclosure.step', 'intended'), file('enclosure.step', 'different')]), /Multiple files match/);
await assert.rejects(open([manifest(data, 'Root/form-project.json'),
  file('enclosure.step', 'intended', 'Root/cad/enclosure.step'), file('enclosure.step', 'duplicate', 'Root/cad/enclosure.step')]), /Multiple files match/);
console.log(`PASS ${checks} ordered nested/rooted path cases, isolated project roots, missing siblings and loose-file ambiguity`);

// All declarations are structurally validated, even when no CAD is available.
const invalid = [null, false, true, 0, 1, [], {}, '', 'wrong', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ` ${hash}`, `${hash}\n`];
for (const sha256 of invalid) for (const withCAD of [false, true]) {
  let converted = false;
  const service = new ImportService(async bytes => { converted = true; return converter(bytes); });
  const inputs = [manifest(fixture('cad/enclosure.step', [{ path: 'cad/enclosure.step', sha256 }]))];
  if (withCAD) inputs.push(file('enclosure.step', 'intended'));
  await assert.rejects(service.files(inputs, options, () => {}), /artifacts\[0\].sha256.*64 hexadecimal/);
  assert.equal(converted, false, 'Malformed hashes must fail before tessellation or fallback');
}
for (const sha256 of [hash, hash.toUpperCase(), undefined]) {
  const input = fixture('cad/enclosure.step', [{ path: './cad/enclosure.step', ...(sha256 === undefined ? {} : { sha256 }) }]);
  assert.equal((await open([manifest(input), file('enclosure.step', 'intended')]))[0].parts[0].name, 'intended');
  assert.deepEqual(readFormDocument(input, 'fixture.json').artifacts, input.artifacts, 'Never rewrite author-supplied hash casing');
}
await assert.rejects(open([manifest(fixture('cad/enclosure.step', [{ path: 'cad/enclosure.step', sha256: '0'.repeat(64) }])), file('enclosure.step', 'intended')]), /Integrity check failed.*enclosure.step/);
let conversions = 0;
const cached = new ImportService(async bytes => { conversions++; return converter(bytes); });
const cachedCAD = file('enclosure.step', 'intended');
await cached.files([manifest(data), cachedCAD], options, () => {});
await assert.rejects(cached.files([manifest(fixture('cad/enclosure.step', [{ path: 'cad/enclosure.step', sha256: '0'.repeat(64) }])), cachedCAD], options, () => {}), /Integrity check failed/);
assert.equal(conversions, 1, 'A cached conversion must not bypass a later manifest integrity check');
// Exact declaration wins over other basenames; ambiguous fallback cannot skip integrity.
assert.equal((await open([manifest(fixture('cad/enclosure.step', [...declared, { path: 'other/enclosure.step', sha256: '0'.repeat(64) }])), file('enclosure.step', 'intended')]))[0].parts[0].name, 'intended');
await assert.rejects(open([manifest(fixture('enclosure.step', [...declared, { path: 'other/enclosure.step', sha256: hash }])), file('enclosure.step', 'intended')]), /Ambiguous artifact declarations/);
await assert.rejects(open([manifest(fixture('cad/enclosure.step', [...declared, { path: './cad//enclosure.step', sha256: hash }])), file('enclosure.step', 'intended')]), /Ambiguous artifact declarations/);
// IR-embedded and namespace metadata artifacts must use the same validator.
for (const input of [
  { ...data.project_ir, artifacts: [{ path: 'cad/enclosure.step', sha256: false }] },
  { object_type: 'form.project', object_id: 'bad', version: 1, namespaces: [
    { name: 'project.meta', payload: { artifacts: [{ path: 'cad/enclosure.step', sha256: 'bad' }] } },
    { name: 'product.mech', payload: { mechanical: data.project_ir.mechanical } },
  ] },
]) assert.throws(() => readFormDocument(input, 'invalid.json'), /sha256.*64 hexadecimal/);
console.log(`PASS ${invalid.length * 2} malformed checksum cases, optional/case-insensitive hashes, mismatch and declaration ambiguity`);

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('CAD references must never perform network requests'); }) as typeof fetch;
try {
  for (const reference of ['https://example.invalid/enclosure.step?download=1', '//example.invalid/enclosure.step',
    'file:///server/cad/enclosure.step', '/server/cad/enclosure.step', 'C:\\server\\enclosure.step',
    '\\\\server\\cad\\enclosure.step', '../cad/enclosure.step', 'cad/../../enclosure.step', 'data:model/step,enclosure.step']) {
    const [asset] = await open([manifest(fixture(reference)), file('enclosure.step', 'local-namesake')]);
    assert.match(asset.parts[0].metadata.representation, /envelope/, reference);
    assert.match(asset.warnings.join(' '), /Referenced CAD is unavailable/);
  }
  const incomplete = fixture(); delete (incomplete.project_ir as any).mechanical;
  await assert.rejects(open([manifest(incomplete)]), /no usable geometry/);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS remote, absolute and traversal references remain metadata; missing geometry gives an actionable failure');
