import { copyFile, mkdir } from 'node:fs/promises';
const target = new URL('../public/vendor/', import.meta.url);
await mkdir(target, { recursive: true });
for (const file of ['occt-import-js.js', 'occt-import-js.wasm']) {
  await copyFile(new URL(`../node_modules/occt-import-js/dist/${file}`, import.meta.url), new URL(file, target));
}
