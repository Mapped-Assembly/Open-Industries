import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { canonicalCommand } from './commands.mjs';
import { copyJson } from './json.mjs';
import { assertResourceConservation, resourceTotals, ResourceLedgerError } from './resources.mjs';

const fail = () => { throw new ResourceLedgerError('INVALID_RESOURCE'); };
const clone = value => copyJson(value,fail);
const digest = value => createHash('sha256').update(canonicalCommand(value)).digest('hex');
const id={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]*$'};
const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const array=(items,maxItems)=>({type:'array',items,maxItems});
const pin=object({module_id:id,module_version:id,schema_version:{...integer,minimum:1}});
const nullable=s=>({anyOf:[s,{type:'null'}]});
const account=object({id,kind:{enum:['stock','reserved','cargo','wip','output','waste','spill','spent']},owner_id:nullable(id),job_id:nullable(id),unit:{enum:['g','mJ','count','uL']},capacity:nullable(integer)});
const allocation=object({account_id:id,resource_id:id,lot_id:id,unit:{enum:['g','mJ','count','uL']},quantity:{...integer,minimum:1}});
const credit=object({resource_id:id,quantity:{...integer,minimum:1},source_id:id,kind:{enum:['metered','bootstrap']}});
const posting=object({account_id:id,resource_id:id,lot_id:id,unit:{enum:['g','mJ','count','uL']},delta:{type:'integer',minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER}});
const context=object({id,expected_sequence:integer,simulation_time_ms:integer,actor:object({kind:{enum:['worker','command','migration']},principal_id:nullable(id)}),job_ids:array(id,1024)});
const entry=object({sequence:integer,context,postings:array(posting,16384),credits:array(credit,128),accounts:array(account,4096),request_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},previous_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},hash:{type:'string',pattern:'^[a-f0-9]{64}$'}});
const schema=object({version:{const:2},instance_id:id,rule:pin,sequence:integer,opening_totals:{type:'object',additionalProperties:integer},issued_totals:{type:'object',additionalProperties:integer},accounts:array(account,4096),balances:array(allocation,16384),checkpoint:object({sequence:integer,simulation_time_ms:integer,balances:array(allocation,16384),issued_totals:{type:'object',additionalProperties:integer},hash:{type:'string',pattern:'^[a-f0-9]{64}$'}}),entries:array(entry,32)});
const ajv=new Ajv({strict:true});
const valid=ajv.compile(schema),validAccounts=ajv.compile(array(account,4096)),validAllocations=ajv.compile(array(allocation,16384)),validCredits=ajv.compile(array(credit,128)),validContext=ajv.compile(context);
const key=row=>JSON.stringify([row.account_id,row.resource_id,row.lot_id,row.unit]);
const balanceMap=rows=>{
  const map=new Map();for(const row of rows){if(map.has(key(row)))fail();map.set(key(row),BigInt(row.quantity));}return map;
};
const safe=value=>{if(value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))fail();return Number(value);};
const own=(record,id)=>Object.hasOwn(record,id)?record[id]:0;
const sorted=rows=>[...rows].sort((a,b)=>key(a).localeCompare(key(b)));
/** Validate units, capacity and nonnegative quantities before any proposal can commit. */
function checkBalances(accounts,balances){
  const all=new Map(accounts.map(a=>[a.id,a]));if(all.size!==accounts.length)fail();
  balanceMap(balances);
  const units=new Map();for(const row of balances){if(units.has(row.resource_id)&&units.get(row.resource_id)!==row.unit)throw new ResourceLedgerError('UNIT_MISMATCH');units.set(row.resource_id,row.unit);}
  for(const row of balances){const a=all.get(row.account_id);if(!a||a.unit!==row.unit)fail();}
  for(const a of accounts){const total=balances.filter(b=>b.account_id===a.id).reduce((n,b)=>n+BigInt(b.quantity),0n);if(a.capacity!==null&&total>BigInt(a.capacity))throw new ResourceLedgerError('CAPACITY_EXCEEDED');}
}
/** Replay exact simultaneous postings; externally metered issuance never permits constituent transmutation. */
function post(accounts,balances,postings,credits){
  const map=balanceMap(balances),metadata=new Map(accounts.map(a=>[a.id,a])),totals=Object.create(null);
  for(const row of postings){
    const a=metadata.get(row.account_id);if(!a||a.unit!==row.unit||!Number.isSafeInteger(row.delta))fail();
    if(row.delta<0&&['spent','spill','waste'].includes(a.kind))throw new ResourceLedgerError('RESERVATION_CLOSED');
    const k=key(row);map.set(k,(map.get(k)??0n)+BigInt(row.delta));
    totals[row.resource_id]=(totals[row.resource_id]??0n)+BigInt(row.delta);
  }
  const units=new Map(balances.map(row=>[row.resource_id,row.unit]));for(const row of postings){if(units.has(row.resource_id)&&units.get(row.resource_id)!==row.unit)throw new ResourceLedgerError('UNIT_MISMATCH');units.set(row.resource_id,row.unit);}
  for(const c of credits){const unit=units.get(c.resource_id);if((c.kind==='metered'&&unit!=='mJ')||(c.kind==='bootstrap'&&!['mJ','count'].includes(unit)))throw new ResourceLedgerError('INCOMPATIBLE_RESOURCE');}
  const issued=Object.create(null);for(const c of credits)issued[c.resource_id]=(issued[c.resource_id]??0n)+BigInt(c.quantity);
  for(const r of new Set([...Object.keys(totals),...Object.keys(issued)]))if((totals[r]??0n)!==(issued[r]??0n))throw new ResourceLedgerError('CONSERVATION_FAILED');
  const next=[];for(const [k,n] of map){if(n<0n)throw new ResourceLedgerError('INSUFFICIENT_RESOURCE');if(n){const [account_id,resource_id,lot_id,unit]=JSON.parse(k);next.push({account_id,resource_id,lot_id,unit,quantity:safe(n)});}}
  checkBalances(accounts,next);return sorted(next);
}
/** Native/continuous workloads use the same exact units with a bounded replayable posting tail.
 * Issuance requires a trusted policy (e.g. a metered W×ms source or a one-time bootstrap).
 * @param {unknown} raw @returns {import('./event-runtime-contracts.js').ResourceBalanceLedger}
 */
