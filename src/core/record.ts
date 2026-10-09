import { Predicate, Schema, SchemaParser } from "effect"

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

/**
 * Parse a struct of application-named fields from own properties only.
 *
 * Effect resolves declared Struct fields through the prototype chain, so an
 * absent optional field named `constructor` would read
 * `Object.prototype.constructor` and fail. The struct instead parses a
 * null-prototype copy of the object's own enumerable properties, when decoding
 * and encoding alike, and still outputs ordinary objects.
 */
export const ownFields = <S extends Schema.Top>(struct: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [struct],
    ([codec]) =>
      (input, _ast, options) =>
        SchemaParser.decodeUnknownEffect(codec)(
          Predicate.isObject(input)
            ? Object.assign(Object.create(null), input)
            : input,
          options,
        ),
  )
