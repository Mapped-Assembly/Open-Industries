import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GameDatabase, cablePlan } from '../server/game-sqlite.mjs';
import { startClient } from './lib/mcp-scene-workflows.mjs';

const root = await mkdtemp(join(tmpdir(), 'oi-sqlite-test-'));
const credentials = (username: string) => ({ username, password: 'only-a-test-password-123' });
const command = () => ({ version: 2, command_id: randomUUID() });
const tool = (name: string) => 'astra.game_' + name;
const code = (expected: string) => (error: any) => error?.code === expected;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
let clock = 1000000;
let db = new GameDatabase(join(root, 'unit.sqlite'), { clock: () => clock });
try {
  const a = await db.authenticate(credentials('alice'), true), b = await db.authenticate(credentials('bob'), true), c = await db.authenticate(credentials('outsider'), true);
  await assert.rejects(db.authenticate({ ...credentials('alice'), password: 'wrong-password-123' }), code('AUTH_REQUIRED'));
  const stored = db.db.prepare('SELECT * FROM accounts').all();
  assert(!JSON.stringify(stored).includes(credentials('alice').password));
  assert(!JSON.stringify(db.db.prepare('SELECT * FROM sessions').all()).includes(a.token));
  assert.throws(() => db.dispatch(a.token, tool('create_match'), command()), code('SCHEDULER_UNAVAILABLE'));
  db.tick();
  const creation = command();
  const created = db.dispatch(a.token, tool('create_match'), creation), id = created.snapshot.match_id;
  assert.deepEqual(db.dispatch(a.token, tool('create_match'), creation), created);
  assert.equal(created.snapshot.deposits[0].observation, null);
  const joinArgs = { ...command(), match_id: id, invite_code: created.invite_code };
  const joined = db.dispatch(b.token, tool('join_match'), joinArgs);
  assert.deepEqual(db.dispatch(b.token, tool('join_match'), joinArgs), joined);
  assert.throws(() => db.dispatch(c.token, tool('join_match'), { ...joinArgs, ...command() }), code('NOT_AVAILABLE'));
  assert.throws(() => db.dispatch(c.token, tool('read_match'), { version: 2, match_id: id }), code('NOT_AVAILABLE'));
  assert.throws(() => db.dispatch(a.token, tool('create_match'), { ...command(), owner_id: db.identity(b.token) }), code('INVALID_REQUEST'));
  const read = () => db.dispatch(a.token, tool('read_match'), { version: 2, match_id: id }).snapshot;
  const act = (action: string, targets = {}) => db.dispatch(a.token, tool('command'), { ...command(), match_id: id, expected_revision: read().revision, action, ...targets });
  const deposit = created.snapshot.deposits[0].id, machine = created.snapshot.machines[0].id;
  assert.throws(() => act('collect_deposit', { deposit_id: deposit }), code('INSPECTION_REQUIRED'));
  assert.throws(() => act('inspect_deposit', { deposit_id: joined.snapshot.deposits[0].id }), code('NOT_AVAILABLE'));
  const observed = act('inspect_deposit', { deposit_id: deposit });
  const collect = { ...command(), match_id: id, expected_revision: observed.snapshot.revision, action: 'collect_deposit', deposit_id: deposit };
  const collected = db.dispatch(a.token, tool('command'), collect);
  assert.deepEqual(db.dispatch(a.token, tool('command'), { ...collect }), collected);
  assert.throws(() => db.dispatch(a.token, tool('command'), { ...collect, action: 'inspect_deposit' }), code('COMMAND_ID_REUSED'));
  assert.throws(() => db.dispatch(a.token, tool('command'), { ...collect, ...command() }), code('CONFLICT'));
  const batch = collected.snapshot.batches[0].id;
  let started = act('start_processing', { batch_id: batch, machine_id: machine });
  let job = started.snapshot.jobs[0].id;
  clock += 5000; db.tick();
  const paused = act('pause_job', { job_id: job });
  assert.equal(paused.snapshot.jobs[0].work_ms, 5000);
  clock += 10000; db.tick();
  assert.equal(read().jobs[0].work_ms, 5000);
  act('resume_job', { job_id: job });
  clock += 5000; db.tick();
  act('cancel_job', { job_id: job });
  assert.equal(read().machines[0].energy_mj, 15000000);
  assert.equal(read().batches[0].state, 'available');
  // The result and reservation must roll back together on a real SQLite write fault.
  db.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected fault'); END;");
  assert.throws(() => act('start_processing', { batch_id: batch, machine_id: machine }));
  assert.equal(read().batches[0].state, 'available');
  assert.equal(read().jobs.length, 1);
  db.db.exec('DROP TRIGGER fail_receipt');
  started = act('start_processing', { batch_id: batch, machine_id: machine }); job = started.snapshot.jobs[1].id;
  clock += 1000; db.tick();
  db.close(); db = new GameDatabase(join(root, 'unit.sqlite'), { clock: () => clock });
  clock += 19000; db.tick();
  const completed = read();
  assert.equal(completed.jobs[1].state, 'completed');
  assert.equal(completed.batches.length, 4);
  assert.equal(completed.machines[0].energy_mj, 5000000);
  clock += 30000; db.tick();
  assert.equal(read().batches.length, 4);
  assert.equal(read().machines[0].energy_mj, 5000000);
  for (const key of ['copper_g', 'hdpe_g', 'dirt_g']) assert.equal(completed.batches.filter((v: any) => v.state !== 'consumed').reduce((sum: number, v: any) => sum + v[key], 0), observed.snapshot.deposits[0].observation[key]);
  assert(!JSON.stringify(completed).includes(joined.snapshot.deposits[0].id));
  clock -= 20000; db.tick(); assert.equal(read().machines[0].energy_mj, 5000000);
  act('dismantle_machine', { machine_id: machine });
  assert.equal(read().machines[0].dissipated_mj, 5000000);
  act('abandon_match'); assert.equal(read().status, 'abandoned');
  db.logout(a.token); assert.throws(() => read(), code('AUTH_REQUIRED'));
  for (let i = 0; i < 256; i++) {
    const input = { copper_g: 5000 + i * 8, hdpe_g: 4500 - i * 8, dirt_g: 500 };
    for (const key of ['copper_g', 'hdpe_g', 'dirt_g']) assert.equal(cablePlan(input).outputs.reduce((sum: number, v: any) => sum + v[key], 0), input[key]);
  }
  // Stale scheduler blocks new work; expired invites and sessions cannot revive.
  clock += 16000;
  assert.throws(() => db.dispatch(b.token, tool('create_match'), command()), code('SCHEDULER_UNAVAILABLE'));
  db.tick(); const waiting = db.dispatch(b.token, tool('create_match'), command());
  clock += 3600001; db.tick();
  assert.throws(() => db.dispatch(c.token, tool('join_match'), { ...command(), match_id: waiting.snapshot.match_id, invite_code: waiting.invite_code }), code('NOT_AVAILABLE'));
  clock += 8 * 3600000; db.tick(); assert.throws(() => db.identity(b.token), code('AUTH_REQUIRED'));
  console.log('PASS SQLite transactions, privacy, ownership, retries, rollback, restart, mass/energy accounting, session expiry and 256 material partitions');
} finally { db.close(); }

