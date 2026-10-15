import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { BalanceAccount,BalanceContext } from '../../server/simulation/event-runtime-contracts.js';
import type { ResourceUnit,ResourceAllocation } from '../../server/simulation/resource-contracts.js';
import { advanceEventClock } from '../../server/simulation/event-clock.mjs';
import { transitionEventJobs } from '../../server/simulation/event-jobs.mjs';
import { createResourceBalances,settleResourceBalances,validateResourceBalances } from '../../server/simulation/resource-balances.mjs';
import { GameDatabase,canonical } from '../../server/game-sqlite.mjs';
import { VersionedGameDomain } from '../../server/domains/game.mjs';
import { advanceGame,nativeGame,packGame,gameDomainModule,sharedGamePin } from '../../server/domains/game-core.mjs';
import { DomainRegistry } from '../../server/simulation/registry.js';

const pin={module_id:'event-fixture',module_version:'v1',schema_version:1};
const account=(id:string,kind:BalanceAccount['kind']='stock',unit:ResourceUnit='mJ',capacity:number|null=null):BalanceAccount=>({id,kind,owner_id:'alice',job_id:null,unit,capacity});
const allocation=(account_id:string,quantity:number,resource_id='energy',unit:ResourceUnit='mJ'):ResourceAllocation=>({account_id,resource_id,lot_id:'fixture',unit,quantity});
const context=(sequence:number,id=`effect-${sequence}`):BalanceContext=>({id,expected_sequence:sequence,simulation_time_ms:sequence+1,actor:{kind:'worker',principal_id:null},job_ids:[]});

/** Event time does not round quarter-second travel or variable-rate charge completion. */
test('shared event clock preserves exact boundaries, debt, effect identities, fixed quanta and clock rollback',()=>{
  const initial={instance_id:'clock',cursor_ms:0,observed_at_ms:0,effects:[] as string[]};
  const policy={validate:()=>{},next:(_s:any,remaining:number)=>Math.min(250,remaining),step:(s:any,c:any)=>s.effects.push(c.effect_id)};
  const first=advanceEventClock(initial,1001,2,policy);
  assert.equal(first.cursor_ms,500);assert.equal(first.observed_at_ms,1001);assert.equal(initial.cursor_ms,0);
  const rest=advanceEventClock(first,900,10,policy);
  assert.equal(rest.cursor_ms,1001);assert.equal(rest.effects.length,5);assert.equal(new Set(rest.effects).size,5);
  assert.deepEqual(advanceEventClock(rest,1001,10,policy),rest);
  assert.deepEqual(advanceEventClock(initial,1001,10,policy),rest);
  assert.throws(()=>advanceEventClock(initial,1001,2,{...policy,next:()=>1.5}));
  assert.throws(()=>advanceEventClock(initial,1001,2,{...policy,step:s=>{s.cursor_ms++;}}));
  assert.throws(()=>advanceEventClock(initial,1001,2,{...policy,settle:s=>{s.cursor_ms++;}}));
  assert.throws(()=>advanceEventClock(initial,1001,2,{...policy,next:s=>{s.observed_at_ms++;return 1;}}));
  assert.equal(advanceEventClock(initial,999,10,{...policy,next:(_s,n)=>n>=1000?1000:0}).cursor_ms,0);
});

test('event job proposals cannot revive terminal work, change owner or award unelapsed paid time',()=>{
  const j={id:'job-1',owner_id:'alice',kind:'assay',state:'running',reason:null,progress_ms:250,checkpoint:{phase:1}};
  assert.equal(transitionEventJobs([j],[{...j,progress_ms:251}],{maxProgress:1})[0].progress_ms,251);
  assert.throws(()=>transitionEventJobs([j],[{...j,progress_ms:252}],{maxProgress:1}));
  assert.throws(()=>transitionEventJobs([j],[{...j,owner_id:'bobby'}]));
  assert.throws(()=>transitionEventJobs([j],[],{allowPrune:true}));
  const done={...j,state:'completed'};
  assert.throws(()=>transitionEventJobs([done],[j]));
  assert.throws(()=>transitionEventJobs([done],[{...done,checkpoint:{phase:2}}]));
});

