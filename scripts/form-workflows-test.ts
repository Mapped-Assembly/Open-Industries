import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { importForm, readFormDocument } from '../src/lib/form.ts';
import { ImportService } from '../src/lib/imports.ts';
import { scrubPortableData } from '../src/lib/portable-data.mjs';
import { appendAssets, emptyWorkspace, makeManifest, readManifest, hydrateManifest, evaluateWorkspace } from '../src/lib/workspace.ts';
import { createWorld } from '../src/lib/world.ts';
import type { StepResult } from '../src/lib/step.ts';

const root = 'scripts/fixtures/form-workflows';
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const provenance = json('provenance.json');
assert.equal(provenance.native_agent_apps_executed, false);
assert.equal(provenance.live_provider_calls, false);
const captured = readdirSync(root, { recursive: true }).filter(p => /\.(json|step|svg|mmd)$/.test(String(p)) && p !== 'provenance.json').sort();
assert.deepEqual(Object.keys(provenance.files).sort(), captured);
for (const [path, digest] of Object.entries(provenance.files)) {
  assert.equal(hash(readFileSync(join(root, path))), digest, `Capture changed without updating provenance: ${path}`);
  if (path.endsWith('.json')) assert.deepEqual(json(path), scrubPortableData(json(path)), `Unsanitized capture: ${path}`);
}
const requests = json('compile-requests.json');
assert.deepEqual(requests.map((r: any) => r.params.name), ['forma.compile_project', 'forma.compile_project']);
assert.deepEqual(requests.map((r: any) => r.params.arguments.authoring_agent), ['opencode', 'codex']);

