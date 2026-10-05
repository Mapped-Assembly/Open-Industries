import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// This suite creates roles/schemas in a fresh, disposable local database only.
const url = new URL(process.env.OI_GAME_TEST_DATABASE_URL ?? 'http://unset');
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.pathname !== '/oi_game_test') {
  throw new Error('Set OI_GAME_TEST_DATABASE_URL to a fresh local 127.0.0.1/oi_game_test database.');
}
if (!process.env.OI_GAME_PGDATA || !process.env.OI_GAME_PG_BIN) throw new Error('Provide the disposable cluster path and PostgreSQL binary directory.');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
function sql(query) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OI_GAME_PG_BIN + '/psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', url.href], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.stdin.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout); code === 0 ? resolve(output.trim()) : reject(new Error(error.slice(0, 2000) || 'PostgreSQL test query failed'));
    });
    child.stdin.end(query);
  });
}
const json = async query => JSON.parse(await sql(query));
const rpc = (owner, operation, request) => json('begin; set local role authenticated; set local request.jwt.claim.sub=' + quote(owner) +
  '; select public.game_runtime(' + quote(operation) + ',' + quote(JSON.stringify(request)) + '::jsonb); commit;');
const command = () => ({ version: 1, command_id: randomUUID() });
const read = async (owner, id) => (await rpc(owner, 'read', { version: 1, match_id: id })).snapshot;
async function act(owner, id, operation, extra = {}) {
  // Reconcile only this known test action. Unknown outcomes retain the same ID.
  for (let attempt = 0; attempt < 10; attempt++) {
    const snapshot = await read(owner, id);
    try { return await rpc(owner, operation, { ...command(), match_id: id, expected_revision: snapshot.revision, ...extra }); }
    catch (error) { if (!error.message.includes('OI_GAME:CONFLICT')) throw error; }
  }
  throw new Error('Repeated revision conflicts');
}
async function until(query, check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await json(query); if (check(value)) return value; await delay(500); }
  throw new Error('Independent scheduler did not reach the expected state');
}
await sql([
  'create role anon; create role authenticated; create role service_role;',
  'create schema auth; create table auth.users(id uuid primary key);',
  "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;",
  'grant usage on schema public,auth to anon,authenticated,service_role;',
].join('\n'));
const migration = (await readdir('supabase/migrations')).find(path => path.endsWith('_authoritative_game_runtime.sql'));
assert(migration);
await sql(await readFile('supabase/migrations/' + migration, 'utf8'));
await sql(await readFile('supabase/operations/enable-game-scheduler.sql', 'utf8'));
const alice = randomUUID(), bob = randomUUID(), third = randomUUID();
await sql('insert into auth.users values(' + [alice, bob, third].map(quote).join('),(') + ');');
const create = command();
// Distinct PostgreSQL sessions issue the exact same command concurrently.
const twins = await Promise.all([rpc(alice, 'create', create), rpc(alice, 'create', create)]);
assert.deepEqual(twins[0], twins[1]);
const id = twins[0].snapshot.match_id;
const joins = await Promise.allSettled([bob, third].map(owner => rpc(owner, 'join', { ...command(), match_id: id, invite_code: twins[0].invite_code })));
assert.equal(joins.filter(x => x.status === 'fulfilled').length, 1);
assert.equal(joins.filter(x => x.status === 'rejected' && x.reason.message.includes('OI_GAME:NOT_AVAILABLE')).length, 1);
const opponent = joins[0].status === 'fulfilled' ? bob : third;
await sql('update game_private.deposits set copper_g=6000,hdpe_g=3500 where match_id=' + quote(id) + ';');
const pile = twins[0].snapshot.deposits[0].id;
await act(alice, id, 'inspect_deposit', { deposit_id: pile });
// Two independent clients race for the same last pile with different intent IDs.
// Only one can consume the revision; the loser must not mint a second batch.
const collectionRevision = (await read(alice, id)).revision;
const collectionRequests = [command(), command()].map(cmd => ({ ...cmd, match_id: id,
  expected_revision: collectionRevision, deposit_id: pile }));
const collections = await Promise.allSettled(collectionRequests.map(request => rpc(alice, 'collect_deposit', request)));
assert.equal(collections.filter(x => x.status === 'fulfilled').length, 1);
assert.equal(collections.filter(x => x.status === 'rejected' && x.reason.message.includes('OI_GAME:CONFLICT')).length, 1);
const winner = collections.findIndex(x => x.status === 'fulfilled');
const collected = collections[winner].value;
assert.deepEqual(await rpc(alice, 'collect_deposit', collectionRequests[winner]), collected);
assert.equal(Number(await sql('select count(*) from game_private.batches where match_id=' + quote(id))), 1);
const request = { ...command(), match_id: id, expected_revision: collected.snapshot.revision,
  batch_id: collected.snapshot.batches[0].id, machine_id: collected.snapshot.machines[0].id };