test('balanced continuous ledger rejects transmutation, refunds, incompatible units, overcapacity and unauthorized issuance',()=>{
  const accounts=[account('battery','stock','mJ',10),account('spent','spent'),account('cargo','cargo','g',10)];
  const opening=[allocation('battery',10),allocation('cargo',5,'copper','g')];
  const ledger=createResourceBalances('fixture',pin,accounts,opening,0);
  const spent=settleResourceBalances(ledger,context(0),accounts,[allocation('battery',5),allocation('spent',5),allocation('cargo',5,'copper','g')],[],()=>true);
  assert.throws(()=>settleResourceBalances(spent,context(1),accounts,opening,[],()=>true));
  assert.throws(()=>settleResourceBalances(ledger,context(0),accounts,[allocation('battery',11),allocation('cargo',5,'copper','g')],[{resource_id:'energy',quantity:1,kind:'metered',source_id:'solar'}],()=>true));
  assert.throws(()=>settleResourceBalances(ledger,context(0),accounts,[allocation('battery',10),allocation('cargo',5,'steel','g')],[],()=>true));
  assert.throws(()=>settleResourceBalances(ledger,context(0),accounts,[allocation('battery',9),allocation('cargo',5,'copper','g')],[],()=>true));
  assert.throws(()=>settleResourceBalances(ledger,context(0),accounts,[allocation('battery',10),allocation('cargo',6,'copper','g')],[{resource_id:'copper',quantity:1,kind:'metered',source_id:'fiction'}],()=>true));
  assert.throws(()=>settleResourceBalances(ledger,context(0),accounts,opening,[],()=>false));
  const changed=accounts.map(a=>({...a,owner_id:'bobby'}));
  assert.throws(()=>settleResourceBalances(ledger,context(0),changed,opening,[],()=>true));
});

test('posting checkpoints retain lifetime conservation and reject stale/reused effects across tail compaction',()=>{
  const accounts=[account('battery','stock','mJ',100),account('spent','spent')];
  let ledger=createResourceBalances('fixture',pin,accounts,[allocation('battery',100)],0);
  let old:any;
  for(let i=0;i<70;i++){
    const next=[allocation('battery',100-i-1),allocation('spent',i+1)];
    if(i===0)old={context:context(i),next};
    const before=ledger;
    ledger=settleResourceBalances(ledger,context(i),accounts,next,[],()=>true);
    assert.deepEqual(settleResourceBalances(ledger,context(i),accounts,next,[],()=>true),ledger);
    assert.equal(before.sequence,i);
  }
  assert.equal(ledger.sequence,70);assert.equal(ledger.entries.length,32);assert.equal(ledger.checkpoint.sequence,38);
  assert.equal(ledger.opening_totals.energy,100);assert.deepEqual(validateResourceBalances(ledger),ledger);
  assert.throws(()=>settleResourceBalances(ledger,old.context,accounts,old.next,[],()=>true));
  const corrupt=structuredClone(ledger);corrupt.entries[0].postings[0].delta++;
  assert.throws(()=>validateResourceBalances(corrupt));
  const generated=settleResourceBalances(ledger,context(70),accounts,[allocation('battery',31),allocation('spent',70)],[{resource_id:'energy',quantity:1,kind:'metered',source_id:'solar'}],()=>true);
  assert.equal(generated.issued_totals.energy,1);
});

/** Compare the captured native physics against the original advancement policy, including a fractional final interval. */
test('native active robot migration uses canonical core jobs/observations and exactly preserves original event physics',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/native-v5.json',import.meta.url),'utf8'));
  const match=JSON.parse(fixture.tables.matches[0].state);
  const instance=packGame(match);
  const registry=new DomainRegistry();registry.register(gameDomainModule());registry.validateInstance(instance);
  assert.equal(Object.hasOwn(instance.state.native.players[0],'jobs'),false);
  assert.equal(Object.hasOwn(instance.state.native.players[0],'surveys'),false);
  assert.equal(instance.state.schedule.jobs[0].id,match.players[0].robot_jobs[0].id);
  assert.equal(instance.observations[0].id,match.players[0].surveys[0].id);
  const reference=structuredClone(match),at=fixture.time+60001;
  const old=Object.assign(Object.create(VersionedGameDomain.prototype),{clock:()=>at,healthy:()=>true});
  old.advanceWithRobots(reference);old.prepareState(reference);
  const next=advanceGame(instance,at);
  assert.deepEqual(nativeGame(next),reference);
  registry.validateInstance(next);
  assert.equal(next.pin.module_id,sharedGamePin.module_id);
  assert.equal(next.state.resources.issued_totals.energy,60001*200);
  assert.deepEqual(advanceGame(next,at),next);
  let chunks=instance;
  for(let i=0;i<10;i++)chunks=advanceGame(chunks,at,1);
  assert(chunks.state.schedule.cursor_ms<chunks.state.schedule.observed_at_ms);
  while(chunks.state.schedule.cursor_ms<at)chunks=advanceGame(chunks,at,10);
  const chunked=nativeGame(chunks);chunked.revision=reference.revision;
  assert.deepEqual(chunked,reference);
});

