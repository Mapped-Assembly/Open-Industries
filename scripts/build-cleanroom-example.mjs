import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCleanroomSamplingAnimation, createDoubledCleanroomAsset } from '../src/lib/cleanroom.ts';
import { hydrateManifest, readManifest } from '../src/lib/workspace.ts';

const path = 'public/examples/cleanroom/cleanroom-suite.json';
const room = JSON.parse(readFileSync(path, 'utf8'));
const architecture = await createDoubledCleanroomAsset();
const architectureIndex = room.bundledAssets.findIndex(asset => asset.id === architecture.id);
if (architectureIndex < 0) throw new Error('Cleanroom scene is missing its architecture asset.');
room.bundledAssets[architectureIndex] = architecture;
Object.assign(room.assets.find(asset => asset.id === architecture.id), {
  name: architecture.name, source: architecture.source, dimensions: architecture.dimensions,
});
const robot = room.instances.find(instance => instance.name === 'Form Swab-Sampling Robot');
if (!robot) throw new Error('Cleanroom scene is missing the Form swab robot instance.');
robot.position = [-3.048, .16, -7.2];
robot.rotation = [0, 90, 0];
room.animation = createCleanroomSamplingAnimation(robot.id);
hydrateManifest(readManifest(room), []);
const sceneText = `${JSON.stringify(room, null, 2)}\n`;
writeFileSync(path, sceneText, 'utf8');
const localPath = '.astra/rooms/7f144c04-c02c-47bc-9373-60c721f0037a.json';
if (existsSync(localPath)) writeFileSync(localPath, sceneText, 'utf8');
console.log(`${room.animation.duration.toFixed(1)}s one-shot mission · ${room.animation.tracks[0].keys.length} robot poses`);