export function validateResourceBalances(raw){
  const ledger=clone(raw);if(!valid(ledger))fail();
  checkBalances(ledger.accounts,ledger.balances);
  let balances=ledger.checkpoint.balances,issued={...ledger.checkpoint.issued_totals},seq=ledger.checkpoint.sequence,hash=ledger.checkpoint.hash,time=ledger.checkpoint.simulation_time_ms;
  const ids=new Set();
  for(const e of ledger.entries){
    const {hash:claimed,...body}=e;
    if(e.sequence!==++seq||e.context.expected_sequence!==seq-1||e.previous_hash!==hash||digest(body)!==claimed||e.context.simulation_time_ms<time||ids.has(e.context.id))fail();
    ids.add(e.context.id);time=e.context.simulation_time_ms;
    balances=post(ledger.accounts,balances,e.postings,e.credits);
    for(const c of e.credits)issued[c.resource_id]=safe(BigInt(own(issued,c.resource_id))+BigInt(c.quantity));
    hash=claimed;
  }
  if(seq!==ledger.sequence||canonicalCommand(sorted(balances))!==canonicalCommand(sorted(ledger.balances))||canonicalCommand(issued)!==canonicalCommand(ledger.issued_totals))fail();
  const expected={...ledger.opening_totals};for(const [r,n]of Object.entries(issued))expected[r]=safe(BigInt(own(expected,r))+BigInt(n));
  assertResourceConservation(expected,resourceTotals(ledger.balances));
  return ledger;
}
/** Create one explicit cutover checkpoint; migration preserves existing spent/held quantities.
 * @param {string} instanceId @param {import('./contracts.js').DomainPin} rule
 * @param {import('./event-runtime-contracts.js').BalanceAccount[]} accounts
 * @param {import('./resource-contracts.js').ResourceAllocation[]} balances @param {number} at
 * @returns {import('./event-runtime-contracts.js').ResourceBalanceLedger}
 */