const database = join(root, 'service.sqlite');
let worker: ReturnType<typeof spawn> | undefined;
let origin = '';
const clients: ReturnType<typeof startClient>[] = [];
async function start() {
  worker = spawn(process.execPath, ['server/game-service.mjs'], { env: { ...process.env, ASTRA_GAME_DB: database, ASTRA_GAME_PORT: '0', ASTRA_GAME_ALLOW_SIGNUP: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stderr?.on('data', () => {});
  origin = await new Promise<string>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('service startup timeout')), 10000);
    worker!.once('exit', () => { clearTimeout(timeout); reject(new Error('service exited')); });
    worker!.stdout?.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(chunk.toString()); if (match) { clearTimeout(timeout); done(match[0]); } });
  });
}
async function stop() { if (worker && worker.exitCode === null) { const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited; } }
async function account(username: string) {
  const response = await fetch(origin + '/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials(username)) });
  assert(response.ok); return (await response.json()).token as string;
}
function connect(token: string) {
  const client = startClient({ client: 'sqlite-runtime-test', request_ids: 'number' }, { root, timeoutMs: 15000,
    env: { ASTRA_GAME_TOOLS_ENABLED: 'true', ASTRA_GAME_SERVICE_URL: origin, ASTRA_GAME_SESSION: token } });
  clients.push(client); return client;
}
async function ok(client: any, name: string, args: unknown) {
  const result = await client.call('game_' + name, args); assert(!result.isError, JSON.stringify(result)); return result.structuredContent;
}
try {
  await start();
  const aToken = await account('alice'), bToken = await account('bob');
  let a = connect(aToken), b = connect(bToken), a2 = connect(aToken);
  const contract = await ok(a, 'describe', { version: 2 });
  assert.equal(contract.persistence, 'sqlite-wal'); assert.equal(contract.ready_for_full_game, false);
  assert.equal((await a.rpc('tools/list')).tools.filter((t: any) => t.name.startsWith('astra.game_')).length, 5);
  const create = command();
  const pair = await Promise.all([ok(a, 'create_match', create), ok(a2, 'create_match', create)]);
  assert.deepEqual(pair[0], pair[1]);
  const created = pair[0], id = created.snapshot.match_id;
  await ok(b, 'join_match', { ...command(), match_id: id, invite_code: created.invite_code });
  const read = async () => (await ok(a, 'read_match', { version: 2, match_id: id })).snapshot;
  const inspected = await ok(a, 'command', { ...command(), match_id: id, expected_revision: (await read()).revision, action: 'inspect_deposit', deposit_id: created.snapshot.deposits[0].id });
  const args = { version: 2, match_id: id, expected_revision: inspected.snapshot.revision, action: 'collect_deposit', deposit_id: created.snapshot.deposits[0].id };
  const race = await Promise.all([a, a2].map(c => c.call('game_command', { ...args, command_id: randomUUID() })));
  assert.equal(race.filter(r => !r.isError).length, 1);
  assert.equal(race.find(r => r.isError).structuredContent.error.code, 'CONFLICT');
  const current = await read();
  await ok(a, 'command', { ...command(), match_id: id, expected_revision: current.revision, action: 'start_processing', batch_id: current.batches[0].id, machine_id: current.machines[0].id });
  await Promise.all(clients.map(c => c.close())); clients.length = 0;
  await delay(1200);
  const inspectDB = new DatabaseSync(database, { readOnly: true });
  const progressed = JSON.parse(inspectDB.prepare('SELECT state FROM matches WHERE id=?').get(id)!.state as string);
  inspectDB.close();
  assert(progressed.players[0].jobs[0].work_ms > 0, 'independent scheduler must advance without clients');
  await stop(); await start();
  // Real service process restart, durable sessions and autonomous completion.
  await delay(20000);
  a = connect(aToken); b = connect(bToken);
  const finished = await read();
  assert.equal(finished.jobs[0].state, 'completed'); assert.equal(finished.batches.length, 4);
  assert.equal(finished.machines[0].energy_mj, 10000000);
  assert.equal((await read()).batches.length, 4);
  assert.deepEqual(await ok(a, 'create_match', create), created, 'receipt survives process restart');
  await fetch(origin + '/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aToken}` }, body: '{}' });
  const revoked = await a.call('game_read_match', { version: 2, match_id: id }); assert.equal(revoked.structuredContent.error.code, 'AUTH_REQUIRED');
  console.log('PASS real SQLite service + MCP: isolated sessions, duplicate commands, concurrent collection, autonomous scheduling, process kill/restart, exactly-once outputs and revocation');
} finally {
  await Promise.all(clients.map(c => c.close())); await stop(); await rm(root, { recursive: true, force: true });
}
