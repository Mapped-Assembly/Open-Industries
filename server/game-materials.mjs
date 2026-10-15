import { randomUUID } from 'node:crypto';
import { BatchSchema, ComponentSchema, ObservationSchema, CATALOG_VERSION, BALANCE_VERSION } from '@openindustries/material-science/schema';
import { evaluateUse, evaluateSubstitution, evaluateComponent, planProcess, projectBatch } from '@openindustries/material-science/engine';
import { listMaterials, listRecipes, listParts, listSubstitutions } from '@openindustries/material-science/catalog';
import { ResultSchema } from '@openindustries/material-science/protocol';
import { contentsOf, grams } from './game-robots.mjs';

export const scienceVersions = { catalog: CATALOG_VERSION, recipes: BALANCE_VERSION, sensors: 'bench-v1' };
export const catalog = () => ({ versions: scienceVersions, materials: listMaterials(), recipes: listRecipes(), parts: listParts(), substitutions: listSubstitutions(),
  scope: 'bounded-game-rules-not-engineering-certification', inspection: { duration_ms: 3000, power_w: 100, energy_j: 300 } });
export const constituents = b => ['copper', 'hdpe', 'dirt', 'steel', 'aluminum', 'glass', 'rubber', 'unknown'].filter(k => contentsOf(b)[k] > 0).map(material => ({ material, massG: contentsOf(b)[material] }));
export function materialBatch(b, inspected = false) {
  return BatchSchema.parse({ id: b.id, catalogVersion: CATALOG_VERSION, massG: grams(contentsOf(b)),
    constituents: constituents(b), form: b.form, inspection: inspected ? 'graded' : b.field_collected ? 'uninspected' : 'identified', grade: null,
    condition: inspected ? 'sound' : 'unknown', hazard: inspected ? b.hazard_truth ?? 'none-detected' : 'unknown', properties: [] });
}
export function initializeScience(match) {
  match.science ??= { ...scienceVersions };
  for (const p of match.players) {
    p.observations ??= [];
    // These records reference stock already allocated in starter_ledger; never bulk material credits.
    p.components ??= p.base.inventory.map(c => ComponentSchema.parse({ id: randomUUID(), owner: p.owner, location: 'store', kind: c.kind,
      quantity: c.quantity, unitMassG: c.unit_mass_g, condition: 'unknown', tested: false, compatibleAssemblies: [], allocation: 'component-only', revision: 1 }));
    for (const b of p.batches) {
      b.material ??= materialBatch(b, b.form === 'cable' && !!b.observation_id);
      b.material_revision ??= 1;
    }
  }
}
export const availableMachine = p => ({ kind: p.machine.kind, enabled: p.machine.status === 'ready', availablePowerW: p.machine.power_w,
  availableEnergyJ: Math.floor(p.machine.energy_mj / 1000), maximumTemperatureC: null });
export function processPlan(p, batch, recipe) {
  if (p.jobs.some(j => j.state === 'running' || j.state === 'paused')) return ResultSchema.parse({ status: 'ineligible', code: 'MACHINE_BUSY', message: 'Finish or cancel the current job before starting another process.', nextActions: ['finish-or-cancel-current-job'] });
  return ResultSchema.parse(planProcess(batch.material, recipe, availableMachine(p)));
}
export function processOutputs(plan) {
  const streams = [...plan.outputs, ...(plan.residue.massG ? [{ ...plan.residue, id: 'residue', form: 'residue' }] : [])];
  return streams.map(s => ({ output_role: s.id, form: s.form, contents: Object.fromEntries(s.constituents.map(c => [c.material, c.massG])), ...Object.fromEntries(['copper', 'hdpe', 'dirt'].map(k => [`${k}_g`, s.constituents.find(c => c.material === k)?.massG ?? 0])) }));
}
export function scienceProjection(match, p) {
  return { versions: match.science, observations: p.observations, components: p.components,
    batches: p.batches.map(b => ({ id: b.id, revision: b.material_revision, evidence: projectBatch(b.material) })) };
}
export function inspectAtBench(match, p, job, now) {
  const isComponent = job.kind === 'component-inspection';
  const target = isComponent ? p.components.find(c => c.id === job.input_batch_id) : p.batches.find(b => b.id === job.input_batch_id);
  const bench = p.base.assets.find(a => a.kind === 'bench');
  if (!target || !bench) throw new Error('INSPECTION_TARGET_MISSING');
  if (isComponent) {
    target.tested = true; target.condition = 'sound'; target.compatibleAssemblies = ['starter-maintenance-v1']; target.revision++;
    ComponentSchema.parse(target);
  } else {
    target.state = 'available'; target.material = materialBatch(target, true); target.material_revision++;
    // A deterministic sensor/game-grade fixture, not pure-element data or a claim about real scrap.
    if (target.form === 'wire' && contentsOf(target).copper === target.material.massG) {
      target.material.grade = 'game-copper-v1';
      target.material.properties = [
        { kind: 'electricalConductivity', value: 47000000, unit: 'S/m', validFromC: 20, validToC: 20, uncertainty: { lower: 45000000, upper: 49000000 }, basis: 'measurement-fixture', source: 'bench-v1/copper-wire-test-fixture' },
        { kind: 'density', value: 8950, unit: 'kg/m3', validFromC: 20, validToC: 20, uncertainty: { lower: 8800, upper: 9100 }, basis: 'measurement-fixture', source: 'bench-v1/copper-wire-test-fixture' },
      ];
    }
    BatchSchema.parse(target.material);
  }
  const observation = ObservationSchema.parse({ id: randomUUID(), owner: p.owner, targetId: target.id,
    targetRevision: isComponent ? target.revision : target.material_revision, targetKind: isComponent ? 'component' : 'batch', sensorVersion: match.science.sensors,
    timestampMs: now, position: bench.position, evidence: isComponent ? 'component-function' : 'composition-condition',
    uncertaintyMeaning: 'bounded-game-fixture-not-hardware-accuracy', properties: isComponent ? [] : target.material.properties });
  p.observations.push(observation);
  if (!isComponent) target.observation_id = observation.id;
}
export function evaluateScience(p, args, fail) {
  const component = args.query === 'component';
  const target = (component ? p.components : p.batches).find(b => b.id === args.target_id);
  if (!target) return fail('NOT_AVAILABLE');
  let result;
  if (!component && target.state !== 'available') result = { status: 'ineligible', code: 'BATCH_UNAVAILABLE', message: 'Choose an available batch; reserved or consumed material cannot be reused.', nextActions: ['read-current-state'] };
  else if (component) result = evaluateComponent(target, args.design_id);
  else if (args.query === 'use') result = evaluateUse(target.material, args.design_id, args.temperature_c);
  else if (args.query === 'substitution') result = evaluateSubstitution(target.material, args.design_id, args.temperature_c);
  else result = processPlan(p, target, args.design_id);
  return ResultSchema.parse(result);
}
