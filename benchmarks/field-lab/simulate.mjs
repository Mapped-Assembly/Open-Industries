import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(resolve(here, relative), 'utf8'));
const input = readJson('./inputs/scenarios.json');
const expected = readJson('./expected/results.json');

export const common = input.baseline;
export const scenarios = input.scenarios;
export const supported = Object.freeze({ minutes: 480, stepMinutes: 15, maxSamples: 24 });

const finiteNonNegative = (value, label) => {
  assert.equal(typeof value, 'number', `${label} must be a number.`);
  assert(Number.isFinite(value), `${label} must be finite.`);
  assert(value >= 0, `${label} must be nonnegative.`);
};

function validateConfig(config) {
  for (const key of [
    'samples', 'minutes', 'stepMinutes', 'batteryCapacityWh', 'batteryWh', 'reserveWh',
    'baseLoadW', 'sampleWh', 'sampleWaterL', 'serviceWaterLPerHour', 'waterL',
    'tips', 'kits', 'waterReserveL', 'solarFactor',
  ]) finiteNonNegative(config[key], key);
  assert(Number.isInteger(config.samples) && config.samples <= supported.maxSamples, 'samples must be an integer from 0 through 24.');
  assert(Number.isInteger(config.tips) && Number.isInteger(config.kits), 'tips and kits must be integers.');
  assert.equal(config.minutes, supported.minutes, `Unsupported time horizon: ${config.minutes} minutes. Only ${supported.minutes} minutes is versioned.`);
  assert.equal(config.stepMinutes, supported.stepMinutes, `Unsupported time step: ${config.stepMinutes} minutes. Only ${supported.stepMinutes}-minute steps are versioned.`);
  assert.equal(config.solarWh.length, config.minutes / 60, 'solarWh must provide one value for every modeled hour.');
  assert(config.solarFactor <= 2, 'solarFactor must be between 0 and 2 for the versioned model.');
  assert(config.batteryWh <= config.batteryCapacityWh, 'batteryWh cannot exceed batteryCapacityWh.');
  assert(config.reserveWh < config.batteryCapacityWh, 'reserveWh must be below batteryCapacityWh.');
  assert(config.sampleWh > 0 && config.sampleWaterL > 0, 'Each sample must consume positive energy and water.');
  assert(config.waterReserveL >= 0, 'waterReserveL must be nonnegative.');
  if (config.deliveryMinute !== null) {
    assert(Number.isInteger(config.deliveryMinute), 'deliveryMinute must be null or an integer.');
    assert(config.deliveryMinute >= 0 && config.deliveryMinute < config.minutes, 'deliveryMinute must fall inside the supported horizon.');
    assert(config.deliveryMinute % config.stepMinutes === 0, 'deliveryMinute must align to the supported step.');
  }
  for (const key of ['tips', 'kits', 'waterL']) finiteNonNegative(config.delivery[key], `delivery.${key}`);
}

const round = (value) => Number(value.toFixed(6));
const cloneConfig = (changes = {}) => ({
  ...structuredClone(common),
  ...structuredClone(changes),
  delivery: { ...structuredClone(common.delivery), ...structuredClone(changes.delivery ?? {}) },
});

export function simulate(changes = {}) {
  const config = cloneConfig(changes);
  validateConfig(config);
  let energy = config.batteryWh;
  let water = config.waterL;
  let tips = config.tips;
  let kits = config.kits;
  let done = 0;
  let delivered = false;
  const ledger = {
    generatedWh: 0, spillWh: 0, baseServedWh: 0, baseUnservedWh: 0, processWh: 0,
    sampleWaterL: 0, serviceWaterL: 0, deliveredWaterL: 0, deliveredTips: 0, deliveredKits: 0,
  };
  const timeline = [];
  const blocked = { kits: 0, tips: 0, water: 0, energy: 0 };

  for (let minute = 0; minute < config.minutes; minute += config.stepMinutes) {
    if (config.deliveryMinute !== null && !delivered && minute >= config.deliveryMinute) {
      water += config.delivery.waterL;
      tips += config.delivery.tips;
      kits += config.delivery.kits;
      ledger.deliveredWaterL += config.delivery.waterL;
      ledger.deliveredTips += config.delivery.tips;
      ledger.deliveredKits += config.delivery.kits;
      delivered = true;
    }
    const generated = config.solarWh[Math.floor(minute / 60)] * config.solarFactor * config.stepMinutes / 60;
    ledger.generatedWh += generated;
    const spill = Math.max(0, energy + generated - config.batteryCapacityWh);
    ledger.spillWh += spill;
    energy = Math.min(config.batteryCapacityWh, energy + generated);
    const base = config.baseLoadW * config.stepMinutes / 60;
    const served = Math.min(energy, base);
    energy -= served;
    ledger.baseServedWh += served;
    ledger.baseUnservedWh += base - served;
    const housekeeping = Math.min(water, config.serviceWaterLPerHour * config.stepMinutes / 60);
    water -= housekeeping;
    ledger.serviceWaterL += housekeeping;

    const arrived = Math.min(config.samples, 6 * (Math.floor(minute / 120) + 1));
    const reasons = [];
    let completed = 0;
    if (done < arrived) {
      if (kits < 1) reasons.push('kits');
      if (tips < 2) reasons.push('tips');
      if (water < config.sampleWaterL + config.waterReserveL - 1e-8) reasons.push('water');
      if (energy < config.sampleWh + config.reserveWh - 1e-8) reasons.push('energy');
      if (!reasons.length) {
        done += 1;
        completed = 1;
        energy -= config.sampleWh;
        water -= config.sampleWaterL;
        tips -= 2;
        kits -= 1;
        ledger.processWh += config.sampleWh;
        ledger.sampleWaterL += config.sampleWaterL;
      } else {
        for (const reason of reasons) blocked[reason] += config.stepMinutes;
      }
    }
    timeline.push({
      minute: minute + config.stepMinutes,
      arrived,
      completed,
      processed: done,
      queued: arrived - done,
      batteryWh: round(energy),
      waterL: round(water),
      tips,
      kits,
      delivered,
      reasons,
    });
    assert(energy >= -1e-8 && water >= -1e-8 && tips >= 0 && kits >= 0, 'negative resource');
  }

  const energyError = config.batteryWh + ledger.generatedWh - energy - ledger.spillWh - ledger.baseServedWh - ledger.processWh;
  const waterError = config.waterL + ledger.deliveredWaterL - water - ledger.sampleWaterL - ledger.serviceWaterL;
  assert(Math.abs(energyError) < 1e-7 && Math.abs(waterError) < 1e-7, 'resource conservation');
  assert.equal(config.tips + ledger.deliveredTips - tips, done * 2);
  assert.equal(config.kits + ledger.deliveredKits - kits, done);

  return {
    config,
    processed: done,
    requested: config.samples,
    completionPct: 100 * done / config.samples,
    remaining: { batteryWh: round(energy), waterL: round(water), tips, kits },
    blockedMinutes: blocked,
    ledger: Object.fromEntries(Object.entries(ledger).map(([key, value]) => [key, round(value)])),
    conservation: { energyErrorWh: round(energyError), waterErrorL: round(waterError) },
    timeline,
  };
}