export function createResourceBalances(instanceId,rule,accounts,balances,at){
  if(!validAccounts(accounts)||!validAllocations(balances)||!Number.isSafeInteger(at)||at<0)fail();
  const opening=sorted(clone(balances));
  return validateResourceBalances({version:2,instance_id:instanceId,rule,sequence:0,opening_totals:resourceTotals(opening),issued_totals:{},accounts:clone(accounts),balances:opening,checkpoint:{sequence:0,simulation_time_ms:at,balances:opening,issued_totals:{},hash:digest({instanceId,rule,accounts,opening,at})},entries:[]});
}
/**
 * Commit one authorized balanced proposal. The policy approves domain rates, sources and access;
 * the core enforces exact conservation, immutable account ownership, terminal sinks, retries and bounds.
 * @param {unknown} raw @param {import('./event-runtime-contracts.js').BalanceContext} context
 * @param {import('./event-runtime-contracts.js').BalanceAccount[]} accounts
 * @param {import('./resource-contracts.js').ResourceAllocation[]} balances
 * @param {import('./event-runtime-contracts.js').ResourceCredit[]} credits
 * @param {import('./event-runtime-contracts.js').ResourceBalancePolicy} policy
 * @returns {import('./event-runtime-contracts.js').ResourceBalanceLedger}
 */
export function settleResourceBalances(raw,context,accounts,balances,credits,policy){
  const ledger=validateResourceBalances(raw),ctx=clone(context),nextAccounts=clone(accounts),nextBalances=sorted(clone(balances)),issuance=clone(credits);
  if(!validContext(ctx)||!validAccounts(nextAccounts)||!validAllocations(nextBalances)||!validCredits(issuance)||typeof policy!=='function')fail();
  const request={context:ctx,accounts:nextAccounts,balances:nextBalances,credits:issuance};
  const old=ledger.entries.find(e=>e.context.id===ctx.id);
  if(old){if(old.request_hash!==digest(request))throw new ResourceLedgerError('OPERATION_ID_REUSED');return ledger;}
  if(ctx.expected_sequence!==ledger.sequence)throw new ResourceLedgerError('OPERATION_ID_REUSED');
  const previous=new Map(ledger.accounts.map(a=>[a.id,a]));
  for(const a of nextAccounts){const old=previous.get(a.id);if(old&&canonicalCommand(old)!==canonicalCommand(a))throw new ResourceLedgerError('NOT_AVAILABLE');}
  if(ledger.accounts.some(a=>!nextAccounts.some(n=>n.id===a.id)))fail();
  if(policy(clone(ledger),clone(request))!==true)throw new ResourceLedgerError('NOT_AVAILABLE');
  const before=balanceMap(ledger.balances),after=balanceMap(nextBalances),postings=[];
  for(const k of new Set([...before.keys(),...after.keys()])){const delta=(after.get(k)??0n)-(before.get(k)??0n);if(delta){const[account_id,resource_id,lot_id,unit]=JSON.parse(k);postings.push({account_id,resource_id,lot_id,unit,delta:Number(delta)});}}
  const applied=post(nextAccounts,ledger.balances,postings,issuance);
  const last=ledger.entries.at(-1);if(ctx.simulation_time_ms<(last?.context.simulation_time_ms??ledger.checkpoint.simulation_time_ms))fail();
  const entry={sequence:ledger.sequence+1,context:ctx,request_hash:digest(request),postings,credits:issuance,accounts:nextAccounts.filter(a=>!previous.has(a.id)),previous_hash:last?.hash??ledger.checkpoint.hash};
  for(const c of issuance)ledger.issued_totals[c.resource_id]=safe(BigInt(own(ledger.issued_totals,c.resource_id))+BigInt(c.quantity));
  ledger.entries.push({...entry,hash:digest(entry)});ledger.accounts=nextAccounts;ledger.balances=applied;ledger.sequence++;
  if(ledger.entries.length>32){const removed=ledger.entries.shift();ledger.checkpoint.balances=post(ledger.accounts,ledger.checkpoint.balances,removed.postings,removed.credits);for(const c of removed.credits)ledger.checkpoint.issued_totals[c.resource_id]=safe(BigInt(own(ledger.checkpoint.issued_totals,c.resource_id))+BigInt(c.quantity));ledger.checkpoint.sequence=removed.sequence;ledger.checkpoint.simulation_time_ms=removed.context.simulation_time_ms;ledger.checkpoint.hash=removed.hash;}
  return validateResourceBalances(ledger);
}
/** Independent schema clone for a registered domain's persisted state. */
export function resourceBalancesSchema(){return clone(schema);}
