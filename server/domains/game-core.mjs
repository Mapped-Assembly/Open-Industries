import { isManufacturing, settleManufacturing, manufacturingAllocations, reservedComponentQuantity, chargingPower, productionSolar, productionStation } from '../game-manufacturing.mjs';
import { createHash } from 'node:crypto';
import { VersionedGameDomain,canonical } from './game.mjs';
import { gameFail,gameSnapshotSchema,validateGameRequest } from '../mcp-game-contract.mjs';
import { contentsOf,settleRobots,robotStepLimit,chargingRobot,advanceRobots } from '../game-robots.mjs';
import { advanceEventClock } from '../simulation/event-clock.mjs';
import { transitionEventJobs,validateEventJobs } from '../simulation/event-jobs.mjs';
import { createResourceBalances,settleResourceBalances,validateResourceBalances,resourceBalancesSchema } from '../simulation/resource-balances.mjs';

export const sharedGamePin=Object.freeze({module_id:'native-game',module_version:'dump-world-v1',schema_version:1});
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const policyAt=at=>Object.assign(Object.create(VersionedGameDomain.prototype),{clock:()=>at,healthy:()=>true});
const live=j=>['running','paused'].includes(j.state);

/** Lossless native compatibility view; persisted jobs/observations have one canonical core owner. */
export function nativeGame(instance){
  const match=clone(instance.state.native);
  Object.assign(match,{id:instance.id,revision:instance.revision,last_advanced_ms:instance.simulation_time_ms});
  for(const p of match.players){
    p.jobs=[];p.robot_jobs=[];p.observations=[];p.surveys=[];
    for(const job of instance.state.schedule.jobs.filter(j=>j.owner_id===p.owner)){
      const checkpoint=clone(job.checkpoint);
      const state=job.state==='queued'?'waiting':job.state==='waiting-for-resource'?'paused':job.state;
      const native={id:job.id,...checkpoint,work_ms:job.progress_ms,state};
      if(job.kind==='process')native.pause_reason=state==='paused'?job.reason:null;
      else native.reason=job.reason;
      (job.kind==='process'?p.jobs:p.robot_jobs).push(native);
    }
    for(const o of instance.observations.filter(o=>o.owner_id===p.owner))
      (o.value.kind==='bench'?p.observations:p.surveys).push(clone(o.value.record));
  }
  return match;
}
/** Convert native phase records without inventing a creation time or rounding paid milliseconds. */
function coreJobs(match){
  return match.players.flatMap(p=>[['process',p.jobs],['robot',p.robot_jobs]].flatMap(([kind,jobs])=>jobs.map(j=>{
    const {id,state,work_ms,...checkpoint}=clone(j);
    const reason=kind==='process'?(['cancelled','failed'].includes(state)?checkpoint.cancellation_reason??'cancelled':checkpoint.pause_reason):checkpoint.reason;
    delete checkpoint.pause_reason;delete checkpoint.reason;
    const waiting=state==='paused'&&['power','base-busy','charging-port','machine-disabled','storage-full'].includes(reason);
    return {id,owner_id:p.owner,kind,state:state==='waiting'?'queued':waiting?'waiting-for-resource':state,reason:reason??null,progress_ms:work_ms,checkpoint};
  })));
}
/** Stable typed entities/observations preserve native IDs and private evidence at the common boundary. */
function metadata(match){
  const entities=new Map(),observations=[];
  const put=(id,kind,owner,position,shared=false)=>{
    if(entities.has(id))return;
    entities.set(id,{id,instance_id:match.id,kind,revision:1,owner_id:owner,access:{read:shared?'members':'owner',write:owner?'owner':'operators'},location:position?{frame_id:'dump',unit:'cell',x:position.x,y:position.y,z:0}:null,references:[],data:{}});
  };
  for(const d of match.world.deposits)put(d.id,'deposit',null,d.position,true);
  for(const t of match.world.towers)put(t.id,'tower',match.players.find(p=>p.slot===t.slot)?.owner??null,t.position,true);
  for(const p of match.players){
    for(const a of p.base.assets)put(a.id,a.kind,p.owner,a.position);
    for(const b of p.batches)put(b.id,'batch',p.owner,null);
    for(const a of p.production?.products??[])put(a.id,a.category,p.owner,p.units?.find(u=>u.id===a.id)?.position??p.base.assets.find(a=>a.kind==='bench').position);
    for(const c of p.components)put(c.id,'component',p.owner,null);
    for(const [kind,records]of[['bench',p.observations],['field',p.surveys]])for(const o of records){
      const target=kind==='bench'?o.targetId:o.target_id;
      put(target,'evidence-target',p.owner,null);
      observations.push({id:o.id,target:{instance_id:match.id,entity_id:target},owner_id:p.owner,source_id:kind==='bench'?o.sensorVersion:o.sensor,source_revision:kind==='bench'?o.sensorVersion:o.sensor_version,recorded_at_ms:kind==='bench'?o.timestampMs:o.timestamp_ms,origin:'simulated',validity:'modeled',value:{kind,record:clone(o)}});
    }
  }
  return {entities:[...entities.values()],observations};
}
/** Canonical finite allocations include every constituent, reservation, cargo and energy sink. */
export function gameAllocations(match){
  const accounts=[],balances=[];
  const add=(id,kind,owner,job,unit,capacity,items)=>{
    accounts.push({id,kind,owner_id:owner,job_id:job,unit,capacity});
    for(const [resource,quantity]of Object.entries(items))if(quantity){if(!Number.isSafeInteger(quantity)||quantity<0)gameFail('INVARIANT_FAILED');balances.push({account_id:id,resource_id:resource,lot_id:unit==='g'?'bulk':unit==='mJ'?'charge':'parts',unit,quantity});}
  };
  for(const d of match.world.deposits)add(`deposit:${d.id}`,'stock',null,null,'g',null,d.stock.remaining);
  for(const p of match.players){
    add(`base:${p.owner}`,'stock',p.owner,null,'mJ',p.base.power.capacity_mj,{energy:p.machine.energy_mj});
    add(`spill:${p.owner}`,'spill',p.owner,null,'mJ',null,{energy:p.base.power.spilled_mj});
    add(`dissipated:${p.owner}`,'spent',p.owner,null,'mJ',null,{energy:p.machine.dissipated_mj});
    for(const j of p.jobs)add(`process-spent:${j.id}`,'spent',p.owner,j.id,'mJ',null,{energy:j.energy_mj});
    for(const r of p.robots){
      add(`robot:${r.id}`,'stock',p.owner,null,'mJ',r.capacity_mj,{energy:r.energy_mj});
      add(`robot-spent:${r.id}`,'spent',p.owner,null,'mJ',null,{energy:r.spent_mj});
      const contents={};for(const b of r.cargo)for(const[k,n]of Object.entries(b.contents))contents[k]=(contents[k]??0)+n;
      add(`cargo:${r.id}`,'cargo',p.owner,null,'g',r.payload_g,contents);
    }
    for(const j of p.robot_jobs)if(j.reserved)add(`reservation:${j.id}`,'reserved',p.owner,j.id,'g',10000,j.reserved.contents);
    for(const b of p.batches)if(b.state!=='consumed'){
      const job=p.jobs.find(j=>(j.input_batch_id===b.id||j.material_inputs?.some(m=>m.id===b.id))&&['waiting','running','paused'].includes(j.state));
      add(job?`wip:${job.id}`:`batch:${b.id}`,job?'wip':'stock',p.owner,job?.id??null,'g',null,contentsOf(b));
    }
    for (const row of manufacturingAllocations(p)) add(row.id,row.job?'reserved':'stock',p.owner,row.job,row.unit,null,row.contents);
    for(const asset of p.base.assets){const counts={};for(const c of asset.components)counts[`part.${c.kind}`]=(counts[`part.${c.kind}`]??0)+c.quantity;add(`asset:${asset.id}`,'stock',p.owner,null,'count',null,counts);}
    const counts={};for(const c of p.components)counts[`part.${c.kind}`]=(counts[`part.${c.kind}`]??0)+c.quantity-reservedComponentQuantity(p,c.id);add(`store:${p.owner}`,'stock',p.owner,null,'count',null,counts);
  }
  return {accounts,balances};
}
/** Keep empty retired accounts as immutable identities; their stock never reappears on retry. */
function completeAccounts(ledger,accounts){const all=new Map(ledger.accounts.map(a=>[a.id,a]));for(const a of accounts){if(all.has(a.id)&&canonical(all.get(a.id))!==canonical(a))gameFail('INVARIANT_FAILED');all.set(a.id,a);}return [...all.values()];}
/** Enforce measured solar W×ms and one-time native participant grants, never arbitrary resupply. */
function creditsFor(before,after,elapsed){
  const credits=[],energy=before.status==='active'?before.players.reduce((n,p)=>n+(p.machine.status==='ready'?p.base.power.solar_w:0)*elapsed,0):0;
  if(energy)credits.push({resource_id:'energy',quantity:energy,source_id:'solar',kind:'metered'});
  for(const p of after.players.filter(p=>!before.players.some(old=>old.owner===p.owner))){
    credits.push({resource_id:'energy',quantity:p.base.power.initial_mj+p.robots.reduce((n,r)=>n+r.initial_mj,0),source_id:`starter:${p.owner}`,kind:'bootstrap'});
    const counts={};for(const c of [...p.base.assets.flatMap(a=>a.components),...p.base.inventory])counts[`part.${c.kind}`]=(counts[`part.${c.kind}`]??0)+c.quantity;
    for(const[resource_id,quantity]of Object.entries(counts))credits.push({resource_id,quantity,source_id:`starter:${p.owner}`,kind:'bootstrap'});
  }
  return credits;
}
/** Only the trusted native rule may meter solar or initialize the one newly joined crew. */
function approveBalances(before,after,context,elapsed,proposal){
  const added=after.players.filter(p=>!before.players.some(old=>old.owner===p.owner));
  if(context.actor.kind==='command'){
    if(elapsed!==0||!after.players.some(p=>p.owner===context.actor.principal_id))return false;
    if(added.length&&(added.length!==1||before.status!=='waiting'||added[0].slot!==2||added[0].owner!==context.actor.principal_id))return false;
  }else if(context.actor.kind!=='worker'||context.actor.principal_id!==null||added.length)return false;
  for(const old of before.players){
    const p=after.players.find(p=>p.owner===old.owner);if(!p)return false;
    const generated=before.status==='active'&&old.machine.status==='ready'?old.base.power.solar_w*elapsed:0;
    if(p.base.power.generated_mj-old.base.power.generated_mj!==generated)return false;
  }
  return canonical(proposal.credits)===canonical(creditsFor(before,after,elapsed));
}

/** Pack a complete state proposal only after common job and ledger checks approve it. */
export function packGame(match,prior,context,elapsed=0){
  policyAt(match.last_advanced_ms).validateCurrentState(match);
  const jobs=coreJobs(match),allocation=gameAllocations(match);
  let resources;
  if(prior){
    transitionEventJobs(prior.state.schedule.jobs,jobs,{allowCreate:context.actor.kind==='command',allowPrune:context.actor.kind==='command',maxProgress:elapsed});
    const before=nativeGame(prior),credits=creditsFor(before,match,elapsed);
    resources=canonical(allocation.balances.slice().sort((a,b)=>canonical(a).localeCompare(canonical(b))))===canonical(prior.state.resources.balances.slice().sort((a,b)=>canonical(a).localeCompare(canonical(b))))&&credits.length===0?prior.state.resources:settleResourceBalances(prior.state.resources,{...context,expected_sequence:prior.state.resources.sequence,simulation_time_ms:match.last_advanced_ms,job_ids:jobs.filter(j=>!['completed','cancelled','failed'].includes(j.state)).map(j=>j.id)},completeAccounts(prior.state.resources,allocation.accounts),allocation.balances,credits,(_ledger,proposal)=>approveBalances(before,match,context,elapsed,proposal));
  }else resources=createResourceBalances(match.id,sharedGamePin,allocation.accounts,allocation.balances,match.last_advanced_ms);
  const native=clone(match);delete native.id;delete native.revision;delete native.last_advanced_ms;
  for(const p of native.players){delete p.jobs;delete p.robot_jobs;delete p.observations;delete p.surveys;}
  const observed=Math.max(prior?.state.schedule.observed_at_ms??match.last_advanced_ms,match.last_advanced_ms);
  return {contract_version:1,id:match.id,pin:{...sharedGamePin},revision:match.revision,simulation_time_ms:match.last_advanced_ms,members:match.players.map(p=>({principal_id:p.owner,role:p.slot===1?'owner':'operator'})),frames:[{id:'dump',unit:'cell',axes:'xy-grid'}],...metadata(match),state:{native,schedule:{version:2,instance_id:match.id,cursor_ms:match.last_advanced_ms,observed_at_ms:observed,jobs},resources}};
}

