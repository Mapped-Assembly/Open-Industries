/** Trusted local file bridge; MCP arguments never accept arbitrary filesystem paths. */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalSceneBackend } from '../server/local-scene-backend.ts';
import { parseCloudBundle } from '../src/lib/cloud-storage.ts';
import { loadEnv } from './session.mjs';

loadEnv(process.cwd());
const [command, input, output, revisionText] = process.argv.slice(2);
if (!input || !['import-asset', 'export'].includes(command) || (command === 'export' && !output))
  throw new Error('Usage: node --import tsx cli/local-scenes.ts import-asset asset.json | export SCENE_UUID scene.json [REVISION]');
const revision = revisionText === undefined ? undefined : Number(revisionText);
if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('Revision must be a positive integer.');
const backend = new LocalSceneBackend(resolve(process.env.ASTRA_SCENE_DATA_DIR || '.astra/scenes'));
try {
  if (command === 'import-asset') {
    if ((await stat(input)).size > 25 * 1024 * 1024) throw new Error('Asset bundle exceeds 25 MiB.');
    const asset = parseCloudBundle(await readFile(input, 'utf8')).asset;
    console.log(JSON.stringify({ kind: 'local', version_id: await backend.persistAsset(asset) }));
  } else {
    await writeFile(output, JSON.stringify(await backend.exportScene(input, revision)), { flag: 'wx', mode: 0o600 });
    console.log(`Exported ${input} to ${output}`);
  }
} finally { backend.close(); }
