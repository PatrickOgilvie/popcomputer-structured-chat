/**
 * Read an own property of a decoded record, or undefined when absent.
 *
 * Decoded state objects keep the ordinary Object prototype, and validated
 * field names such as `constructor` are legal keys, so lookups must not fall
 * through to inherited members.
 */
export const getOwn = <Owner extends object, Key extends keyof Owner>(
  value: Owner,
  key: Key,
): Owner[Key] | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined
