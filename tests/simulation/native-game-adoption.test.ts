import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GameDatabase, canonical } from '../../server/game-sqlite.mjs';
import { gameRulePin } from '../../server/domains/game.mjs';

type NativeFixture = {
  source: string; protocol: number; sqlite_version: number; time: number; tokens: string[];
  tables: Record<string, Record<string, string | number>[]>;
};
/** Restore native rows captured from the documented unmodified v3/v5 runtimes. */
async function restore(version: number, withHistory = false) {
  const fixture: NativeFixture = JSON.parse(await readFile(new URL(`./fixtures/native-v${version}.json`,import.meta.url),'utf8'));
  const dir = await mkdtemp(join(tmpdir(),'oi-native-adopt-')), path = join(dir,'game.sqlite');
  const seed = new GameDatabase(path,{clock:()=>fixture.time});
  seed.transaction(()=>{
    for (const [table,rows] of Object.entries(fixture.tables)) for(const row of rows) {
      const keys=Object.keys(row);
      seed.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));
    }
    seed.db.exec(`PRAGMA user_version=${fixture.sqlite_version}`);
    if(withHistory) {
      const state=JSON.parse(String(fixture.tables.matches[0].state));
      seed.history.initialize({instance_id:state.id,rule:gameRulePin,simulation_time_ms:state.last_advanced_ms,revision:state.revision,state});
    }
  });
  seed.close();
  return {fixture,dir,path};
}
/** Compare exact immutable native receipt bytes, rather than reconstructed responses. */
function receipts(db: DatabaseSync) {return db.prepare('SELECT * FROM receipts ORDER BY owner,command_id').all();}

