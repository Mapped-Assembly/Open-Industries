import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FieldLabDatabase } from '../server/simulation/field-lab-runtime.js';
import { labDayMs, labState, fieldLabPin } from '../server/domains/field-lab.js';
import { canonicalCommand } from '../server/simulation/commands.mjs';
import { simulate } from '../benchmarks/field-lab/simulate.mjs';

const output = resolve(process.argv[2] ?? 'deliverables/field-lab');
const dir = await mkdtemp(join(tmpdir(), 'oi-durable-field-lab-')),
  path = join(dir, 'lab.sqlite');
let now = 1000,
  db = new FieldLabDatabase(path, { clock: () => now });
try {
  const inputBytes = await readFile(
      new URL('../benchmarks/field-lab/inputs/scenarios.json', import.meta.url),
    ),
    input = JSON.parse(inputBytes.toString());
  let owner = await db.authenticate(
    { username: 'baseline-operator', password: 'synthetic-benchmark-password' },
    true,
  );
  const cases = input.scenarios.map((s: { id: string; changes: object }) => ({
    scenario: s,
    created: db.create(owner.token, {
      command_id: `create-${s.id}`,
      scenario: s.id,
      dispatch: 'automatic',
    }),
  }));
  now += labDayMs;
  db.tick();
  const results = cases.map(
    ({ scenario, created }: { scenario: { id: string; changes: object }; created: any }) => {
      const instance = db.load(created.snapshot.instance_id),
        state = labState(instance),
        reference = simulate(scenario.changes);
      assert.deepEqual(state.timeline, reference.timeline);
      assert.deepEqual(state.blocked, reference.blockedMinutes);
      assert.equal(instance.observations.length, reference.processed);
      return {
        scenario: scenario.id,
        instance_id: instance.id,
        processed: instance.observations.length,
        totals: state.totals,
        timeline: state.timeline,
        state_sha256: createHash('sha256').update(canonicalCommand(instance)).digest('hex'),
      };
    },
  );
  db.close();
  db = new FieldLabDatabase(path, { clock: () => now });
  for (const r of results)
    assert.equal(
      createHash('sha256')
        .update(canonicalCommand(db.load(r.instance_id)))
        .digest('hex'),
      r.state_sha256,
    );
  owner = await db.authenticate({
    username: 'baseline-operator',
    password: 'synthetic-benchmark-password',
  });
  for (const { scenario, created } of cases)
    assert.deepEqual(
      db.create(owner.token, {
        command_id: `create-${scenario.id}`,
        scenario: scenario.id,
        dispatch: 'automatic',
      }),
      created,
    );
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'durable-results.json'),
    JSON.stringify(
      {
        schema: 'field-lab-durable-evidence/v1',
        status: 'passed',
        module: fieldLabPin,
        input_sha256: createHash('sha256').update(inputBytes).digest('hex'),
        storage: 'real-file-backed-sqlite-schema-101',
        evidence_scope:
          'Synthetic modeled baseline and durable restart/receipt replay; no assay, sensor, thermal or physical validation.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS durable FIELD-LAB: all six complete timelines, finite resources, private modeled outputs, file-backed restart and immutable receipts match the frozen baseline.',
  );
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
