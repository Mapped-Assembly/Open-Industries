import { BoxGeometry } from 'three';
import { digestBytes, finalizeAsset, type Asset, type Part } from './scene';
import type { Animation, Keyframe } from './workspace';

export type SamplingWindow = { start: string; end: string };
export type SamplingRoomPlan = {
  room: string;
  requiredSamples: number;
  proposedTimes: SamplingWindow[];
  access: { status: 'available'; window: SamplingWindow } | { status: 'blocked'; reason: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isClockTime = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export function readSamplingPlan(value: unknown): SamplingRoomPlan[] {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error('Sampling plan must contain 1–10 room entries.');
  const rooms = new Set<string>();
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.room !== 'string' || !entry.room.trim() || entry.room.length > 32 || rooms.has(entry.room)
        || !Number.isInteger(entry.requiredSamples) || (entry.requiredSamples as number) < 0 || (entry.requiredSamples as number) > 100
        || !Array.isArray(entry.proposedTimes) || entry.proposedTimes.length > 100 || !isRecord(entry.access)) throw new Error('Invalid sampling room entry.');
    rooms.add(entry.room);
    const proposedTimes = entry.proposedTimes.map(window => {
      if (!isRecord(window) || !isClockTime(window.start) || !isClockTime(window.end) || window.start >= window.end) throw new Error(`Invalid proposed sample time for room ${entry.room}.`);
      return { start: window.start, end: window.end };
    });
    if (entry.access.status === 'available' && isRecord(entry.access.window)
        && isClockTime(entry.access.window.start) && isClockTime(entry.access.window.end) && entry.access.window.start < entry.access.window.end) {
      return { room: entry.room, requiredSamples: entry.requiredSamples as number, proposedTimes,
        access: { status: 'available', window: { start: entry.access.window.start, end: entry.access.window.end } } };
    }
    if (entry.access.status === 'blocked' && typeof entry.access.reason === 'string' && entry.access.reason.trim() && !proposedTimes.length) {
      return { room: entry.room, requiredSamples: entry.requiredSamples as number, proposedTimes: [],
        access: { status: 'blocked', reason: entry.access.reason.trim() } };
    }
    throw new Error(`Invalid access status for room ${entry.room}.`);
  });
}

type GeometryGroup = Pick<Part, 'id' | 'name' | 'color' | 'metadata'> & { vertices: number[]; indices: number[] };

