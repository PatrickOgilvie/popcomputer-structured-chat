import { Effect, Schema } from "effect"

/** Primitive value representable by JSON. */
export type JsonPrimitive = string | number | boolean | null

/** Object value representable by JSON. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** Recursively typed value accepted at serialized JSON boundaries. */
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>

/** Runtime parser for recursively JSON-serializable values. */
export const JsonValueSchema: Schema.Codec<JsonValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
)

/** @internal Encode a decoded value with its codec and prove the result is JSON. */
export const encodeJsonValue = <
  S extends Schema.Constraint & { readonly EncodingServices: never },
>(
  schema: S,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the codec owns the value's shape; this boundary only proves JSON transportability
  value: unknown,
  options?: { readonly onExcessProperty?: "error" },
): Effect.Effect<JsonValue, Schema.SchemaError> =>
  Schema.encodeUnknownEffect(schema)(value, options).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonValueSchema)),
  )