/** Select the next physical event; the common driver owns iteration, time and work budgets. */
function eventPlan(match,remaining,at){
  const policy=policyAt(at);let changed=settleRobots(match,at),dt=remaining;
  for (const p of match.players) {
    changed = settleManufacturing(p,at) || changed;
    for (const j of p.jobs.filter(j=>!isManufacturing(j)&&['form-steel','form-aluminum','mold-hdpe'].includes(j.recipe)&&['running','paused'].includes(j.state))) {
      const required=j.recipe==='mold-hdpe'?'polymer-processor':'metal-press',station=productionStation(p,required);
      if(!station||station.state==='destroyed'){policy.cancel(p,j,'machine_destroyed');changed=true;continue;}
      const enabled=station.enabled&&(j.recipe!=='mold-hdpe'||productionStation(p,'furnace')?.enabled);
      if(!enabled&&j.pause_reason!=='requested'){if(j.state!=='paused'||j.pause_reason!=='machine-disabled')changed=true;j.state='paused';j.pause_reason='machine-disabled';}
      else if(enabled&&j.pause_reason==='machine-disabled'&&!p.jobs.some(other=>other!==j&&other.state==='running')){j.state='running';j.pause_reason=null;changed=true;}
    }
  }
  const plans=match.players.map(p=>{
    const solar=p.machine.status==='ready'?p.base.power.solar_w:0;
    let job=p.jobs.find(j=>j.state==='running');
    if(job&&job.work_ms===job.duration_ms){policy.finishProcess(match,p,job,at);changed=true;job=undefined;}
    const power=job?.power_w??(job?500:0);
    if(job&&power>solar&&p.machine.energy_mj<power-solar){job.state='paused';job.pause_reason='power';changed=true;job=undefined;}
    const powerWait=p.jobs.find(j=>isManufacturing(j)&&j.state==='paused'&&j.pause_reason==='power');
    const robot=!job&&!powerWait&&p.machine.status==='ready'?chargingRobot(p):undefined;
    const portPower=chargingPower(p),chargeRate=robot?(p.machine.energy_mj>=portPower-solar?portPower:Math.min(portPower,solar)):0;
    let limit=robotStepLimit(p);
    if(powerWait&&solar>0){const required=Math.min(500000,(powerWait.duration_ms-powerWait.work_ms)*powerWait.power_w);if(required>p.machine.energy_mj)limit=Math.min(limit,Math.ceil((required-p.machine.energy_mj)/solar));}
    if(job)limit=Math.min(limit,job.duration_ms-job.work_ms,power>solar?Math.floor(p.machine.energy_mj/(power-solar)):Infinity);
    if(robot&&chargeRate)limit=Math.min(limit,Math.ceil((robot.capacity_mj-robot.energy_mj)/chargeRate),chargeRate>solar?Math.floor(p.machine.energy_mj/(chargeRate-solar)):Infinity);
    dt=Math.min(dt,limit);return {p,solar,job,robot,chargeRate};
  });
  return {plans,dt,changed};
}
/** Shared event-clock worker; domain callbacks calculate physical demand and modeled outputs. */
export function advanceGame(instance,wallNow,budget=1000){
  const initial=clone(instance),start=nativeGame(initial);let changed=false;
  const clock={instance_id:instance.id,cursor_ms:instance.simulation_time_ms,observed_at_ms:instance.state.schedule.observed_at_ms,instance:initial};
  const next=advanceEventClock(clock,wallNow,budget,{
    validate(state){validateEventJobs(state.instance.state.schedule.jobs);validateResourceBalances(state.instance.state.resources);},
    settle(state,at){
      const match=nativeGame(state.instance);
      if(match.status==='waiting'&&match.invite_expires<=state.observed_at_ms){policyAt(at).complete(match,'invite-expired');match.revision++;changed=true;}
      if(match.status==='active')changed=settleRobots(match,at)||changed;
      policyAt(at).prepareState(match);
      if(canonical(match)!==canonical(nativeGame(state.instance)))state.instance=packGame(match,state.instance,{id:`${instance.id}:settle:${at}:${state.instance.state.resources.sequence}`,actor:{kind:'worker',principal_id:null}});
    },
    next(state,remaining){
      const match=nativeGame(state.instance);
      if(match.status!=='active')return remaining;
      return eventPlan(match,remaining,state.cursor_ms).dt;
    },
    step(state,step){
      const match=nativeGame(state.instance),policy=policyAt(step.at_ms);
      if(match.status==='active'){
        const plan=eventPlan(match,step.duration_ms,step.from_ms);changed=plan.changed||changed;
        if(plan.dt!==step.duration_ms)gameFail('INVARIANT_FAILED');
        for(const{p,solar,job,robot,chargeRate}of plan.plans){
          const generated=step.duration_ms*solar,used=job?step.duration_ms*(job.power_w??500):0;
          const transferred=robot?Math.min(robot.capacity_mj-robot.energy_mj,step.duration_ms*chargeRate):0;
          if(job){job.work_ms+=step.duration_ms;job.energy_mj+=used;job.last_tick_ms=step.at_ms;}
          const energy=p.machine.energy_mj+generated-used-transferred;
          p.base.power.generated_mj+=generated;p.base.power.spilled_mj+=Math.max(0,energy-p.base.power.capacity_mj);
          p.machine.energy_mj=Math.min(p.base.power.capacity_mj,energy);p.robot_charge_mj+=transferred;
          changed=advanceRobots(p,step.duration_ms,robot,transferred,!!job||p.machine.status!=='ready')||changed;
          if(job&&job.work_ms===job.duration_ms){policy.finishProcess(match,p,job,step.at_ms);changed=true;}
        }
        changed=settleRobots(match,step.at_ms)||changed;
      }
      match.last_advanced_ms=step.at_ms;policy.prepareState(match);
      state.instance=packGame(match,state.instance,{id:step.effect_id,actor:{kind:'worker',principal_id:null}},step.duration_ms);
    },
  });
  next.instance.state.schedule.observed_at_ms=next.observed_at_ms;
  // Preserve native revision semantics: one bump per advancement call, not per physical boundary.
  next.instance.revision=start.revision+(changed?1:0);
  return next.instance;
}

