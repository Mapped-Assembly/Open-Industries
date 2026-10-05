import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { gameTestService } from './lib/game-test-service.ts';
import { startClient } from './lib/mcp-scene-workflows.mjs';

const root = await mkdtemp(join(tmpdir(), 'oi-game-'));
const database = join(root, 'db');
let service = await gameTestService(database);
const alice = randomUUID(), bob = randomUUID(), outsider = randomUUID();
const clients: ReturnType<typeof startClient>[] = [];
const validators = new Map<string, any>();
const command = () => ({ version: 1, command_id: randomUUID() });
async function connect(owner: string, env: Record<string, string> = {}) {
  const config = join(root, owner + '.json');
  await writeFile(config, JSON.stringify(await service.account(owner)));
  const client = startClient({ client: 'game-test', request_ids: 'number' }, { root, timeoutMs: 15000, env: {
    ASTRA_CLI_CONFIG: config, ASTRA_GAME_TOOLS_ENABLED: 'true', VITE_SUPABASE_URL: service.origin,
    VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key', ...env,
  } });
  clients.push(client); return client;
}
async function ok(client: any, name: string, args: unknown) {
  const result = await client.call('game_' + name, args);
  assert(!result.isError, JSON.stringify(result)); const data = result.structuredContent;
  const validate = validators.get(name); assert(validate(data), JSON.stringify(validate.errors));
  assert.deepEqual(JSON.parse(result.content[0].text), data); return data;
}
async function bad(client: any, name: string, args: unknown, code: string) {
  const result = await client.call('game_' + name, args);
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(result.structuredContent.error).sort(), ['code', 'message']);
  assert.equal(result.structuredContent.error.code, code, JSON.stringify(result));
  return result;
}
const read = async (client: any, match_id: string) => (await ok(client, 'read_match', { version: 1, match_id })).snapshot;
async function action(client: any, match_id: string, action: string, target = {}) {
  const snapshot = await read(client, match_id);
  return ok(client, 'command', { ...command(), match_id, expected_revision: snapshot.revision, action, ...target });
}
const advance = async (milliseconds: number) => {
  await service.sql('update game_test_clock set ms=ms+$1', [milliseconds]); await service.tick();
};
async function conservation(match: string) {
  // Consumed inputs are historical records, not inventory. Deposits count once.
  const material = (await service.sql(
    "select p.owner_id,(select coalesce(sum(d.copper_g),0) from game_private.deposits d where d.match_id=p.match_id and d.owner_id=p.owner_id) as initial_copper," +
    "(select coalesce(sum(d.hdpe_g),0) from game_private.deposits d where d.match_id=p.match_id and d.owner_id=p.owner_id) as initial_hdpe," +
    "(select coalesce(sum(d.dirt_g),0) from game_private.deposits d where d.match_id=p.match_id and d.owner_id=p.owner_id) as initial_dirt," +
    "(select coalesce(sum(copper_g),0) from (select copper_g from game_private.deposits where match_id=p.match_id and owner_id=p.owner_id and not collected union all select copper_g from game_private.batches where match_id=p.match_id and owner_id=p.owner_id and state<>'consumed') x) as copper," +
    "(select coalesce(sum(hdpe_g),0) from (select hdpe_g from game_private.deposits where match_id=p.match_id and owner_id=p.owner_id and not collected union all select hdpe_g from game_private.batches where match_id=p.match_id and owner_id=p.owner_id and state<>'consumed') x) as hdpe," +
    "(select coalesce(sum(dirt_g),0) from (select dirt_g from game_private.deposits where match_id=p.match_id and owner_id=p.owner_id and not collected union all select dirt_g from game_private.batches where match_id=p.match_id and owner_id=p.owner_id and state<>'consumed') x) as dirt from game_private.players p where match_id=$1", [match])).rows;
  for (const row of material) {
    assert.equal(row.copper, row.initial_copper); assert.equal(row.hdpe, row.initial_hdpe); assert.equal(row.dirt, row.initial_dirt);
  }
  for (const row of (await service.sql(
    'select x.energy_mj+x.dissipated_mj+coalesce(sum(j.energy_mj),0) as accounted from game_private.machines x left join game_private.jobs j on j.machine_id=x.id where x.match_id=$1 group by x.id', [match])).rows) {
    assert.equal(Number(row.accounted), 20000000);
  }
}
try {
  let a = await connect(alice), b = await connect(bob); const other = await connect(outsider);
  const tools = (await a.rpc('tools/list')).tools; const ajv = new Ajv({ strict: false });
  for (const tool of tools.filter((t: any) => t.name.startsWith('astra.game_'))) {
    // MCP requires an object root even when JSON Schema's oneOf supplies fields.
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.outputSchema.type, 'object');
    validators.set(tool.name.replace('astra.game_', ''), ajv.compile(tool.outputSchema));
  }
  assert.equal(validators.size, 5);
  assert.equal((await a.rpc('initialize')).capabilities.tools instanceof Object, true);
  const contract = await ok(a, 'describe', { version: 1 });
  assert.equal(contract.ready_for_full_game, false); assert(contract.unsupported.includes('combat'));
  await bad(await connect(randomUUID(), { ASTRA_GAME_TOOLS_ENABLED: 'false' }), 'create_match', command(), 'DISABLED');
  await bad(await connect(randomUUID(), { ASTRA_CLI_CONFIG: join(root, 'missing.json') }), 'create_match', command(), 'AUTH_REQUIRED');
  await bad(await connect(randomUUID(), { VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fixture' }), 'create_match', command(), 'AUTH_REQUIRED');
  await bad(a, 'create_match', command(), 'SCHEDULER_UNAVAILABLE');
  assert.equal(Number((await service.sql('select count(*) as n from game_private.matches')).rows[0].n), 0);
  // Only test-admin SQL controls this clock. It is not in any API or production migration.
  await service.sql('create table game_test_clock(ms bigint);');
  await service.sql('insert into game_test_clock values(1000000)');
  await service.sql("create or replace function game_private.now_ms() returns bigint language sql volatile set search_path='' as $$ select ms from public.game_test_clock $$");
  await service.tick();
  for (const value of [{ ...command(), owner_id: outsider }, { ...command(), version: 2 }, { ...command(), command_id: null }, { ...command(), time: 0 }]) {
    await bad(a, 'create_match', value, 'INVALID_REQUEST');
  }
  const create = command(); const created = await ok(a, 'create_match', create); const id = created.snapshot.match_id;
  assert.deepEqual(await ok(a, 'create_match', create), created);
  assert.equal(created.snapshot.players.length, 1);
  assert.equal(created.snapshot.deposits[0].observation, null);
  const invite = { ...command(), match_id: id, invite_code: created.invite_code };
  await bad(a, 'join_match', invite, 'NOT_AVAILABLE');
  await bad(b, 'join_match', { ...invite, invite_code: randomUUID() }, 'NOT_AVAILABLE');
  const joined = await ok(b, 'join_match', invite); assert.equal(joined.snapshot.status, 'active');
  assert.deepEqual(await ok(b, 'join_match', invite), joined);
  await bad(other, 'join_match', { ...invite, ...command() }, 'NOT_AVAILABLE');
  await bad(other, 'read_match', { version: 1, match_id: id }, 'NOT_AVAILABLE');
  await bad(other, 'read_match', { version: 1, match_id: randomUUID() }, 'NOT_AVAILABLE');
  const ad = created.snapshot.deposits[0].id, bd = joined.snapshot.deposits[0].id;
  const am = created.snapshot.machines[0].id, bm = joined.snapshot.machines[0].id;
  await bad(a, 'command', { ...command(), match_id: id, expected_revision: 1, action: 'inspect_deposit', deposit_id: ad }, 'CONFLICT');
  let snapshot = await read(a, id);
  await bad(a, 'command', { ...command(), match_id: id, expected_revision: snapshot.revision, action: 'inspect_deposit', deposit_id: bd }, 'NOT_AVAILABLE');
  await bad(a, 'command', { ...command(), match_id: id, expected_revision: snapshot.revision, action: 'collect_deposit', deposit_id: ad }, 'INSPECTION_REQUIRED');
  const inspected = await action(a, id, 'inspect_deposit', { deposit_id: ad });
  assert.equal(inspected.snapshot.deposits[0].observation.sensor, 'cable-assay-v1');
  // Separate MCP processes race at the same revision. PGlite serializes database
  // transactions; game-postgres-test also exercises real concurrent connections.
  const secondAlice = await connect(alice);
  const collectRequests = [command(), command()].map(cmd => ({ ...cmd, match_id: id,
    expected_revision: inspected.snapshot.revision, action: 'collect_deposit', deposit_id: ad }));
  const collectResults = await Promise.all([a, secondAlice].map((client, i) => client.call('game_command', collectRequests[i])));
  assert.equal(collectResults.filter(result => !result.isError).length, 1);
  assert.equal(collectResults.filter(result => result.structuredContent.error?.code === 'CONFLICT').length, 1);
  const winner = collectResults.findIndex(result => !result.isError);
  const collected = collectResults[winner].structuredContent;
  assert.deepEqual(await ok(a, 'command', collectRequests[winner]), collected);
  assert.equal(collected.snapshot.batches.length, 1);
  const ab = collected.snapshot.batches[0].id;
  await bad(a, 'command', { ...command(), match_id: id, expected_revision: collected.snapshot.revision, action: 'collect_deposit', deposit_id: ad }, 'DEPOSIT_EMPTY');
  await action(b, id, 'inspect_deposit', { deposit_id: bd }); await action(b, id, 'collect_deposit', { deposit_id: bd });
  snapshot = await read(a, id);
  assert(!JSON.stringify(snapshot).includes(bd)); assert(!JSON.stringify(snapshot).includes(bm)); assert(!JSON.stringify(snapshot).includes(bob));
  const start = { ...command(), match_id: id, expected_revision: snapshot.revision, action: 'start_processing', batch_id: ab, machine_id: am };
  for (const extra of [{ grade: 'copper' }, { power_w: 0 }, { outputs: [] }, { owner_id: bob }, { work_ms: 20000 }]) {
    await bad(a, 'command', { ...start, ...extra }, 'INVALID_REQUEST');
    const { action: operation, ...request } = { ...start, ...extra };
    await assert.rejects(service.rpc(alice, operation, request), /OI_GAME:INVALID_REQUEST/);
  }
  await bad(a, 'command', { ...start, machine_id: bm }, 'NOT_AVAILABLE');
  service.loseNextResponse();
  await bad(a, 'command', start, 'OUTCOME_UNKNOWN');
  const started = await ok(a, 'command', start); const firstJob = started.snapshot.jobs[0].id;
  assert.equal(started.snapshot.batches[0].state, 'reserved');
  assert.deepEqual(await ok(a, 'command', start), started);
  await bad(a, 'command', { ...start, expected_revision: start.expected_revision + 1 }, 'COMMAND_ID_REUSED');
  const changed = { ...command(), match_id: id, expected_revision: started.snapshot.revision, action: 'start_processing', batch_id: ab, machine_id: am };
  await bad(a, 'command', changed, 'NOT_READY');
  await advance(4000); await conservation(id);
  const paused = await action(a, id, 'pause_job', { job_id: firstJob });
  assert.equal(paused.snapshot.jobs[0].work_ms, 4000);
  // Resume across a backwards wall-clock correction must not re-credit time.
  await service.sql('update game_test_clock set ms=ms-1000');
  await action(a, id, 'resume_job', { job_id: firstJob });
  await advance(1000); assert.equal((await read(a, id)).jobs[0].work_ms, 4000);
  await action(a, id, 'pause_job', { job_id: firstJob });
  await advance(5000); assert.equal((await read(a, id)).jobs[0].work_ms, 4000);
  await action(a, id, 'resume_job', { job_id: firstJob }); await advance(2000);
  const cancelled = await action(a, id, 'cancel_job', { job_id: firstJob });
  assert.equal(cancelled.snapshot.jobs[0].energy_mj, 3000000);
  assert.equal(cancelled.snapshot.batches[0].state, 'available'); await conservation(id);
  // Dismantling a running machine releases input and accounts for all battery energy.
  const bs = await read(b, id);
  const bj = (await action(b, id, 'start_processing', { batch_id: bs.batches[0].id, machine_id: bm })).snapshot.jobs[0].id;
  await advance(1000);
  const dismantled = await action(b, id, 'dismantle_machine', { machine_id: bm });
  assert.equal(dismantled.snapshot.jobs[0].cancellation_reason, 'machine_destroyed');
  assert.equal(dismantled.snapshot.jobs[0].id, bj);
  assert.equal(dismantled.snapshot.machines[0].energy_mj, 0);
  assert.equal(dismantled.snapshot.machines[0].dissipated_mj, 19500000); await conservation(id);
  const secondStart = { ...command(), match_id: id, expected_revision: (await read(a, id)).revision,
    action: 'start_processing', batch_id: ab, machine_id: am };
  const second = await ok(a, 'command', secondStart);
  const secondJob = second.snapshot.jobs.find((j: any) => j.state === 'running').id;
  // Stop all actual MCP processes, close the DB, then reopen the same durable directory.
  await Promise.all(clients.splice(0).map(c => c.close()));
  await service.close(); service = await gameTestService(database);
  await advance(60000); // Same production scheduler entry point, no connected clients.
  const persisted = (await service.sql('select state,energy_mj from game_private.jobs where id=$1', [secondJob])).rows[0];
  assert.equal(persisted.state, 'completed'); assert.equal(Number(persisted.energy_mj), 10000000);
  a = await connect(alice); b = await connect(bob);
  const complete = await read(a, id);
  assert.equal(complete.batches.filter((x: any) => x.state === 'available').length, 3);
  assert(complete.batches.filter((x: any) => x.form !== 'cable').every((x: any) => x.grade === 'recovered-ungraded'));
  assert.deepEqual(await ok(a, 'command', secondStart), second); // Old receipt never reexecutes.
  await advance(60000); await conservation(id);
  assert.equal((await read(a, id)).batches.length, 4);
  // A changed login is verified again on the same MCP connection.
  await writeFile(join(root, alice + '.json'), JSON.stringify(await service.account(bob)));
  assert.equal((await read(a, id)).machines[0].id, bm);
  await writeFile(join(root, alice + '.json'), JSON.stringify(await service.account(alice)));
  assert.equal((await read(a, id)).machines[0].id, am);
  // Direct RPC callers cannot escape MCP validation or ownership.
  await assert.rejects(service.rpc(null, 'read', { version: 1, match_id: id }), /permission denied/);
  await assert.rejects(service.rpc(outsider, 'read', { version: 1, match_id: id }), /OI_GAME:NOT_AVAILABLE/);
  for (const request of [null, { version: 1, match_id: id, grade: 'certified' }, { version: '1', match_id: id }]) {
    await assert.rejects(service.rpc(alice, 'read', request), /OI_GAME:INVALID_REQUEST/);
  }
  const acl = (await service.sql(
    "select has_table_privilege('authenticated','game_private.batches','INSERT') mint," +
    "has_table_privilege('authenticated','game_private.deposits','SELECT') hidden," +
    "has_function_privilege('authenticated','game_private.tick()','EXECUTE') tick," +
    "has_function_privilege('anon','public.game_runtime(text,jsonb)','EXECUTE') anon," +
    "has_function_privilege('service_role','public.game_runtime(text,jsonb)','EXECUTE') service"
  )).rows[0];
  assert.deepEqual(acl, { mint: false, hidden: false, tick: false, anon: false, service: false });
  assert.equal(Number((await service.sql("select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='game_private' and c.relkind='r' and not c.relrowsecurity")).rows[0].n), 0);
  const reference = (await service.sql('select game_private.plan_cable(6000,3500,500) as plan')).rows[0].plan;
  assert.equal(reference.outputs[0].copper_g, 5700); assert.equal(reference.outputs[1].hdpe_g, 3000);
  assert.equal(reference.outputs[2].copper_g + reference.outputs[2].hdpe_g + reference.outputs[2].dirt_g, 1300);
  for (const row of (await service.sql(
    'select c,h,500 d,game_private.plan_cable(c,h,500) plan from (select 5000+n*8 c,4500-n*8 h from generate_series(0,255) n) inputs'
  )).rows) {
    for (const [key, expected] of [['copper_g', row.c], ['hdpe_g', row.h], ['dirt_g', row.d]] as const) {
      assert.equal(row.plan.outputs.reduce((n: number, o: any) => n + o[key], 0), expected);
      assert(row.plan.outputs.every((o: any) => Number.isInteger(o[key]) && o[key] >= 0));
    }
  }
  // Power depletion: two cancelled attempts spend 18 kJ; last 2 kJ cannot finish.
  const next = await ok(a, 'create_match', command()); const nid = next.snapshot.match_id;
  await ok(b, 'join_match', { ...command(), match_id: nid, invite_code: next.invite_code });
  const nd = next.snapshot.deposits[0].id, nm = next.snapshot.machines[0].id;
  await action(a, nid, 'inspect_deposit', { deposit_id: nd });
  const nb = (await action(a, nid, 'collect_deposit', { deposit_id: nd })).snapshot.batches[0].id;
  for (let i = 0; i < 2; i++) {
    const job = (await action(a, nid, 'start_processing', { batch_id: nb, machine_id: nm })).snapshot.jobs.find((j: any) => j.state === 'running');
    await advance(18000); await action(a, nid, 'cancel_job', { job_id: job.id });
  }
  await action(a, nid, 'start_processing', { batch_id: nb, machine_id: nm }); await advance(30000);
  const starved = (await read(a, nid)).jobs.find((j: any) => j.state === 'paused');
  assert.equal(starved.pause_reason, 'power'); assert.equal(starved.work_ms, 4000);
  await conservation(nid);
  const abandoned = await action(a, nid, 'abandon_match');
  assert.equal(abandoned.snapshot.status, 'abandoned'); assert(!('winner' in abandoned.snapshot));
  assert.equal(abandoned.snapshot.batches[0].state, 'available'); await conservation(nid);
  // Expired invites do not admit another player or consume an open-match slot.
  const expired = await ok(a, 'create_match', command());
  await service.sql("update game_private.matches set invite_expires_at=clock_timestamp()-interval '1 second' where id=$1", [expired.snapshot.match_id]);
  await bad(b, 'join_match', { ...command(), match_id: expired.snapshot.match_id, invite_code: expired.invite_code }, 'NOT_AVAILABLE');
  await service.tick(); assert.equal((await read(a, expired.snapshot.match_id)).status, 'abandoned');
  const waiting = await ok(a, 'create_match', command());
  await ok(a, 'create_match', command()); // Original active match + two waiting = 3.
  await bad(a, 'create_match', command(), 'LIMIT_REACHED');
  await action(a, waiting.snapshot.match_id, 'abandon_match');
  // Backwards database wall-clock changes never create negative progress/energy.
  await service.sql('update game_test_clock set ms=ms-10000'); await service.tick(); await conservation(id);
  await service.sql('update game_private.runtime set last_tick_ms=0');
  await bad(a, 'create_match', command(), 'SCHEDULER_UNAVAILABLE');
  assert.equal((await read(a, id)).scheduler_healthy, false);
  console.log('PASS game MCP: discovery, verified-session boundary, two participants, private inspection, finite collection, atomic retries/lost response, version conflicts, pause/resume/cancel/destruction, durable reopen, conserved constituents/energy, power exhaustion, grants/RLS and 256 recipe partitions.');
} finally {
  await Promise.all(clients.map(c => c.close()));
  await service.close(); await rm(root, { recursive: true, force: true });
}
