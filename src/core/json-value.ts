import { Schema } from "effect"

/** Primitive value representable by JSON. */
export type JsonPrimitive = string | number | boolean | null

/** Object value representable by JSON. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** Recursively typed value accepted at serialized JSON boundaries. */
export type JsonValue =
  | JsonPrimitive
  | JsonObject
  | ReadonlyArray<JsonValue>

/** Runtime parser for recursively JSON-serializable values. */
export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.String,
      Schema.JsonNumber,
      Schema.Boolean,
      Schema.Null,
      Schema.Array(JsonValueSchema),
      Schema.Record({ key: Schema.String, value: JsonValueSchema }),
    ),
)
