/** Validate tileset structure and every GLB using independent pinned validators. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Validators } from '3d-tiles-validator';
import gltfValidator from 'gltf-validator';

const directory = path.resolve(process.argv[2] ?? 'public/export');
const evidence = path.resolve(process.argv[3] ?? 'evidence');
await mkdir(evidence, { recursive: true });
const tiles = await Validators.validateTilesetFile(path.join(directory, 'tileset.json'));
await writeFile(path.join(evidence, 'tileset-validation.json'), tiles.serialize());
let errors = tiles.numErrors;
const glbs = [];
const tileset = JSON.parse(await readFile(path.join(directory, 'tileset.json'), 'utf8'));
const uris = [...new Set(tileset.root.children.map(t => t.content.uri))].sort();
for (const name of uris) {
  const bytes = await readFile(path.join(directory, name));
  const report = await gltfValidator.validateBytes(new Uint8Array(bytes), { uri: name });
  errors += report.issues.numErrors;
  glbs.push({ name, ...report });
}
await writeFile(path.join(evidence, 'gltf-validation.json'), JSON.stringify(glbs, null, 2));
const report = { state: errors ? 'failed' : 'passed', errors, tilesetWarnings: tiles.numWarnings,
  glbCount: glbs.length, gltfWarnings: glbs.reduce((n, r) => n + r.issues.numWarnings, 0),
  validators: { '3d-tiles-validator': '0.6.1', 'gltf-validator': gltfValidator.version() },
  node: process.version, notes: 'Core glTF validator may report metadata extensions as unsupported; retain all diagnostics.' };
await writeFile(path.join(evidence, 'validation-summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (errors) process.exitCode = 1;
