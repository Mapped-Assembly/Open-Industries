// @ts-check
import { copyJson } from './json.mjs';
import { authoritativeTime } from './time.mjs';

/** Invalid or regressing checkpoints cannot award time or replay an effect. */
export class EventClockError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.name = 'EventClockError'; this.code = code; }
}
const invalid = () => { throw new EventClockError('INVALID_EVENT_CLOCK'); };
/**
 * Common bounded clock driver for fixed quanta and domain-defined event boundaries.
 * Policies select rates/next boundaries; only this driver advances the committed cursor.
 * @template {{instance_id:string,cursor_ms:number,observed_at_ms:number}} T
 * @param {T} raw
 * @param {number} wallNow
 * @param {number} budget
 * @param {{settle?:(state:T,at:number)=>void;next:(state:T,remaining:number)=>number;step:(state:T,context:{from_ms:number;at_ms:number;duration_ms:number;effect_id:string})=>void;validate:(state:T)=>void}} policy
 * @returns {T}
 */
export function advanceEventClock(raw, wallNow, budget, policy) {
  const state = copyJson(raw, invalid);
  if (!Number.isSafeInteger(state.cursor_ms) || state.cursor_ms < 0
    || !Number.isSafeInteger(state.observed_at_ms) || state.observed_at_ms < state.cursor_ms
    || !Number.isSafeInteger(budget) || budget < 1 || budget > 1000) invalid();
  policy.validate(state);
  state.observed_at_ms = authoritativeTime(wallNow,state.observed_at_ms);
  const target=state.observed_at_ms;
  const settle=()=>{const cursor=state.cursor_ms;policy.settle?.(state,cursor);if(state.cursor_ms!==cursor||state.observed_at_ms!==target)invalid();};
  settle();
  for (let n=0;n<budget && state.cursor_ms < state.observed_at_ms;n++) {
    const remaining = state.observed_at_ms-state.cursor_ms;
    const from = state.cursor_ms;
    const dt = policy.next(state,remaining);
    if(state.cursor_ms!==from||state.observed_at_ms!==target)invalid();
    // Zero means a fixed-quantum policy has less than one complete quantum of debt.
    if (dt === 0) break;
    if (!Number.isSafeInteger(dt) || dt < 1 || dt > remaining) invalid();
    const at = from+dt;
    policy.step(state,{from_ms:from,at_ms:at,duration_ms:dt,effect_id:`${state.instance_id}:time:${from}:${at}`});
    if (state.cursor_ms !== from || state.observed_at_ms !== target) invalid();
    state.cursor_ms=at;
    settle();
  }
  policy.validate(state);
  return state;
}
