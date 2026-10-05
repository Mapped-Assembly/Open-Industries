import { createHmac, randomBytes, randomUUID } from 'node:crypto';

export const worldVersions = { catalog: 'dump-catalog-v1', balance: 'dump-world-v1', sensors: 'cable-assay-v1', map: 'municipal-dump-v1' };
export const depositKinds = ['cable', 'appliance', 'packaging', 'vehicle', 'glass', 'tire', 'construction'];
const point = (slot, x, y) => ({ x: slot === 1 ? x : 96 - x, y });
const parts = (...rows) => rows.map(([kind, quantity, unit_mass_g]) => ({ kind, quantity, unit_mass_g }));
const equipment = [
  ['tower', 'Reclamation tower', 8, 24, parts(['steel-frame', 1, 80000], ['control-unit', 1, 1000])],
  ['robot', 'Scavenger 01', 13, 27, parts(['chassis', 1, 8000], ['motor', 2, 800], ['wheel', 2, 400], ['robot-battery', 1, 2000], ['camera', 1, 100], ['depth-sensor', 1, 100], ['controller', 1, 200])],
  ['robot', 'Scavenger 02', 13, 31, parts(['chassis', 1, 8000], ['motor', 2, 800], ['wheel', 2, 400], ['robot-battery', 1, 2000], ['camera', 1, 100], ['depth-sensor', 1, 100], ['controller', 1, 200])],
  ['solar', 'Solar generator', 6, 35, parts(['solar-panel', 1, 12000], ['charge-controller', 1, 500])],
  ['battery', '20 kJ process battery', 9, 35, parts(['process-battery', 1, 5000])],
  ['bench', 'Inspection bench', 8, 16, parts(['bench-frame', 1, 12000], ['cable-assay-kit', 1, 1000])],
  ['fabricator', 'Fabricator', 8, 11, parts(['fabricator-frame', 1, 25000], ['drive', 1, 2000], ['controller', 1, 200])],
  ['separator', 'Cable separator', 14, 16, parts(['separator-frame', 1, 15000], ['motor', 1, 800], ['cutting-head', 1, 2000])],
];
export function starterBase(slot, machineId, towerId) {
  const assets = equipment.map(([kind, label, x, y, components]) => ({ id: kind === 'separator' ? machineId : kind === 'tower' ? towerId : randomUUID(), kind, label, position: point(slot, x, y), components: structuredClone(components), status: kind === 'robot' || kind === 'fabricator' ? 'parked' : 'ready' }));
  const inventory = parts(['fastener', 20, 10], ['repair-plate', 4, 250], ['insulated-wire', 10, 100]);
  const ledger = [...assets.flatMap(a => a.components.map(c => ({ ...c, allocation_id: a.id }))), ...inventory.map(c => ({ ...c, allocation_id: 'store' }))];
  return { id: randomUUID(), assets, inventory, starter_ledger: ledger, ready_to_finish: false,
    power: { solar_w: 100, capacity_mj: 20000000, initial_mj: 20000000, generated_mj: 0, spilled_mj: 0 } };
}
export function makeWorld(players = []) {
  const seed = randomBytes(32).toString('hex');
  let counter = 0;
  const draw = () => createHmac('sha256', seed).update(String(counter++)).digest()[0];
  const deposits = [1, 2].flatMap(slot => depositKinds.map((kind, i) => {
    const copper = 5000 + draw() * 8;
    return { id: randomUUID(), kind, home_slot: slot, position: point(slot, i === 0 ? 19 : 24 + (i % 2) * 10, i === 0 ? 13 : 5 + i * 6),
      truth: kind === 'cable' ? { copper_g: copper, hdpe_g: 9500 - copper, dirt_g: 500 } : { mass_g: 20000 + draw() * 100, components: [{ id: randomUUID(), kind: `${kind}-unsorted`, condition: 'uninspected' }] } };
  }));
  // Preserve every existing cable ID, assay, batch and recipe on v2 upgrades.
  for (const p of players) { const d = deposits.find(d => d.kind === 'cable' && d.home_slot === p.slot); d.id = p.deposit.id; d.truth = { copper_g: p.deposit.copper_g, hdpe_g: p.deposit.hdpe_g, dirt_g: p.deposit.dirt_g }; }
  return { seed, versions: { ...worldVersions }, width: 96, height: 56, deposits,
    roads: [{ x: 4, y: 22, width: 88, height: 4 }, { x: 42, y: 4, width: 12, height: 48 }],
    obstacles: [1, 2].flatMap(slot => [8, 42].map(y => ({ id: randomUUID(), kind: 'scrap-wall', x: slot === 1 ? 39 : 55, y, width: 2, height: 9 }))),
    outposts: [10, 42].map(y => ({ id: randomUUID(), label: 'Neutral reclamation outpost', position: { x: 48, y }, owner_slot: null })),
    towers: [1, 2].map(slot => ({ id: randomUUID(), slot, position: point(slot, 8, 24) })),
  };
}
export function worldProjection(match) {
  const w = match.world;
  return { versions: w.versions, width: w.width, height: w.height, roads: w.roads, obstacles: w.obstacles, outposts: w.outposts,
    towers: w.towers.map(t => ({ ...t, occupied: match.players.some(p => p.slot === t.slot) })),
    deposits: w.deposits.map(d => ({ id: d.id, kind: d.kind, home_slot: d.home_slot, position: d.position,
      depleted: match.players.some(p => p.deposit.id === d.id && p.deposit.collected) })),
  };
}
export function provisionPlayer(owner, slot, world) {
  const d = world.deposits.find(d => d.kind === 'cable' && d.home_slot === slot);
  const machine = { id: randomUUID(), kind: 'cable-separator', status: 'ready', power_w: 500, energy_mj: 20000000, dissipated_mj: 0 };
  return { owner, slot, deposit: { id: d.id, collected: false, observation: null, ...d.truth }, machine, batches: [], jobs: [],
    base: starterBase(slot, machine.id, world.towers.find(t => t.slot === slot).id) };
}