test('captured native v3 upgrades once, preserves paid work/IDs/receipt bytes and projects pre-upgrade history',async()=>{
  const {fixture,dir,path}=await restore(3,true);
  let db: GameDatabase | undefined;
  try {
    const original=JSON.parse(String(fixture.tables.matches[0].state)), id=original.id;
    db=new GameDatabase(path,{clock:()=>fixture.time});
    const migrated=db.load(id);
    assert.equal(db.db.prepare('PRAGMA user_version').get()!.user_version,4);
    assert.equal(migrated.legacy_recovery,true);
    assert.equal(migrated.robot_version,'robots-v1');
    assert.equal(migrated.world.seed,original.world.seed);
    for (let i=0;i<original.players.length;i++) {
      const before=original.players[i], after=migrated.players[i];
      assert.equal(after.owner,before.owner);
      assert.deepEqual(after.deposit,before.deposit);
      assert.deepEqual(after.jobs,before.jobs);
      assert.deepEqual(after.machine,before.machine);
      assert.deepEqual(after.batches.map(({material,material_revision,...batch}:any)=>batch),before.batches);
      assert.equal(after.observations.length,0);
      assert.equal(after.robots.length,2);
    }
    const stored=receipts(db.db);
    for (const row of fixture.tables.receipts) {
      const ownerToken=fixture.tokens[fixture.tables.accounts.findIndex(a=>a.id===row.owner)];
      const request=JSON.parse(String(row.request));
      assert.deepEqual(db.dispatch(ownerToken,request.name,request.arguments),JSON.parse(String(row.result)));
      assert.throws(()=>db!.dispatch(ownerToken,request.name,{...request.arguments,action:'abandon_match'}),{code:'COMMAND_ID_REUSED'});
    }
    assert.deepEqual(receipts(db.db),stored);
    assert.deepEqual(stored.map(r=>r.result).sort(),fixture.tables.receipts.map(r=>r.result).sort());
    const own=db.historyPage(fixture.tokens[0],{instance_id:id,cursor:null,limit:100});
    assert.equal('field' in db.historicalSnapshot(original,db.identity(fixture.tokens[0])),false);
    assert.equal(own.snapshot.field.version,'robots-v1');
    assert(own.events.some((e:any)=>e.action==='native-v5-upgrade' && e.snapshot.field.version==='robots-v1'));
    const other=JSON.stringify(db.historyPage(fixture.tokens[1],{instance_id:id,cursor:null,limit:100}));
    assert(!other.includes(migrated.players[0].machine.id));
    assert(!other.includes(migrated.world.seed));
    db.transaction(()=>assert.deepEqual(db!.history.replay(id).state,migrated));
    db.close();db=new GameDatabase(path,{clock:()=>fixture.time});
    assert.deepEqual(db.load(id),migrated);
    assert.deepEqual(receipts(db.db),stored);
    assert.throws(()=>db!.dispatch(fixture.tokens[0],'astra.game_create_match',{version:3,command_id:'new-intent'}),{code:'INVALID_REQUEST'});
  }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('captured native v5 retains exact active robot reservations, observations, stock and receipts across cutover/restart',async()=>{
  const {fixture,dir,path}=await restore(5);
  let db: GameDatabase | undefined;
  try {
    const original=JSON.parse(String(fixture.tables.matches[0].state)), id=original.id;
    db=new GameDatabase(path,{clock:()=>fixture.time});
    assert.deepEqual(db.load(id),original);
    const stored=receipts(db.db);
    const command=fixture.tables.receipts.map(r=>({row:r,request:JSON.parse(String(r.request))})).find(r=>r.request.arguments.action==='collect_robot')!;
    const ownerIndex=fixture.tables.accounts.findIndex(a=>a.id===command.row.owner);
    assert.deepEqual(db.dispatch(fixture.tokens[ownerIndex],command.request.name,command.request.arguments),JSON.parse(String(command.row.result)));
    assert.equal(db.load(id).players[0].robot_jobs.at(-1).state,'running');
    const other=JSON.stringify(db.historyPage(fixture.tokens[1],{instance_id:id,cursor:null,limit:100}));
    for(const value of [original.world.seed,original.players[0].machine.id,original.players[0].surveys[0].id,original.players[0].robots[0].id]) assert(!other.includes(value));
    const before=canonical(db.load(id));
    db.historyPage(fixture.tokens[0],{instance_id:id,cursor:null,limit:100});
    assert.equal(canonical(db.load(id)),before);
    db.close();db=new GameDatabase(path,{clock:()=>fixture.time});
    assert.deepEqual(db.load(id),original);
    assert.deepEqual(receipts(db.db),stored);
    db.logout(fixture.tokens[ownerIndex]);
    assert.throws(()=>db!.dispatch(fixture.tokens[ownerIndex],command.request.name,command.request.arguments),{code:'AUTH_REQUIRED'});
  }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('native migration failure rolls back the complete save, version, history and receipts',async()=>{
  const {fixture,dir,path}=await restore(3,true);
  try {
    const seed=new DatabaseSync(path);
    const before=seed.prepare('SELECT * FROM matches').all(), stored=receipts(seed), history=seed.prepare('SELECT * FROM simulation_history').all();
    seed.exec("CREATE TRIGGER migration_fault BEFORE UPDATE ON matches BEGIN SELECT RAISE(ABORT,'migration-fault'); END;");seed.close();
    assert.throws(()=>new GameDatabase(path,{clock:()=>fixture.time}),/restore a compatible backup/);
    const read=new DatabaseSync(path);
    try {
      assert.equal(read.prepare('PRAGMA user_version').get()!.user_version,2);
      assert.deepEqual(read.prepare('SELECT * FROM matches').all(),before);
      assert.deepEqual(receipts(read),stored);
      assert.deepEqual(read.prepare('SELECT * FROM simulation_history').all(),history);
      assert.equal(read.prepare('SELECT count(*) n FROM simulation_events').get()!.n,0);
    }finally{read.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('unknown native robot/material pins fail with a recovery remedy without rewriting state or receipts',async()=>{
  for(const pin of ['robot','science']) {
    const {fixture,dir,path}=await restore(5);
    try {
      const seed=new DatabaseSync(path), state=JSON.parse(String(fixture.tables.matches[0].state));
      if(pin==='robot') state.robot_version='robots-future';else state.science.catalog='future-catalog';
      const text=JSON.stringify(state);
      seed.prepare('UPDATE matches SET state=?').run(text);const stored=receipts(seed);seed.close();
      assert.throws(()=>new GameDatabase(path,{clock:()=>fixture.time}),/exact game module version/);
      const read=new DatabaseSync(path);
      try{assert.equal(read.prepare('SELECT state FROM matches').get()!.state,text);assert.deepEqual(receipts(read),stored);}finally{read.close();}
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});
