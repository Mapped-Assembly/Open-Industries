import { BatchSchema, BALANCE_VERSION } from '@openindustries/material-science/schema';
import { calculateProcess } from '@openindustries/material-science/engine';

/** Cold, modeled starter-cell operations; these neither grant machines nor manufacture parts. */
export const recoveryVersion = 'starter-recovery-v1';
const definitions = [
  ['bench-recover-steel', 'steel', 'stock', 9000, 49, 50, null],
  ['bench-trim-hdpe', 'hdpe', 'stock', 9000, 9, 10, null],
  ['bench-sort-glass', 'glass', 'granulate', 9000, 19, 20, null],
  ['bench-cut-tire', 'rubber', 'tread', 9000, 9, 10, null],
  ['isolate-appliance', 'steel', 'stock', 6000, 19, 20, 'appliance'],
  ['isolate-vehicle', 'aluminum', 'stock', 6000, 19, 20, 'vehicle'],
];
export const recoveryRecipes = () =>
  definitions.map(([id, target, form, minimumPurityBps, numerator, denominator]) => ({
    id,
    version: BALANCE_VERSION,
    target,
    inputForms: ['mixed', 'scrap', ...(target === 'hdpe' ? ['flakes'] : [])],
    minimumPurityBps,
    machine: 'starter-recovery-cell',
    minimumTemperatureC: null,
    powerW: 500,
    millisecondsPerKg: 2000,
    outputs: [{ id: 'usable', form, routes: [{ material: target, numerator, denominator }] }],
    basis: 'game-balance-fixture',
  }));
