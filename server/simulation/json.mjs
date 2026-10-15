// @ts-check
/**
 * Copy bounded JSON without implicit coercion or executing accessors/toJSON.
 * @template T
 * @param {T} value
 * @param {() => never} invalid
 * @returns {T}
 */
export function copyJson(value, invalid) {
  /** @type {Set<object>} */
  const visiting = new Set();
  let count = 0;
  /** @param {unknown} item @param {number} depth @returns {void} */
  const inspect = (item, depth) => {
    if (++count > 100000 || depth > 64) invalid();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid();
      return;
    }
    if (typeof item !== 'object' || visiting.has(item)) invalid();
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      invalid();
    if (Object.getOwnPropertySymbols(item).length) invalid();
    visiting.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const descriptor of Object.values(descriptors))
      if (descriptor.get || descriptor.set) invalid();
    if (Array.isArray(item)) {
      if (Object.keys(item).some((k) => !/^(0|[1-9][0-9]*)$/.test(k))) invalid();
      for (const child of item) inspect(child, depth + 1);
    } else {
      for (const descriptor of Object.values(descriptors))
        if (descriptor.enumerable) inspect(descriptor.value, depth + 1);
    }
    visiting.delete(item);
  };
  /** @type {string} */
  let text;
  try {
    inspect(value, 0);
    text = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (text === undefined || Buffer.byteLength(text) > 2 * 1024 * 1024) invalid();
  return JSON.parse(text);
}
