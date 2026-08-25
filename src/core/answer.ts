import { cast, Effect, Pipeable, Schema } from "effect"
import type { JsonValue } from "./json-value.js"
import type {
  ChoiceQuestion,
  FixedQuestion,
  QuestionDefinition,
  QuestionDefinitionContract,
} from "./question.js"

/** How strongly a collect-stage answer must be grounded in user messages. */
export const AnswerModeSchema = Schema.Literals([
  "semantic",
  "explicit",
  "confirmed",
])

/** How strongly a collect-stage answer must be grounded in user messages. */
export type AnswerMode = Schema.Schema.Type<typeof AnswerModeSchema>

const AnswerDescriptionSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_000),
)

type AnswerPresentation =
  | { readonly _tag: "Hidden" }
  | {
      readonly _tag: "VisibleToUser"
      readonly label?: string
    }

const answerPresentation = Symbol(
  "@popcomputer/structured-chat/AnswerPresentation",
)

const VisibleToUserOptionsSchema = Schema.Struct({
  label: Schema.optionalKey(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(100),
    ),
  ),
})

/** Optional display policy applied to one user-visible answer. */
export interface VisibleToUserOptions {
  readonly label?: string
}

/** Minimum runtime shape retained for every collect-stage answer. */
export interface AnswerDefinitionContract extends Pipeable.Pipeable {
  readonly _tag: "AnswerDefinition"
  readonly mode: AnswerMode
  readonly schema: Schema.ConstraintCodec<unknown, unknown>
  readonly description: string
  readonly question: QuestionDefinitionContract
  readonly [answerPresentation]: AnswerPresentation
  readonly validate?: (
    value: never,
  ) => Effect.Effect<void, unknown, unknown>
  readonly reject?: {
    readonly ask: FixedQuestion | ChoiceQuestion<unknown>
  }
  readonly escape?: {
    readonly value: unknown
  }
}

/** One typed fact required by a collect stage. */
export interface AnswerDefinition<
  Mode extends AnswerMode,
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error = never,
  Requirements = never,
> extends AnswerDefinitionContract {
  readonly mode: Mode
  readonly schema: ValueSchema
  readonly question: QuestionDefinition<ValueSchema["Type"]>
  readonly validate?: (
    value: ValueSchema["Type"],
  ) => Effect.Effect<void, Error, Requirements>
  readonly reject?: {
    readonly ask:
      | FixedQuestion
      | ChoiceQuestion<ValueSchema["Type"]>
  }
  readonly escape?: {
    readonly value: ValueSchema["Type"]
  }
}

interface DefineAnswerBase<Value> {
  readonly description: string
  readonly ask: QuestionDefinition<Value>
  /**
   * Application-authored value accepted when the user chooses the stage's
   * uncertainty escape for this field. Without it, an escaped field stays
   * unresolved and its question is asked again from another angle.
   */
  readonly escape?: {
    readonly value: Value
  }
}

/** Configuration for an answer accepted solely by its structural schema. */
export interface DefineUnvalidatedAnswerInput<Value>
  extends DefineAnswerBase<Value> {
  readonly validate?: undefined
  readonly reject?: undefined
}

/** Configuration for Effect-native domain acceptance and deterministic retry. */
export interface DefineValidatedAnswerInput<Value, Error, Requirements>
  extends DefineAnswerBase<Value> {
  readonly validate: (
    value: Value,
  ) => Effect.Effect<void, Error, Requirements>
  readonly reject: {
    readonly ask: FixedQuestion | ChoiceQuestion<Value>
  }
}

/** Configuration shared by all answer grounding modes. */
export type DefineAnswerInput<
  Value,
  Error = never,
  Requirements = never,
> =
  | DefineUnvalidatedAnswerInput<Value>
  | DefineValidatedAnswerInput<Value, Error, Requirements>

interface AnswerDefinitionSeed<
  Mode extends AnswerMode,
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
> {
  readonly _tag: "AnswerDefinition"
  readonly mode: Mode
  readonly schema: ValueSchema
  readonly description: string
  readonly question: QuestionDefinition<ValueSchema["Type"]>
  readonly validate?: (
    value: ValueSchema["Type"],
  ) => Effect.Effect<void, Error, Requirements>
  readonly reject?: {
    readonly ask:
      | FixedQuestion
      | ChoiceQuestion<ValueSchema["Type"]>
  }
  readonly escape?: {
    readonly value: ValueSchema["Type"]
  }
}

const makeAnswer = <
  const Mode extends AnswerMode,
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  seed: AnswerDefinitionSeed<
    Mode,
    ValueSchema,
    Error,
    Requirements
  >,
  presentation: AnswerPresentation,
): AnswerDefinition<Mode, ValueSchema, Error, Requirements> => {
  const answer = {
    ...seed,
    pipe() {
      return Pipeable.pipeArguments(this, arguments)
    },
  }
  Object.defineProperty(answer, answerPresentation, {
    value: presentation,
    enumerable: false,
    configurable: false,
    writable: false,
  })

  // SAFETY: defineProperty installed the private presentation policy while
  // the seed and pipe method retain the exact answer generics.
  return cast<
    typeof answer,
    AnswerDefinition<Mode, ValueSchema, Error, Requirements>
  >(answer)
}

