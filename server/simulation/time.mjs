// @ts-check
/** Monotonic server time; rollback never replays work. Units are integer milliseconds.
 * @param {number} wallNow @param {number} previous @returns {number}
 */
export function authoritativeTime(wallNow, previous) {
  if (![wallNow, previous].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new RangeError('INVALID_SIMULATION_TIME');
  return Math.max(wallNow, previous);
}