/** Exact-pin registered game module; native wire projections remain unchanged.
 * @param {(code:string)=>never} [reject]
 * @returns {import('../simulation/contracts.js').DomainModule}
 */
export function gameDomainModule(reject=code=>{gameFail(code);throw Error('UNREACHABLE');}){
  return {pin:sharedGamePin,stateSchema:object({native:{type:'object'},schedule:object({version:{const:2},instance_id:{type:'string'},cursor_ms:integer,observed_at_ms:integer,jobs:{type:'array',maxItems:1024,items:{type:'object'}}}),resources:resourceBalancesSchema()}),commandSchema:object({action:{type:'string'},payload:{type:'object'}}),projectionSchema:gameSnapshotSchema,migrations:[],
    validateInvariants(instance){
      if(canonical(instance.pin)!==canonical(sharedGamePin))gameFail('INVARIANT_FAILED');
      const match=nativeGame(instance),schedule=instance.state.schedule;
      if(match.players.length<1||match.players.length>2||new Set(match.players.map(p=>p.slot)).size!==match.players.length||match.players.some(p=>![1,2].includes(p.slot)||p.base.power.solar_w!==productionSolar(p)||p.base.power.capacity_mj!==20000000||p.base.power.initial_mj!==20000000))gameFail('INVARIANT_FAILED');
      if(schedule.instance_id!==instance.id||schedule.cursor_ms!==instance.simulation_time_ms||schedule.cursor_ms>schedule.observed_at_ms)gameFail('INVARIANT_FAILED');
      validateEventJobs(schedule.jobs);
      for(const job of schedule.jobs){
        if(!['process','robot'].includes(job.kind)||!['queued','running','waiting-for-resource','paused','completed','cancelled','failed'].includes(job.state)||!match.players.some(p=>p.owner===job.owner_id))gameFail('INVARIANT_FAILED');
        if(job.kind==='process'&&(!Number.isSafeInteger(job.checkpoint.duration_ms)||job.checkpoint.duration_ms<1||job.progress_ms>job.checkpoint.duration_ms||(job.state==='completed'&&job.progress_ms!==job.checkpoint.duration_ms)))gameFail('INVARIANT_FAILED');
        if(job.kind==='robot'&&(!Array.isArray(job.checkpoint.phases)||!Number.isSafeInteger(job.checkpoint.phase_index)||job.checkpoint.phase_index<0||job.checkpoint.phase_index>job.checkpoint.phases.length||!Number.isSafeInteger(job.checkpoint.phase_work_ms)||job.checkpoint.phase_work_ms<0))gameFail('INVARIANT_FAILED');
      }
      const ledger=validateResourceBalances(instance.state.resources);
      if(ledger.instance_id!==instance.id||canonical(ledger.rule)!==canonical(sharedGamePin))gameFail('INVARIANT_FAILED');
      const wanted=gameAllocations(match);for(const account of wanted.accounts){const actual=ledger.accounts.find(a=>a.id===account.id);if(actual&&canonical(actual)!==canonical(account))gameFail('INVARIANT_FAILED');}
      if(canonical([...wanted.balances].sort((a,b)=>canonical(a).localeCompare(canonical(b))))!==canonical([...ledger.balances].sort((a,b)=>canonical(a).localeCompare(canonical(b)))))gameFail('INVARIANT_FAILED');
      policyAt(instance.simulation_time_ms).validateCurrentState(match);
      const meta=metadata(match);if(canonical(meta.entities)!==canonical(instance.entities)||canonical(meta.observations)!==canonical(instance.observations)||canonical(instance.members)!==canonical(match.players.map(p=>({principal_id:p.owner,role:p.slot===1?'owner':'operator'}))))gameFail('INVARIANT_FAILED');
    },
    authorizeCommand:(instance,_command,context)=>instance.members.some(m=>m.principal_id===context.principal_id&&m.role!=='viewer'),
    proposeTransition(instance,command,context){
      try {
      const match=nativeGame(instance),policy=policyAt(context.simulation_time_ms),own=policy.member(match,context.principal_id);
      if(command.action==='rotate_invite')policy.rotate(match,context.principal_id,command.payload.invite_code);
      else {
        const args={version:5,command_id:command.command_id,match_id:instance.id,expected_revision:instance.revision,action:command.action,...command.payload};
        validateGameRequest('astra.game_command',args);policy.command(match,own,args);
      }
      policy.prepareState(match);
      const next=packGame(match,instance,{id:`command:${hash(command.command_id)}`,actor:{kind:'command',principal_id:context.principal_id}});
      return {state:next.state,events:[],entities:next.entities,observations:next.observations};
      } catch(error) { if(error?.name==='GameToolError')return reject(error.code);throw error; }
    },
    project(instance,context){return policyAt(instance.simulation_time_ms).snapshot(nativeGame(instance),context.principal_id);},
  };
}