/** @internal Read static user-presentation metadata without exposing policy tags. */
export const readAnswerUserPresentation = (
  answer: AnswerDefinitionContract,
): { readonly label?: string } | undefined => {
  const presentation = answer[answerPresentation]
  if (presentation._tag === "Hidden") {
    return undefined
  }

  return presentation.label === undefined
    ? {}
    : { label: presentation.label }
}

const defineAnswer = <
  const Mode extends AnswerMode,
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  mode: Mode,
  schema: ValueSchema,
  input: DefineAnswerInput<
    ValueSchema["Type"],
    Error,
    Requirements
  >,
): AnswerDefinition<Mode, ValueSchema, Error, Requirements> => {
  if (input.ask._tag === "ChoiceQuestion") {
    for (const option of input.ask.options) {
      Schema.decodeSync(schema)(option.value)
    }
  }
  if (input.ask._tag === "AdaptiveChoiceQuestion") {
    // A selected fallback label is later submitted as this answer's wire
    // value, so every label must decode against the answer schema.
    for (const label of input.ask.fallbackOptions) {
      Schema.decodeSync(schema)(label)
    }
  }
  if (input.reject?.ask._tag === "ChoiceQuestion") {
    for (const option of input.reject.ask.options) {
      Schema.decodeSync(schema)(option.value)
    }
  }

  const base = {
    _tag: "AnswerDefinition" as const,
    mode,
    schema,
    description: Schema.decodeSync(AnswerDescriptionSchema)(
      input.description,
    ),
    question: input.ask,
  }
  if (input.escape === undefined) {
    return input.validate === undefined
      ? makeAnswer(base, { _tag: "Hidden" })
      : makeAnswer({
          ...base,
          validate: input.validate,
          reject: input.reject,
        }, { _tag: "Hidden" })
  }

  const escape = {
    value: Schema.decodeSync(Schema.toType(schema))(input.escape.value),
  }
  return input.validate === undefined
    ? makeAnswer({ ...base, escape }, { _tag: "Hidden" })
    : makeAnswer({
        ...base,
        escape,
        validate: input.validate,
        reject: input.reject,
      }, { _tag: "Hidden" })
}

/** Mark one JSON-encodable answer for inclusion in user-facing snapshots. */
export const visibleToUser = (
  options: VisibleToUserOptions = {},
) =>
  <
    Mode extends AnswerMode,
    ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
    Error,
    Requirements,
  >(
    answer: Schema.Codec.Encoded<ValueSchema> extends JsonValue
      ? AnswerDefinition<Mode, ValueSchema, Error, Requirements>
      : never,
  ): AnswerDefinition<Mode, ValueSchema, Error, Requirements> => {
    const parsedOptions = Schema.decodeSync(VisibleToUserOptionsSchema)(
      options,
      { onExcessProperty: "error" },
    )
    const presentation: AnswerPresentation =
      parsedOptions.label === undefined
        ? { _tag: "VisibleToUser" }
        : {
            _tag: "VisibleToUser",
            label: parsedOptions.label,
          }

    return makeAnswer(answer, presentation)
  }

function semantic<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
>(
  schema: ValueSchema,
  input: DefineUnvalidatedAnswerInput<ValueSchema["Type"]>,
): AnswerDefinition<"semantic", ValueSchema, never, never>
function semantic<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineValidatedAnswerInput<
    ValueSchema["Type"],
    Error,
    Requirements
  >,
): AnswerDefinition<"semantic", ValueSchema, Error, Requirements>
function semantic<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineAnswerInput<
    ValueSchema["Type"],
    Error,
    Requirements
  >,
) {
  return defineAnswer("semantic", schema, input)
}

function explicit<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
>(
  schema: ValueSchema,
  input: DefineUnvalidatedAnswerInput<ValueSchema["Type"]>,
): AnswerDefinition<"explicit", ValueSchema, never, never>
function explicit<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineValidatedAnswerInput<
    ValueSchema["Type"],
    Error,
    Requirements
  >,
): AnswerDefinition<"explicit", ValueSchema, Error, Requirements>
function explicit<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineAnswerInput<
    ValueSchema["Type"],
    Error,
    Requirements
  >,
) {
  return defineAnswer("explicit", schema, input)
}

function confirmed<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
>(
  schema: ValueSchema,
  input: DefineUnvalidatedAnswerInput<ValueSchema["Type"]>,
): AnswerDefinition<"confirmed", ValueSchema, never, never>
function confirmed<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineValidatedAnswerInput<
    ValueSchema["Type"],
    Error,
    Requirements
  >,
): AnswerDefinition<"confirmed", ValueSchema, Error, Requirements>
function confirmed<
  ValueSchema extends Schema.ConstraintCodec<unknown, unknown>,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineAnswerInput<
    ValueSchema["Type"],
    Error,
    Requirements
  >,
) {
  return defineAnswer("confirmed", schema, input)
}

/** Constructors for semantic, explicit, and explicitly confirmed facts. */
export const Answer = {
  semantic,
  explicit,
  confirmed,
  visibleToUser,
} as const