export const isRecoveryRecipe = (id) => definitions.some((d) => d[0] === id);
const rejection = (code, message, nextActions) => ({
  status: 'ineligible',
  code,
  message,
  nextActions,
});
/** Preview uses only paid evidence and installed starter equipment, never caller-supplied grades. */
export function recoveryPlan(player, batch, id, match) {
  const definition = definitions.find((d) => d[0] === id);
  if (!definition) return null;
  const material = BatchSchema.parse(batch.material);
  if (
    material.inspection !== 'graded' ||
    material.condition === 'unknown' ||
    material.hazard === 'unknown'
  )
    return {
      status: 'needs-inspection',
      code: 'NEEDS_INSPECTION',
      message: 'Complete a paid bench inspection before choosing a recovery route.',
      nextActions: ['inspect-at-bench'],
    };
  if (material.condition !== 'sound')
    return rejection(
      'DAMAGED_MATERIAL',
      'The established condition is outside this recovery fixture.',
      ['choose-compatible-input-or-process'],
    );
  const origin = match?.world.deposits.find((d) => d.id === batch.source_deposit_id)?.kind;
  const isolation = definition[6];
  if (isolation) {
    if (origin !== isolation || material.hazard !== 'suspect-battery' || batch.recovery_rule)
      return rejection(
        'UNSUPPORTED_ISOLATION',
        'Use the matching inspected, unsorted appliance or vehicle load; quarantined residue has no further starter route.',
        ['retain-isolated-material', 'choose-compatible-input-or-process'],
      );
  } else if (material.hazard !== 'none-detected')
    return rejection(
      'ISOLATE_COMPONENT',
      'Battery-suspect and mixed-electronic loads cannot enter ordinary recovery.',
      ['inspect-at-bench', 'use-supported-isolation-route'],
    );
  if (
    !isolation &&
    (!material.grade ||
      ![`game-${definition[1]}-feedstock-v1`, `game-${definition[1]}-v1`].includes(material.grade))
  )
    return {
      status: 'needs-inspection',
      code: 'UNSUPPORTED_GRADE',
      message: 'Establish a compatible feedstock class with the paid bench test.',
      nextActions: ['inspect-at-bench'],
    };
  if (!isolation && material.constituents.some((c) => c.material === 'unknown'))
    return rejection(
      'UNKNOWN_CONSTITUENTS',
      'Unknown constituents require a supported isolation route; ordinary recovery is refused.',
      ['retain-isolated-material'],
    );
  if (definition[1] === 'glass' && origin !== 'glass')
    return rejection(
      'INCOMPATIBLE_GLASS',
      'This starter fixture accepts only the inspected compatible-glass waste family.',
      ['retain-unclassified-glass', 'choose-compatible-input-or-process'],
    );
  const bench = player.base.assets.find((a) => a.kind === 'bench'),
    separator = player.base.assets.find((a) => a.id === player.machine.id);
  const machine = {
    kind: 'starter-recovery-cell',
    enabled:
      bench?.status === 'ready' &&
      separator?.status === 'ready' &&
      player.machine.status === 'ready',
    availablePowerW: player.machine.power_w,
    availableEnergyJ: Math.floor(player.machine.energy_mj / 1000),
    maximumTemperatureC: 20,
  };
  // Only the explicitly supported cold isolation fixture bypasses the ordinary hazard refusal.
  // All non-target constituents remain in suspect residue; no unknown material becomes metal.
  const plan = calculateProcess(
    isolation ? { ...material, hazard: 'none-detected' } : material,
    recoveryRecipes().find((r) => r.id === id),
    machine,
  );
  return plan.status === 'eligible' && !plan.outputs.length
    ? rejection(
        'INSUFFICIENT_INPUT',
        'No whole gram of usable output can be recovered from this input.',
        ['retain-residue', 'choose-compatible-input-or-process'],
      )
    : plan;
}
/** Preserve origin and quarantine through separation, cancellation, reinspection and restart. */
export function recoveryOutputMetadata(plan, input, stream) {
  if (!isRecoveryRecipe(plan.recipeId)) return {};
  return {
    recovery_rule: recoveryVersion,
    recovery_recipe: plan.recipeId,
    source_deposit_id: input.source_deposit_id ?? null,
    hazard_truth: stream.id === 'residue' ? (input.material.hazard ?? 'unknown') : 'none-detected',
  };
}
/** Bounded game-grade fixtures are paid observations, not real material certifications. */
export function recoveryInspection(batch, material, match) {
  const origin = match.world.deposits.find((d) => d.id === batch.source_deposit_id)?.kind;
  if (material.hazard !== 'none-detected' || material.condition !== 'sound') return;
  const rows = material.constituents,
    primary = rows.find((c) => c.material !== 'dirt' && c.material !== 'unknown');
  if (!primary) return;
  const family = { construction: 'steel', packaging: 'hdpe', glass: 'glass', tire: 'rubber' }[
    origin
  ];
  if (
    !batch.recovery_rule &&
    (family === primary.material ||
      (primary.material === 'hdpe' &&
        batch.form === 'flakes' &&
        batch.output_role === 'insulation')) &&
    primary.massG * 10000 >= material.massG * 9000
  )
    material.grade = `game-${primary.material}-feedstock-v1`;
  if (
    batch.recovery_rule !== recoveryVersion ||
    batch.output_role !== 'usable' ||
    rows.length !== 1
  )
    return;
  const expected = {
    steel: 'stock',
    aluminum: 'stock',
    hdpe: 'stock',
    glass: 'granulate',
    rubber: 'tread',
  }[primary.material];
  if (material.form !== expected) return;
  material.grade = `game-${primary.material}-v1`;
  const prop = (kind, value, unit, lower, upper, validFromC = 20, validToC = 20) => ({
    kind,
    value,
    unit,
    validFromC,
    validToC,
    uncertainty: { lower, upper },
    basis: 'measurement-fixture',
    source: `bench-v1/${recoveryVersion}/${primary.material}-fixture`,
  });
  if (primary.material === 'steel')
    material.properties = [prop('yieldStrength', 250, 'MPa', 225, 275)];
  if (primary.material === 'aluminum')
    material.properties = [prop('yieldStrength', 120, 'MPa', 100, 140)];
  if (primary.material === 'hdpe')
    material.properties = [prop('maxServiceTemperature', 80, 'degC', 70, 90, 20, 70)];
}
