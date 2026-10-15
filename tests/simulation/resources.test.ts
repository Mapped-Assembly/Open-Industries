import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type {
  ResourceContext,
  ResourceLedger,
  ResourceOperation,
} from '../../server/simulation/resource-contracts.js';
import {
  applyResourceOperation,
  createResourceLedger,
  energyForPower,
  resourceTotals,
  splitQuantity,
  validateResourceLedger,
} from '../../server/simulation/resources.mjs';
import { cablePlan } from '../../server/game-sqlite.mjs';
import {
  feedItems,
  resourceContext,
  resourcePolicy,
  ResourceFixture,
  resourceSetup,
} from './resource-fixture.js';

/** The reserve action atomically moves all three constituents into a job-owned holding account. */
function reserve(id = 'reserve-1', job = 1): ResourceOperation {
  return {
    id,
    kind: 'reserve',
    reservation_id: `reservation-${job}`,
    source: 'stock',
    holding: `hold-${job}`,
    items: feedItems(),
  };
}
/** Pure fixture recipe separates half of the copper; every other constituent stays reserved. */
function partial(): ResourceOperation {
  return {
    id: 'partial-1',
    kind: 'use',
    reservation_id: 'reservation-1',
    items: [{ lot_id: 'feed-1', resource_id: 'copper', unit: 'g', quantity: 3000 }],
    lots: [
      {
        id: 'product-1',
        kind: 'product',
        attributes: { grade: 'fixture-copper', contamination: 'clean' },
      },
    ],
    outputs: [
      {
        account_id: 'product',
        lot_id: 'product-1',
        resource_id: 'copper',
        unit: 'g',
        quantity: 3000,
      },
    ],
  };
}
/** Build a real command for shared atomic execution. */
function request(operation: ResourceOperation, revision: number) {
  return {
    command_id: randomUUID(),
    instance_id: 'instance-1',
    expected_revision: revision,
    action: 'resource',
    payload: operation,
  };
}
/** Child processes contend for the same SQLite file independently. */
function writer(path: string, command: unknown): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./resource-writer.ts', import.meta.url)),
        path,
        JSON.stringify(command),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stdout.on('data', (c) => {
      output += c.toString();
    });
    child.stderr.on('data', (c) => {
      errors += c.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(errors));
      else
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
    });
  });
}
/** File-backed integration state, isolated from production databases. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'oi-resources-')),
    path = join(dir, 'state.sqlite'),
    fixture = new ResourceFixture(path);
  fixture.seedResources();
  return {
    path,
    fixture,
    close: async () => {
      fixture.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('reservation, partial output and cancellation conserve each constituent and never refund spent energy', () => {
  let ledger = resourceSetup();
  const opening = resourceTotals(ledger.balances);
  ledger = applyResourceOperation(ledger, resourceContext('reserve'), reserve());
  ledger = applyResourceOperation(ledger, resourceContext('work'), partial(), resourcePolicy);
  ledger = applyResourceOperation(ledger, resourceContext('energy'), {
    id: 'spend-1',
    kind: 'spend',
    source: 'energy',
    destination: 'spent',
    items: [
      {
        lot_id: 'charge-1',
        resource_id: 'energy',
        unit: 'mJ',
        quantity: energyForPower(500, 2000),
      },
    ],
  });
  ledger = applyResourceOperation(ledger, resourceContext('cancel'), {
    id: 'cancel-1',
    kind: 'cancel',
    reservation_id: 'reservation-1',
  });
  assert.deepEqual(resourceTotals(ledger.balances), opening);
  assert.equal(
    ledger.balances.find((b) => b.account_id === 'stock' && b.resource_id === 'copper')?.quantity,
    3000,
  );
  assert.equal(ledger.balances.find((b) => b.account_id === 'product')?.quantity, 3000);
  assert.equal(ledger.balances.find((b) => b.account_id === 'spent')?.quantity, 1000000);
  assert.equal(ledger.balances.find((b) => b.account_id === 'energy')?.quantity, 9000000);
  assert.throws(
    () =>
      applyResourceOperation(
        ledger,
        resourceContext('again'),
        { ...partial(), id: 'partial-2' },
        resourcePolicy,
      ),
    { code: 'RESERVATION_CLOSED' },
  );
  assert.throws(
    () =>
      applyResourceOperation(ledger, resourceContext('refund'), {
        id: 'refund',
        kind: 'transfer',
        source: 'spent',
        destination: 'energy',
        items: [{ lot_id: 'charge-1', resource_id: 'energy', unit: 'mJ', quantity: 1 }],
      }),
    { code: 'INVALID_RESOURCE' },
  );
});

test('cargo, work in progress, outputs, waste and spill remain in the same finite ledger', () => {
  let ledger = resourceSetup();
  const context = resourceContext();
  ledger = applyResourceOperation(ledger, context, {
    id: 'haul',
    kind: 'transfer',
    source: 'stock',
    destination: 'cargo',
    items: feedItems(),
  });
  ledger = applyResourceOperation(
    ledger,
    { ...context, command_id: 'wip' },
    { id: 'wip', kind: 'transfer', source: 'cargo', destination: 'wip', items: feedItems() },
  );
  ledger = applyResourceOperation(
    ledger,
    { ...context, command_id: 'waste' },
    { id: 'waste', kind: 'transfer', source: 'wip', destination: 'waste', items: feedItems() },
  );
  ledger = applyResourceOperation(
    ledger,
    { ...context, command_id: 'spill' },
    {
      id: 'spill',
      kind: 'transfer',
      source: 'energy',
      destination: 'spill',
      items: [{ lot_id: 'charge-1', resource_id: 'energy', unit: 'mJ', quantity: 100 }],
    },
  );
  assert.deepEqual(resourceTotals(ledger.balances), resourceTotals(ledger.opening));
  assert.throws(
    () =>
      applyResourceOperation(
        ledger,
        { ...context, command_id: 'recover' },
        {
          id: 'recover',
          kind: 'transfer',
          source: 'waste',
          destination: 'stock',
          items: feedItems(),
        },
      ),
    { code: 'INVALID_RESOURCE' },
  );
  for (const entry of ledger.entries) {
    assert.equal(entry.context.instance_id, ledger.instance_id);
    assert.equal(entry.context.job_id, 'job-1');
    assert.deepEqual(entry.context.rule, ledger.rule);
    assert(entry.context.command_id);
  }
});

test('rounding preserves remainders, rate/quantity units stay distinct and overflow is explicit', () => {
  assert.deepEqual(splitQuantity(101, 19, 20), { allocated: 95, remainder: 6 });
  assert.equal(energyForPower(500, 20000), 10000000);
  assert.equal(
    splitQuantity(Number.MAX_SAFE_INTEGER, 19, 20).allocated,
    Number((BigInt(Number.MAX_SAFE_INTEGER) * 19n) / 20n),
  );
  assert.throws(() => energyForPower(Number.MAX_SAFE_INTEGER, 2), { code: 'OVERFLOW' });
  for (const value of [-1, NaN, Infinity, 0.5])
    assert.throws(() => energyForPower(value, 1), { code: 'INVALID_RESOURCE' });
  assert.throws(() => splitQuantity(10, 2, 1), { code: 'INVALID_RESOURCE' });
  const ledger = resourceSetup();
  ledger.resources.find((r) => r.id === 'energy')!.unit = 'W' as never;
  assert.throws(() => validateResourceLedger(ledger), { code: 'INVALID_RESOURCE' });
  const wrong = resourceSetup();
  wrong.resources.find((r) => r.id === 'energy')!.unit = 'g';
  assert.throws(() => validateResourceLedger(wrong), { code: 'UNIT_MISMATCH' });
});

test('invalid or incompatible materials, grade claims, units, capacity and transmutation fail without mutation', () => {
  const original = resourceSetup(),
    before = JSON.stringify(original);
  const wrongUnit = reserve();
  if (wrongUnit.kind === 'reserve') wrongUnit.items[0].unit = 'mJ';
  assert.throws(() => applyResourceOperation(original, resourceContext(), wrongUnit), {
    code: 'UNIT_MISMATCH',
  });
  const tiny = resourceSetup();
  tiny.accounts.find((a) => a.id === 'cargo')!.capacities[0].quantity = 9999;
  assert.throws(
    () =>
      applyResourceOperation(tiny, resourceContext(), {
        id: 'overloaded',
        kind: 'transfer',
        source: 'stock',
        destination: 'cargo',
        items: feedItems(),
      }),
    { code: 'CAPACITY_EXCEEDED' },
  );
  assert.throws(
    () =>
      applyResourceOperation(original, resourceContext(), {
        id: 'unsuitable',
        kind: 'transfer',
        source: 'stock',
        destination: 'product',
        items: feedItems(),
      }),
    { code: 'INCOMPATIBLE_RESOURCE' },
  );
  const held = applyResourceOperation(original, resourceContext(), reserve());
  assert.throws(() => applyResourceOperation(held, resourceContext('grade'), partial()), {
    code: 'INCOMPATIBLE_RESOURCE',
  });
  assert.throws(
    () => applyResourceOperation(held, resourceContext('grade'), partial(), () => false),
    { code: 'INCOMPATIBLE_RESOURCE' },
  );
  const changed = partial();
  if (changed.kind === 'use') {
    changed.outputs[0].resource_id = 'polymer';
    changed.outputs[0].account_id = 'waste';
  }
  assert.throws(
    () => applyResourceOperation(held, resourceContext('transmute'), changed, () => true),
    { code: 'CONSERVATION_FAILED' },
  );
  for (const quantity of [-1, NaN, Infinity, 0.1]) {
    const op = reserve();
    if (op.kind === 'reserve') op.items[0].quantity = quantity;
    assert.throws(() => applyResourceOperation(original, resourceContext(), op), {
      code: 'INVALID_RESOURCE',
    });
  }
  assert.equal(JSON.stringify(original), before);
});

test('resource operation IDs are replayable; changed requests, foreign instances/jobs and actors are refused', () => {
  const context = resourceContext(),
    operation = reserve(),
    ledger = applyResourceOperation(resourceSetup(), context, operation);
  assert.deepEqual(
    applyResourceOperation(ledger, { ...context, simulation_time_ms: 3000 }, operation),
    ledger,
  );
  const changed = reserve();
  if (changed.kind === 'reserve') changed.items[0].quantity--;
  assert.throws(() => applyResourceOperation(ledger, context, changed), {
    code: 'OPERATION_ID_REUSED',
  });
  assert.throws(
    () => applyResourceOperation(ledger, { ...context, instance_id: 'foreign' }, operation),
    { code: 'NOT_AVAILABLE' },
  );
  assert.throws(
    () =>
      applyResourceOperation(
        ledger,
        { ...context, job_id: 'other-job', command_id: 'foreign' },
        partial(),
        resourcePolicy,
      ),
    { code: 'NOT_AVAILABLE' },
  );
  assert.throws(
    () =>
      applyResourceOperation(
        ledger,
        { ...context, principal_id: 'bob', command_id: 'foreign' },
        partial(),
        resourcePolicy,
      ),
    { code: 'NOT_AVAILABLE' },
  );
  const tampered = structuredClone(ledger);
  tampered.balances[0].quantity++;
  assert.throws(() => validateResourceLedger(tampered), { code: 'CONSERVATION_FAILED' });
});

test('neutral SQLite workflow preserves reservations, outputs, energy and exact receipts across restart and cancellation', async () => {
  const { fixture, path, close } = await setup();
  try {
    const reserved = request(reserve(), 1),
      result = fixture.run(reserved);
    assert.deepEqual(fixture.run(reserved), result);
    fixture.run(request(partial(), 2));
    const other = new ResourceFixture(path);
    try {
      assert.deepEqual(other.run(reserved), result);
      other.run(request({ id: 'cancel', kind: 'cancel', reservation_id: 'reservation-1' }, 3));
    } finally {
      other.db.close();
    }
    const ledger = fixture.ledger();
    assert.equal(ledger.reservations[0].state, 'cancelled');
    assert.equal(ledger.balances.find((b) => b.account_id === 'spent')?.quantity, 1000000);
    assert.equal(ledger.balances.find((b) => b.account_id === 'product')?.quantity, 3000);
    assert.equal(
      ledger.balances.find((b) => b.account_id === 'stock' && b.resource_id === 'copper')?.quantity,
      3000,
    );
    assert.deepEqual(resourceTotals(ledger.balances), resourceTotals(ledger.opening));
    assert.equal(fixture.read().revision, 4);
  } finally {
    await close();
  }
});

test('independent SQLite clients racing for the last kit cannot both reserve it', async () => {
  const { fixture, path, close } = await setup();
  try {
    const one = reserve('last-kit-1', 1),
      two = reserve('last-kit-2', 2);
    if (one.kind !== 'reserve' || two.kind !== 'reserve') throw new Error('fixture');
    one.items = [{ lot_id: 'kit-1', resource_id: 'kit', unit: 'count', quantity: 1 }];
    two.items = one.items;
    const outcomes = await Promise.all([
      writer(path, request(one, 1)),
      writer(path, request(two, 1)),
    ]);
    assert.equal(outcomes.filter((r) => r.ok).length, 1);
    assert.equal(outcomes.find((r) => !r.ok)?.code, 'CONFLICT');
    const loser = outcomes[0].ok ? two : one;
    assert.throws(() => fixture.run(request(loser, 2)), { code: 'INVALID_TRANSITION' });
    assert.equal(
      fixture
        .ledger()
        .balances.filter((b) => b.resource_id === 'kit')
        .reduce((n, b) => n + b.quantity, 0),
      1,
    );
    assert.equal(fixture.ledger().reservations.length, 1);
  } finally {
    await close();
  }
});

test('failed receipt insertion rolls back ledger changes and output creation', async () => {
  const { fixture, close } = await setup();
  try {
    fixture.run(request(reserve(), 1));
    const before = JSON.stringify(fixture.ledger()),
      command = request(partial(), 2);
    fixture.db.exec(
      "CREATE TRIGGER fail_resource_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'fault'); END;",
    );
    assert.throws(() => fixture.run(command));
    fixture.db.exec('DROP TRIGGER fail_resource_receipt');
    assert.equal(JSON.stringify(fixture.ledger()), before);
    assert.equal(fixture.read().revision, 2);
    fixture.run(command);
    assert.equal(fixture.ledger().balances.find((b) => b.account_id === 'product')?.quantity, 3000);
    assert.equal(fixture.ledger().entries.filter((e) => e.kind === 'use').length, 1);
  } finally {
    await close();
  }
});

test('shared cable splits preserve the original recipe over 256 valid composition fixtures', () => {
  for (let n = 0; n < 256; n++) {
    const copper = 5000 + n * 8,
      hdpe = 9500 - copper,
      plan = cablePlan({ copper_g: copper, hdpe_g: hdpe, dirt_g: 500 });
    assert.equal(plan.outputs[0].copper_g, Math.floor((copper * 19) / 20));
    assert.equal(plan.outputs[1].hdpe_g, Math.floor((hdpe * 6) / 7));
    assert.equal(plan.duration_ms, 20000);
    for (const key of ['copper_g', 'hdpe_g', 'dirt_g'] as const)
      assert.equal(
        plan.outputs.reduce((sum, output) => sum + output[key], 0),
        { copper_g: copper, hdpe_g: hdpe, dirt_g: 500 }[key],
      );
  }
});

test('completed reservations cannot create outputs twice or release already consumed inputs', () => {
  const context = resourceContext();
  let ledger = applyResourceOperation(resourceSetup(), context, reserve());
  const use: ResourceOperation = {
    id: 'full-use',
    kind: 'use',
    reservation_id: 'reservation-1',
    items: feedItems(),
    lots: [
      {
        id: 'product-1',
        kind: 'product',
        attributes: { grade: 'fixture-copper', contamination: 'clean' },
      },
    ],
    outputs: [
      {
        account_id: 'product',
        lot_id: 'product-1',
        resource_id: 'copper',
        unit: 'g',
        quantity: 6000,
      },
      { account_id: 'waste', lot_id: 'feed-1', resource_id: 'polymer', unit: 'g', quantity: 3500 },
      { account_id: 'waste', lot_id: 'feed-1', resource_id: 'dirt', unit: 'g', quantity: 500 },
    ],
  };
  ledger = applyResourceOperation(
    ledger,
    { ...context, command_id: 'complete-work' },
    use,
    resourcePolicy,
  );
  const finish: ResourceOperation = {
    id: 'finished',
    kind: 'complete',
    reservation_id: 'reservation-1',
  };
  ledger = applyResourceOperation(ledger, { ...context, command_id: 'complete' }, finish);
  assert.equal(ledger.reservations[0].state, 'completed');
  assert.throws(
    () =>
      applyResourceOperation(
        ledger,
        { ...context, command_id: 'refund' },
        { id: 'refund', kind: 'cancel', reservation_id: 'reservation-1' },
      ),
    { code: 'RESERVATION_CLOSED' },
  );
  assert.throws(
    () =>
      applyResourceOperation(
        ledger,
        { ...context, command_id: 'duplicate' },
        { ...use, id: 'duplicate' },
        resourcePolicy,
      ),
    { code: 'RESERVATION_CLOSED' },
  );
  assert.deepEqual(resourceTotals(ledger.balances), resourceTotals(ledger.opening));
});

test('neutral production cannot award output without its atomically charged energy cost', async () => {
  const { fixture, close } = await setup();
  try {
    fixture.run(
      request(
        {
          id: 'earlier-use',
          kind: 'spend',
          source: 'energy',
          destination: 'spent',
          items: [{ lot_id: 'charge-1', resource_id: 'energy', unit: 'mJ', quantity: 9500000 }],
        },
        1,
      ),
    );
    fixture.run(request(reserve(), 2));
    const before = JSON.stringify(fixture.ledger());
    assert.throws(() => fixture.run(request(partial(), 3)), { code: 'INVALID_TRANSITION' });
    assert.equal(JSON.stringify(fixture.ledger()), before);
    assert.equal(fixture.read().revision, 3);
    assert.equal(
      fixture.ledger().balances.some((b) => b.account_id === 'product'),
      false,
    );
  } finally {
    await close();
  }
});
