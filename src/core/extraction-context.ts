import { Effect, Function as Fn, Schema } from "effect"
import type { AnswerFields, CollectStageState } from "./collect-stage.js"
import type { ConversationMessage } from "./conversation-message.js"
import { structuredDefinition, type StructuredDefinition } from "./definition.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"

/** Parsed state and selected fields available to application context enrichment. */
export interface ExtractionContextInput<Fields extends AnswerFields> {
  readonly accepted: CollectStageState<Fields>["accepted"]
  readonly extracting: ReadonlyArray<keyof Fields & string>
  readonly messages: ReadonlyArray<ConversationMessage>
}

/** Application context failed its JSON or serialized-size contract. */
export class InvalidExtractionContext extends Schema.TaggedError<InvalidExtractionContext>()(
  "InvalidExtractionContext",
  { reason: Schema.Literals(["invalid_shape", "budget_exceeded"]) },
) {}

interface ContextRuntime {
  readonly build: (input: ExtractionContextInput<AnswerFields>) => Effect.Effect<JsonValue, unknown, unknown>
}
const contextRuntime = Symbol("ExtractionContextRuntime")

/** Authentic application context capability bound to one field registry. */
export interface ExtractionContextContract extends StructuredDefinition<"extraction_context"> {
  readonly fields: AnswerFields
  readonly [contextRuntime]: ContextRuntime
}

/** Context enrichment preserves the application's expected errors and service requirements. */
export interface ExtractionContext<Fields extends AnswerFields, Error, Requirements>
  extends ExtractionContextContract {
  readonly fields: Fields
  readonly build: (input: ExtractionContextInput<Fields>) => Effect.Effect<JsonValue, Error, Requirements>
}

/** Errors introduced by application context enrichment. */
export type ExtractionContextError<C> =
  C extends ExtractionContext<infer _Fields, infer E, infer _R> ? E | InvalidExtractionContext : never
/** Services introduced by application context enrichment. */
export type ExtractionContextRequirements<C> =
  C extends ExtractionContext<infer _Fields, infer _E, infer R> ? R : never

/** Bind an Effect-native context builder to the stage's exact fields.
 * @template Fields, E, R Field definitions, expected failures and required services.
 */
export const defineExtractionContext = <const Fields extends AnswerFields, E, R>(
  fields: Fields,
  build: (input: ExtractionContextInput<Fields>) => Effect.Effect<JsonValue, E, R>,
): ExtractionContext<Fields, E, R> => {
  // SAFETY: the owning stage checks the exact field registry before supplying
  // parsed state and selected keys to this erased runtime function.
  const runtimeBuild = Fn.cast<typeof build, ContextRuntime["build"]>(build)
  return structuredDefinition("extraction_context")({ fields, build, [contextRuntime]: { build: runtimeBuild } })
}

/** @internal Build and parse owned application data; it never becomes a trusted instruction.
 * @template C The bound context capability.
 */
export const runExtractionContext = <C extends ExtractionContextContract>(
  context: C,
  input: ExtractionContextInput<AnswerFields>,
): Effect.Effect<JsonValue, ExtractionContextError<C>, ExtractionContextRequirements<C>> => {
  const execution = context[contextRuntime].build(input).pipe(
    Effect.flatMap(value => Schema.decodeUnknownEffect(JsonValueSchema)(value).pipe(
      Effect.mapError(() => new InvalidExtractionContext({ reason: "invalid_shape" })),
    )),
    Effect.flatMap(value => JSON.stringify(value).length <= 20_000
      ? Effect.succeed(value)
      : Effect.fail(new InvalidExtractionContext({ reason: "budget_exceeded" }))),
  )
  // SAFETY: the sealed runtime preserves this capability's E/R; parsing adds
  // only InvalidExtractionContext, represented in ExtractionContextError.
  return Fn.cast<typeof execution, Effect.Effect<JsonValue, ExtractionContextError<C>, ExtractionContextRequirements<C>>>(execution)
}
