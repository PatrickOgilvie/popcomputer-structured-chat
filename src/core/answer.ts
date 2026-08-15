import { Effect, Schema } from "effect"
import type {
  ChoiceQuestion,
  FixedQuestion,
  QuestionDefinition,
  QuestionDefinitionContract,
} from "./question.js"

/** How strongly a collect-stage answer must be grounded in user messages. */
export const AnswerModeSchema = Schema.Literal(
  "semantic",
  "explicit",
  "confirmed",
)

/** How strongly a collect-stage answer must be grounded in user messages. */
export type AnswerMode = Schema.Schema.Type<typeof AnswerModeSchema>

const AnswerDescriptionSchema = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(1_000),
)

/** Minimum runtime shape retained for every collect-stage answer. */
export interface AnswerDefinitionContract {
  readonly _tag: "AnswerDefinition"
  readonly mode: AnswerMode
  readonly schema: Schema.Schema.AnyNoContext
  readonly description: string
  readonly question: QuestionDefinitionContract
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
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error = never,
  Requirements = never,
> extends AnswerDefinitionContract {
  readonly mode: Mode
  readonly schema: ValueSchema
  readonly question: QuestionDefinition<Schema.Schema.Type<ValueSchema>>
  readonly validate?: (
    value: Schema.Schema.Type<ValueSchema>,
  ) => Effect.Effect<void, Error, Requirements>
  readonly reject?: {
    readonly ask:
      | FixedQuestion
      | ChoiceQuestion<Schema.Schema.Type<ValueSchema>>
  }
  readonly escape?: {
    readonly value: Schema.Schema.Type<ValueSchema>
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

const defineAnswer = <
  const Mode extends AnswerMode,
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  mode: Mode,
  schema: ValueSchema,
  input: DefineAnswerInput<
    Schema.Schema.Type<ValueSchema>,
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
  const withEscape =
    input.escape === undefined
      ? base
      : {
          ...base,
          escape: {
            value: Schema.validateSync(schema)(input.escape.value),
          },
        }
  return input.validate === undefined
    ? withEscape
    : {
        ...withEscape,
        validate: input.validate,
        reject: input.reject,
      }
}

function semantic<ValueSchema extends Schema.Schema.AnyNoContext>(
  schema: ValueSchema,
  input: DefineUnvalidatedAnswerInput<Schema.Schema.Type<ValueSchema>>,
): AnswerDefinition<"semantic", ValueSchema, never, never>
function semantic<
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineValidatedAnswerInput<
    Schema.Schema.Type<ValueSchema>,
    Error,
    Requirements
  >,
): AnswerDefinition<"semantic", ValueSchema, Error, Requirements>
function semantic<
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineAnswerInput<
    Schema.Schema.Type<ValueSchema>,
    Error,
    Requirements
  >,
) {
  return defineAnswer("semantic", schema, input)
}

function explicit<ValueSchema extends Schema.Schema.AnyNoContext>(
  schema: ValueSchema,
  input: DefineUnvalidatedAnswerInput<Schema.Schema.Type<ValueSchema>>,
): AnswerDefinition<"explicit", ValueSchema, never, never>
function explicit<
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineValidatedAnswerInput<
    Schema.Schema.Type<ValueSchema>,
    Error,
    Requirements
  >,
): AnswerDefinition<"explicit", ValueSchema, Error, Requirements>
function explicit<
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineAnswerInput<
    Schema.Schema.Type<ValueSchema>,
    Error,
    Requirements
  >,
) {
  return defineAnswer("explicit", schema, input)
}

function confirmed<ValueSchema extends Schema.Schema.AnyNoContext>(
  schema: ValueSchema,
  input: DefineUnvalidatedAnswerInput<Schema.Schema.Type<ValueSchema>>,
): AnswerDefinition<"confirmed", ValueSchema, never, never>
function confirmed<
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineValidatedAnswerInput<
    Schema.Schema.Type<ValueSchema>,
    Error,
    Requirements
  >,
): AnswerDefinition<"confirmed", ValueSchema, Error, Requirements>
function confirmed<
  ValueSchema extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  schema: ValueSchema,
  input: DefineAnswerInput<
    Schema.Schema.Type<ValueSchema>,
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
} as const