const starts = await Promise.all([rpc(alice, 'start_processing', request), rpc(alice, 'start_processing', request)]);
assert.deepEqual(starts[0], starts[1]);
const job = starts[0].snapshot.jobs[0].id;
assert.equal(Number(await sql('select count(*) from game_private.jobs where match_id=' + quote(id))), 1);
// All command connections are closed. Only pg_cron can make this progress.
await until('select to_jsonb(j) from game_private.jobs j where id=' + quote(job), j => j.work_ms > 0);
await promisify(execFile)(process.env.OI_GAME_PG_BIN + '/pg_ctl', ['-D', process.env.OI_GAME_PGDATA, '-m', 'fast', 'restart', '-l', process.env.OI_GAME_PGDATA + '/server.log']);
const finished = await until('select to_jsonb(j) from game_private.jobs j where id=' + quote(job), j => j.state === 'completed');
assert.equal(finished.work_ms, 20000); assert.equal(finished.energy_mj, 10000000);
const after = await read(alice, id);
const outputs = after.batches.filter(b => b.source_job_id === job);
assert.equal(outputs.length, 3);
assert.equal(outputs.find(b => b.output_role === 'conductor').copper_g, 5700);
assert.equal(outputs.find(b => b.output_role === 'insulation').hdpe_g, 3000);
assert.equal(outputs.reduce((n, b) => n + b.copper_g + b.hdpe_g + b.dirt_g, 0), 10000);
assert.deepEqual(await rpc(alice, 'start_processing', request), starts[0]);
assert.equal((await read(opponent, id)).batches.length, 0);
assert(Number(await sql("select count(*) from cron.job_run_details where jobid=(select jobid from cron.job where jobname='oi-game-runtime-v1') and status='succeeded'")) > 0);

// A rejected output insert rolls back input consumption, the first output, work
// and energy together. The same durable job can then finish exactly once.
await sql("select cron.unschedule('oi-game-runtime-v1');");
const bs = await read(opponent, id);
await act(opponent, id, 'inspect_deposit', { deposit_id: bs.deposits[0].id });
const bc = await act(opponent, id, 'collect_deposit', { deposit_id: bs.deposits[0].id });
const bj = (await act(opponent, id, 'start_processing', { batch_id: bc.snapshot.batches[0].id, machine_id: bs.machines[0].id })).snapshot.jobs[0].id;
await sql([
  "create function game_private.reject_fixture_output() returns trigger language plpgsql set search_path='' as $$ begin if new.output_role='insulation' then raise exception 'fixture output failure'; end if; return new; end $$;",
  'create trigger reject_fixture_output before insert on game_private.batches for each row execute function game_private.reject_fixture_output();',
  'update game_private.jobs set last_tick_ms=game_private.now_ms()-30000 where id=' + quote(bj) + ';',
].join('\n'));
const ledgerQuery = 'select jsonb_build_object(' +
  "'job',(select to_jsonb(j) from game_private.jobs j where id=" + quote(bj) + '),' +
  "'machine',(select to_jsonb(m) from game_private.machines m where id=" + quote(bs.machines[0].id) + '),' +
  "'batches',(select jsonb_agg(to_jsonb(b) order by b.id) from game_private.batches b where owner_id=" + quote(opponent) + '))';
const before = await json(ledgerQuery);
await assert.rejects(sql('select game_private.advance(' + quote(id) + ');'), /fixture output failure/);
assert.deepEqual(await json(ledgerQuery), before);
await sql('drop trigger reject_fixture_output on game_private.batches; drop function game_private.reject_fixture_output(); select game_private.tick();');
await sql('select game_private.tick();');
const recovered = await read(opponent, id);
assert.equal(recovered.batches.length, 4); assert.equal(recovered.jobs[0].state, 'completed');
await assert.rejects(sql("set role authenticated; select game_private.tick();"), /permission denied/);
await assert.rejects(sql("set role authenticated; select * from game_private.deposits;"), /permission denied/);
await assert.rejects(sql("set role authenticated; update game_private.batches set copper_g=10000;"), /permission denied/);
await assert.rejects(sql("set role anon; select public.game_runtime('read','{}');"), /permission denied/);
console.log('PASS real PostgreSQL: concurrent command/join/finite-collection sessions, autonomous pg_cron progress, database process restart, exactly-once completion, transaction fault rollback, hidden-state and write ACLs.');