test('actual game commands persist the registered envelope and reject tampered ledger/job checkpoints',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oi-core-game-'));
  let db:GameDatabase|undefined;
  try{
    let time=1000;
    db=new GameDatabase(join(dir,'game.sqlite'),{clock:()=>time});
    const a=await db.authenticate({username:'alice',password:'shared-core-test-password'},true);db.tick();
    const created=db.dispatch(a.token,'astra.game_create_match',{version:5,command_id:randomUUID()}),id=created.snapshot.match_id;
    const stored=JSON.parse(String(db.db.prepare('SELECT state FROM matches WHERE id=?').get(id)!.state));
    assert.equal(stored.contract_version,1);assert.equal(stored.pin.module_id,'native-game');
    const unknown=structuredClone(stored);unknown.pin.module_version='latest';assert.throws(()=>db!.registry.validateInstance(unknown));
    const invented=structuredClone(stored);invented.state.resources.balances[0].quantity++;assert.throws(()=>db!.registry.validateInstance(invented));
    const b=await db.authenticate({username:'bobby',password:'shared-core-test-password'},true);
    db.dispatch(b.token,'astra.game_join_match',{version:5,command_id:randomUUID(),match_id:id,invite_code:created.invite_code});
    const read=()=>db!.dispatch(a.token,'astra.game_read_match',{version:5,match_id:id}).snapshot;
    const robot=read().field.robots[0].id;
    const deposit=read().world.deposits.find((d:any)=>d.kind==='cable'&&d.home_slot===1).id;
    db.dispatch(a.token,'astra.game_command',{version:5,command_id:randomUUID(),match_id:id,expected_revision:read().revision,action:'survey_robot',robot_id:robot,deposit_id:deposit,sensor:'camera-depth'});
    time+=60000;db.tick();
    const snapshot=read(),observation=snapshot.field.observations[0];
    const request={version:5,command_id:randomUUID(),match_id:id,expected_revision:snapshot.revision,action:'collect_robot',robot_id:robot,deposit_id:deposit,observation_id:observation.id,material_class:'unclassified'};
    const before=canonical(db.loadInstance(id)),history=db.transaction(()=>canonical(db!.history.replay(id)));
    db.db.exec("CREATE TRIGGER reject_core_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'receipt-fault'); END;");
    assert.throws(()=>db!.dispatch(a.token,'astra.game_command',request));
    assert.equal(canonical(db.loadInstance(id)),before);
    assert.equal(db.transaction(()=>canonical(db!.history.replay(id))),history);
    db.db.exec('DROP TRIGGER reject_core_receipt');
    const receipt=db.dispatch(a.token,'astra.game_command',request),committed=canonical(db.loadInstance(id));
    assert.notEqual(committed,before);
    assert.deepEqual(db.dispatch(a.token,'astra.game_command',request),receipt);
    assert.equal(canonical(db.loadInstance(id)),committed);
  }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('variable-rate shared charging exactly matches native solar starvation and one-millisecond final energy transfer',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/native-v5.json',import.meta.url),'utf8'));
  for(const partial of [false,true]){
    const match=JSON.parse(fixture.tables.matches[0].state),crew=match.players[0];
    const policy=Object.assign(Object.create(VersionedGameDomain.prototype),{clock:()=>fixture.time,healthy:()=>true});
    // Native abandon releases the fixture's live reservation without inventing input stock.
    policy.command(match,crew,{action:'interrupt_robot',robot_id:crew.robots[0].id});
    crew.machine.dissipated_mj+=crew.machine.energy_mj;crew.machine.energy_mj=0;
    for(const [i,r] of crew.robots.entries()){
      if(!partial||i===1){const remain=partial?r.capacity_mj-1:0;r.spent_mj+=r.energy_mj-remain;r.energy_mj=remain;}
      r.position={...r.home};
    }
    if(!partial)policy.command(match,crew,{action:'recharge_robot',robot_id:crew.robots[0].id});
    policy.command(match,crew,{action:'recharge_robot',robot_id:crew.robots[1].id});
    const instance=packGame(match),reference=structuredClone(match),dt=partial?1:160001;
    policy.clock=()=>fixture.time+dt;policy.advanceWithRobots(reference);policy.prepareState(reference);
    const result=advanceGame(instance,fixture.time+dt);
    assert.deepEqual(nativeGame(result),reference);
    assert.equal(result.state.resources.issued_totals.energy,dt*200);
    assert.equal(nativeGame(result).players[0].robots[partial?1:0].energy_mj,8000000);
  }
});


test('valid resource names do not inherit object prototype values during postings or issuance',()=>{
  const accounts=[account('battery','stock','mJ',10),account('spent','spent')];
  const initial=createResourceBalances('fixture',pin,accounts,[allocation('battery',5,'constructor')],0);
  const next=settleResourceBalances(initial,context(0),accounts,[allocation('battery',4,'constructor'),allocation('spent',2,'constructor')],[{resource_id:'constructor',quantity:1,kind:'metered',source_id:'solar'}],()=>true);
  assert.equal(next.issued_totals.constructor,1);
  assert.deepEqual(validateResourceBalances(next),next);
});