export async function createDoubledCleanroomAsset(): Promise<Asset> {
  const groups: GeometryGroup[] = [
    { id: 'floor', name: 'Cleanroom and corridor floor', color: [.58, .7, .7], metadata: { representation: 'Cleanroom floor' }, vertices: [], indices: [] },
    { id: 'room-floors', name: 'Room floor panels', color: [.82, .86, .83], metadata: { representation: 'Individual room floors' }, vertices: [], indices: [] },
    { id: 'walls', name: 'Insulated cleanroom wall panels', color: [.88, .9, .87], metadata: { representation: 'Cleanroom partitions and perimeter walls' }, vertices: [], indices: [] },
    { id: 'doors', name: 'Cleanroom doors and frames', color: [.28, .46, .49], metadata: { representation: 'Glazed personnel doors and frames' }, vertices: [], indices: [] },
    { id: 'lights', name: 'Ceiling light fixtures', color: [.96, .89, .67], metadata: { representation: 'Cleanroom and corridor luminaires' }, vertices: [], indices: [] },
    { id: 'markings', name: 'Corridor floor markings', color: [.78, .6, .27], metadata: { representation: 'Perimeter corridor guide lines' }, vertices: [], indices: [] },
  ];
  const [floor, roomFloors, walls, doors, lights, markings] = groups;
  function addBox(group: GeometryGroup, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    const geometry = new BoxGeometry(sx, sy, sz);
    geometry.translate(x, y, z);
    const start = group.vertices.length / 3;
    group.vertices.push(...geometry.attributes.position.array);
    group.indices.push(...Array.from(geometry.index!.array, index => index + start));
    geometry.dispose();
  }

  const outer = 12.192;
  const core = 6.096;
  const roomSize = 6.096;
  const floorTop = .16;
  addBox(floor, 0, .08, 0, 24.384, .16, 24.384);
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    const x = -core + col * roomSize;
    const z = -core + row * roomSize;
    addBox(roomFloors, x + roomSize / 2, floorTop + .025, z + roomSize / 2, roomSize - .06, .05, roomSize - .06);
    for (const dx of [-1.5, 1.5]) addBox(lights, x + roomSize / 2 + dx, 2.82, z + roomSize / 2, .9, .07, .32);
  }

  function doorFrame(x: number, z: number, width: number, height: number, thickness: number, alongX: boolean) {
    const jamb = .055;
    for (const offset of [-width / 2 + jamb / 2, width / 2 - jamb / 2]) {
      if (alongX) addBox(doors, x + offset, floorTop + height / 2, z, jamb, height, thickness * 1.4);
      else addBox(doors, x, floorTop + height / 2, z + offset, thickness * 1.4, height, jamb);
    }
    if (alongX) {
      addBox(doors, x, floorTop + height - jamb / 2, z, width, jamb, thickness * 1.4);
      addBox(doors, x, floorTop + height * .49, z + .015, width - .14, height * .94, .045);
    } else {
      addBox(doors, x, floorTop + height - jamb / 2, z, thickness * 1.4, jamb, width);
      addBox(doors, x + .015, floorTop + height * .49, z, .045, height * .94, width - .14);
    }
  }
  function xWall(z: number, x1: number, x2: number, opening: [number, number, number] | null = null, height = 2.72, thickness = .14) {
    if (!opening) { addBox(walls, (x1 + x2) / 2, floorTop + height / 2, z, x2 - x1, height, thickness); return; }
    const [center, width, doorHeight] = opening;
    const leftEnd = center - width / 2;
    const rightStart = center + width / 2;
    if (leftEnd > x1) addBox(walls, (x1 + leftEnd) / 2, floorTop + height / 2, z, leftEnd - x1, height, thickness);
    if (rightStart < x2) addBox(walls, (rightStart + x2) / 2, floorTop + height / 2, z, x2 - rightStart, height, thickness);
    addBox(walls, center, floorTop + (height + doorHeight) / 2, z, width, height - doorHeight, thickness);
    doorFrame(center, z, width, doorHeight, thickness, true);
  }
  function zWall(x: number, z1: number, z2: number, height = 2.88, thickness = .14) {
    addBox(walls, x, floorTop + height / 2, (z1 + z2) / 2, thickness, height, z2 - z1);
  }

  xWall(-core, -core, 0, [-3.048, 1.2, 2.18], 2.88);
  xWall(-core, 0, core, [3.048, 1.2, 2.18], 2.88);
  xWall(core, -core, 0, [-3.048, 1.2, 2.18], 2.88);
  xWall(core, 0, core, [3.048, 1.2, 2.18], 2.88);
  zWall(-core, -core, 0); zWall(-core, 0, core);
  zWall(core, -core, 0); zWall(core, 0, core);
  xWall(0, -core, core, null, 2.88, .16);
  zWall(0, -core, core, 2.88, .16);

  xWall(-outer + .08, -outer + .08, outer - .08, null);
  xWall(outer - .08, -outer + .08, -.95, null);
  xWall(outer - .08, .95, outer - .08, null);
  addBox(doors, 0, floorTop + 1.1, outer - .08, 1.9, 2.2, .12);
  zWall(-outer + .08, -outer + .08, outer - .08, 2.72, .16);
  zWall(outer - .08, -outer + .08, outer - .08, 2.72, .16);

  for (const z of [-9.1, 9.1]) for (const x of [-3, 0, 3]) addBox(lights, x, 2.68, z, 1.15, .07, .42);
  for (const x of [-9.1, 9.1]) for (const z of [-3, 0, 3]) addBox(lights, x, 2.68, z, .42, .07, 1.15);
  for (const x of [-11.1, 11.1]) addBox(markings, x, .17, 0, .045, .012, 22);
  for (const z of [-11.1, 11.1]) addBox(markings, 0, .17, z, 22, .012, .045);

  const parts: Part[] = groups.map(({ vertices, indices, ...part }) => ({ ...part, vertices, indices }));
  const digest = await digestBytes(new TextEncoder().encode(JSON.stringify(parts)).buffer as ArrayBuffer);
  return finalizeAsset({
    id: 'generated-cleanroom-doubled-v1', name: 'Doubled cleanroom architecture',
    source: { kind: 'generated', filename: 'cleanroom-suite-doubled.generated.json', digest, generator: 'form-industries' },
    parts, hierarchy: { id: 'cleanroom-root', name: 'Cleanroom suite', partIds: parts.map(part => part.id), children: [] },
    warnings: ['Procedural architectural visualization only. Verify room clear dimensions, cleanroom classification, egress, HVAC, and construction requirements with qualified professionals.'],
  });
}

export function createCleanroomSamplingAnimation(robotInstanceId: string): Animation {
  const keys: Keyframe[] = [];
  const pose = (time: number, x: number, y: number, z: number, yaw: number) => keys.push({
    id: `cleanroom-robot-key-${keys.length}`, time, position: [x, y, z], rotation: [0, yaw, 0],
  });

  // Timeline seconds map to scheduled minutes from 09:00. Room B is deliberately omitted.
  pose(0, -3.048, .16, -7.2, 90);
  pose(5, -4.2, .21, -5.3, 90);
  pose(5.2, -4.2, .21, -5.16, 90);
  pose(8, -4.2, .21, -5.16, 90);
  pose(8.2, -4.2, .21, -5.3, 90);
  pose(10, -1.9, .21, -5.3, 90);
  pose(10.2, -1.9, .21, -5.16, 90);
  pose(13, -1.9, .21, -5.16, 90);
  pose(13.2, -1.9, .21, -5.3, 90);
  pose(15, -3.048, .16, -7.2, -90);
  pose(30, -9.144, .16, -7.2, 180);
  pose(50, -9.144, .16, 7.2, 90);
  pose(60, -3.048, .16, 7.2, -90);
  pose(65, -4.2, .21, 5.3, -90);
  pose(65.2, -4.2, .21, 5.16, -90);
  pose(68, -4.2, .21, 5.16, -90);
  pose(68.2, -4.2, .21, 5.3, -90);
  pose(70, -1.9, .21, 5.3, -90);
  pose(70.2, -1.9, .21, 5.16, -90);
  pose(73, -1.9, .21, 5.16, -90);
  pose(73.2, -1.9, .21, 5.3, -90);
  pose(75, -3.048, .16, 7.2, 90);
  pose(85, -9.144, .16, 7.2, 180);
  pose(88, -9.144, .16, 9.144, 90);
  pose(103, 9.144, .16, 9.144, 0);
  pose(110, 9.144, .16, 0, -90);

  return { duration: 110, loop: false, tracks: [{ id: `${robotInstanceId}:instance`, instanceId: robotInstanceId, keys }] };
}
