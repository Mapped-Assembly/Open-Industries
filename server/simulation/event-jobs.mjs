import { copyJson } from './json.mjs';
import { canonicalCommand } from './commands.mjs';
import { EventClockError } from './event-clock.mjs';
const fail=()=>{throw new EventClockError('INVALID_JOB_CHECKPOINT');};
const terminal=new Set(['completed','cancelled','failed']);
/** Validate event-driven checkpoints without quantizing variable-rate phases or zero-time effects.
 * @param {unknown} raw @returns {import('./event-runtime-contracts.js').EventJob[]}
 */
export function validateEventJobs(raw){
  const jobs=copyJson(raw,fail);if(!Array.isArray(jobs)||jobs.length>1024)fail();
  const ids=new Set();
  for(const j of jobs){
    if(Object.keys(j).sort().join(',')!=='checkpoint,id,kind,owner_id,progress_ms,reason,state'
      ||typeof j.id!=='string'||!j.id.length||j.id.length>128||ids.has(j.id)||typeof j.owner_id!=='string'||!j.owner_id.length||j.owner_id.length>128
      ||typeof j.kind!=='string'||!j.kind.length||j.kind.length>128
      ||!['queued','running','waiting-for-resource','paused','completed','cancelled','failed'].includes(j.state)
      ||!Number.isSafeInteger(j.progress_ms)||j.progress_ms<0
      ||(j.reason!==null&&(typeof j.reason!=='string'||j.reason.length>256))
      ||(['paused','waiting-for-resource','failed','cancelled'].includes(j.state)!==(j.reason!==null))
      ||(j.state==='queued'&&j.progress_ms!==0)||!j.checkpoint||typeof j.checkpoint!=='object'||Array.isArray(j.checkpoint))fail();
    ids.add(j.id);
  }
  return jobs;
}
/** Enforce identity, monotonic paid progress and immutable terminal checkpoints on a pure proposal.
 * @param {unknown} before @param {unknown} after
 * @param {{allowCreate?:boolean;allowPrune?:boolean;maxProgress?:number}} [options]
 * @returns {import('./event-runtime-contracts.js').EventJob[]}
 */
export function transitionEventJobs(before,after,{allowCreate=false,allowPrune=false,maxProgress=Number.MAX_SAFE_INTEGER}={}){
  if(!Number.isSafeInteger(maxProgress)||maxProgress<0)fail();
  const previous=validateEventJobs(before),next=validateEventJobs(after),old=new Map(previous.map(j=>[j.id,j]));
  for(const j of next){
    const prior=old.get(j.id);
    if(!prior){if(!allowCreate)fail();continue;}
    if((j.state==='queued'&&prior.state!=='queued')||j.owner_id!==prior.owner_id||j.kind!==prior.kind||j.progress_ms<prior.progress_ms||j.progress_ms-prior.progress_ms>maxProgress)fail();
    if(terminal.has(prior.state)&&canonicalCommand(j)!==canonicalCommand(prior))fail();
  }
  for(const j of previous)if(!next.some(n=>n.id===j.id)&&(!allowPrune||!terminal.has(j.state)))fail();
  return next;
}