const occt = await createRequire(import.meta.url)('occt-import-js')();
let conversions = 0;
const importer = new ImportService(async bytes => {
  conversions++;
  return occt.ReadStepFile(new Uint8Array(bytes), {
    linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: .001, angularDeflection: .3,
  }) as StepResult;
});
const options = { upAxis: 'Y' as const, scale: 10 }; // Form must ignore standalone STEP settings.
const file = (path: string, relativePath?: string) => {
  const result = new File([readFileSync(join(root, path))], path.split('/').pop()!);
  if (relativePath) Object.defineProperty(result, 'webkitRelativePath', { value: relativePath });
  return result;
};
const inputFile = (value: unknown) => new File([JSON.stringify(value)], 'forma-project.json');
const open = (inputs: File[]) => importer.files(inputs, options, () => {});
let variants = 0;
for (const agent of ['sdk', 'opencode', 'codex']) {
  const expectedIR = json(`${agent}/${agent === 'sdk' ? 'project-ir.json' : 'compiled-project.json'}`);
  const rawIR = expectedIR.project_ir ?? expectedIR;
  for (const filename of agent === 'sdk' ? ['project-ir.json', 'project-object.json'] : ['forma-project.json', 'compiled-project.json', 'project-object.json']) {
    const input = json(`${agent}/${filename}`), before = structuredClone(input);
    const doc = readFormDocument(input, filename);
    assert.equal(doc.project.agent, agent); assert.equal(doc.project.revision, agent === 'sdk' ? '3' : '1');
    assert.equal(doc.projectId, rawIR.assembly_metadata.project_id); assert.equal(doc.project.hardwareIrVersion, '0.2');
    assert.deepEqual(doc.project.sourceDocument, input);
    for (const key of ['part_definitions', 'nets', 'validation', 'assembly_metadata', 'mechanical', 'project_version_history', 'cad_model']) {
      const expected = doc.project.source === 'namespace' ? input.namespaces.map((n: any) => n.payload).find((p: any) => Object.hasOwn(p, key))?.[key] : rawIR[key];
      assert.deepEqual((doc.project.ir as any)[key], expected, `${agent}/${filename}: retained ${key}`);
    }
    if (doc.project.source !== 'namespace') assert.deepEqual(doc.project.ir, rawIR);
    else {
      const electrical = input.namespaces.find((n: any) => n.name === 'product.electrical').payload;
      const bom = input.namespaces.find((n: any) => n.name === 'product.bom').payload;
      assert.deepEqual(doc.components, electrical.components);
      assert.deepEqual(doc.project.ir.bom, bom.line_items);
    }
    const [asset] = await open([file(`${agent}/${filename}`)]);
    assert.equal(asset.parts.length, agent === 'sdk' ? 5 : 2);
    assert(asset.parts.every(p => p.metadata.ref));
    assert.deepEqual(input, before);
    const original = structuredClone(asset);
    const workspace = appendAssets(emptyWorkspace(), [asset]);
    workspace.items[0].position = [2, .5, -1]; workspace.items[0].rotation = [0, 45, 0];
    const world = createWorld([asset], workspace.room, 0, 0, evaluateWorkspace(workspace.items, workspace.animation, null));
    try {
      assert.deepEqual(world.groups[0].position.toArray(), [2, .5, -1]);
      assert.deepEqual(world.groups[0].children.map(m => m.userData.partId), asset.parts.map(p => p.id));
    } finally { world.dispose(); }
    const reopened = hydrateManifest(readManifest(makeManifest(workspace, true)), []);
    assert.deepEqual(reopened.items[0].asset, asset); assert.deepEqual(reopened.items[0].position, [2, .5, -1]);
    assert.deepEqual(asset, original, 'Layout edits must not rewrite compiled hardware');
    variants++;
  }
  if (agent !== 'sdk') {
    const input = json(`${agent}/authored-ir-0.1.json`);
    assert.equal(readFormDocument(input, 'input.json').project.hardwareIrVersion, '0.1');
    assert.equal(importForm(input, 'input.json', 'legacy').parts.length, 2);
    assert.equal(rawIR.hardware_ir_version, '0.2', 'The real compiler migrates legacy inputs');
    assert.equal(rawIR.part_definitions.length, 2); assert.equal(rawIR.bom.length, 2);
    for (const artifact of json(`${agent}/forma-project.json`).artifacts) {
      assert.equal(hash(readFileSync(join(root, agent, artifact.path))), artifact.sha256, `${agent}/${artifact.path} integrity`);
    }
  }
}
const legacy = json('sdk/project-ir-0.1.json');
const [legacyAsset] = await open([file('sdk/project-ir-0.1.json')]);
assert.equal(legacyAsset.formProject!.hardwareIrVersion, '0.1');
assert.equal(legacyAsset.formProject!.agent, 'sdk');
assert.equal(legacyAsset.formProject!.revision, '1');
assert.deepEqual(legacyAsset.formProject!.ir, legacy);
assert.equal(legacyAsset.parts.length, 5);
assert(legacy.components.every((c: any) => c.quantity >= 1 && Array.isArray(c.pins)));
assert.equal(legacy.part_definitions, undefined, 'Historical compiler retains the aggregate 0.1 model');
variants++;
const manifest = json('opencode/forma-project.json');
const cad = file('opencode/models/block.step', 'models/block.step');
const [asset] = await open([file('opencode/forma-project.json'), cad, new File(['not a project'], 'validation.json')]);
assert.equal(asset.parts.length, 1); assert.equal(conversions, 1);
assert.equal(asset.parts[0].metadata.representation, 'STEP CAD surface');
assert.deepEqual(asset.dimensions.map(n => Math.round(n * 1000)), [100, 40, 60]);
assert.deepEqual(asset.formProject!.artifacts, manifest.artifacts);
assert.deepEqual(asset.formProject!.ir, manifest.project_ir);
const [again] = await open([file('opencode/forma-project.json'), cad]);
assert.equal(conversions, 1, 'A repeated source uses converted geometry');
assert.deepEqual(again.parts, asset.parts);
const [missing] = await open([file('opencode/forma-project.json')]);
assert.equal(missing.parts.length, 2); assert(missing.warnings.some(w => w.includes('Referenced CAD is unavailable')));
const other = file('opencode/models/block.step', 'other/block.step');
assert.equal((await open([file('opencode/forma-project.json'), other, cad]))[0].id, asset.id, 'Exact path beats duplicate basenames');
await assert.rejects(open([inputFile(manifest), other, file('opencode/models/block.step', 'third/block.step')]), /Multiple files match/);
await assert.rejects(open([inputFile(manifest), new File(['corrupt'], 'block.step')]), /Integrity check failed.*block.step/);
const badDeclaration = structuredClone(manifest); badDeclaration.artifacts.push(badDeclaration.artifacts[0]);
await assert.rejects(open([inputFile(badDeclaration), cad]), /Ambiguous artifact declarations/);
const upper = structuredClone(manifest); upper.artifacts[0].sha256 = upper.artifacts[0].sha256.toUpperCase();
assert.equal((await open([inputFile(upper), cad]))[0].parts.length, 1);
const remote = structuredClone(manifest); remote.project_ir.cad_model = 'https://example.invalid/block.step';
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('Imports must not fetch remote artifacts'); }) as typeof fetch;
try { assert.equal((await open([inputFile(remote)]))[0].parts.length, 2); } finally { globalThis.fetch = originalFetch; }
const mixed = (await open([file('codex/forma-project.json')]))[0];
assert(!mixed.warnings.some(w => w.includes('Referenced CAD is unavailable')));
assert.deepEqual(mixed.parts.map(p => [p.metadata.ref, p.metadata.representation]), [['BASE', 'CAD mesh'], ['TOP', 'Approximate component envelope']]);
const failures: [string, (value: any) => void, RegExp][] = [
  ['unsupported IR', m => { m.project_ir.hardware_ir_version = '0.3'; }, /hardware_ir_version/],
  ['unsupported manifest', m => { m.version = 2; }, /manifest version/],
  ['incomplete manifest', m => { delete m.project_ir; }, /missing project_ir/],
  ['no geometry', m => { delete m.project_ir.cad_model; delete m.project_ir.mechanical; }, /no usable geometry/],
  ['invalid placement', m => { m.project_ir.mechanical.component_placements[0].size.x_mm = -1; }, /size.x_mm/],
  ['invalid compiler revision', m => { m.project_ir.assembly_metadata.compile_revision = {}; }, /compile_revision/],
  ['invalid compiler agent', m => { m.project_ir.assembly_metadata.authoring_agent = false; }, /authoring_agent/],
];
for (const [label, mutate, error] of failures) {
  const value = structuredClone(manifest); mutate(value);
  await assert.rejects(open([inputFile(value)]), error, label);
}
await assert.rejects(open([new File(['{'], 'forma-project.json')]), /not valid JSON/);
console.log(`PASS ${variants} captured workflow outputs; real OCCT CAD, integrity, fallback, ambiguity, legacy migration, retained namespaces, stable scene identities and actionable failures`);