function assertExpected(result, expectation) {
  assert.equal(result.id, expectation.id);
  assert.equal(result.processed, expectation.processed, `${expectation.id} completion count changed.`);
  assert.equal(result.ledger.baseUnservedWh, expectation.baseUnservedWh, `${expectation.id} base-load shortfall changed.`);
  for (const [key, value] of Object.entries(expectation.remaining)) {
    assert(Math.abs(result.remaining[key] - value) <= expected.tolerance, `${expectation.id} remaining ${key} changed.`);
  }
}

export function benchmark() {
  const results = scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    ...simulate(scenario.changes),
  }));
  assert.equal(results.length, 6, 'FIELD-LAB-01 must contain exactly six versioned scenarios.');
  results.forEach((result, index) => assertExpected(result, expected.results[index]));
  assert.deepEqual(simulate(), simulate(), 'Replay must be deterministic.');
  assert.equal(simulate({ tips: 0, kits: 0, deliveryMinute: null }).processed, 0, 'Zero stock must block processing.');
  assert.throws(() => simulate({ batteryWh: -1 }), /batteryWh must be nonnegative/);
  assert.throws(() => simulate({ stepMinutes: 30 }), /Unsupported time step/);
  assert.throws(() => simulate({ minutes: 1440 }), /Unsupported time horizon/);
  return {
    schema: 'field-lab-benchmark/v1',
    benchmarkId: 'FIELD-LAB-01',
    upstreamRepository: 'https://github.com/Mapped-Assembly/Open-Industries',
    upstreamCommit: '810f182e40011288e6f3280cd34926521481697b',
    scope: 'Synthetic resource accounting harness; not assay, thermal, fluid, robot physics or validated lab capacity.',
    support: supported,
    assumptions: [
      'Fictional rural district; no country-specific claims.',
      '24 generic environmental-water sample jobs arrive in four batches of six.',
      'One job per 15-minute slot; 2 tips, 1 generic assay consumable, 0.35 L water and 12 Wh per job.',
      'Panel curve, battery, housekeeping and loads are scenario assumptions, not measured equipment specifications.',
      'Reserve protects job admission only; critical loads may use it. Base unserved Wh is reported.',
      'A missed delivery shifts beyond the modeled day. Resilience starts with spare stock and sheds 40 W of assumed deferrable load.',
      'The 3D animation illustrates workflow. The numerical model is a separate reproducible harness.',
    ],
    results,
  };
}

if (process.argv[1]?.endsWith('simulate.mjs')) {
  const output = resolve(process.argv[2] ?? resolve(here, '../../../deliverables/field-lab'));
  mkdirSync(output, { recursive: true });
  const result = benchmark();
  writeFileSync(resolve(output, 'field-lab-results.json'), JSON.stringify(result, null, 2));
  writeFileSync(resolve(output, 'simulation-checks.json'), JSON.stringify({
    capability: 'numericalReplay',
    status: 'passed',
    scenarios: result.results.map(({ id, processed, blockedMinutes, ledger, remaining, conservation }) => ({
      id, processed, blockedMinutes, baseUnservedWh: ledger.baseUnservedWh, remaining, conservation,
    })),
    invariants: ['nonnegative resources', 'energy conservation', 'water conservation', 'tips and kits conservation', 'deterministic replay'],
  }, null, 2));
  console.log(JSON.stringify(result.results.map(({ id, processed, blockedMinutes, ledger, remaining }) => ({
    id, processed, blockedMinutes, baseUnservedWh: ledger.baseUnservedWh, remaining,
  })), null, 2));
}
