import { Context, Function as Fn, Schema } from "effect"
import type { Effect } from "effect"
import {
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./json-value.js"

/** Text or structured context describing one judgment. */
export type Description = string | JsonObject | ReadonlyArray<JsonValue>
/** Runtime boundary for meaningful text or structured judgment context. */
export const DescriptionSchema = Schema.Union([
  Schema.String.check(Schema.isNonEmpty()),
  Schema.Record(Schema.String, JsonValueSchema),
  Schema.Array(JsonValueSchema),
])
/** A finite probability, distinct from distribution concentration. */
export const ProbabilitySchema = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
)
/** Safe identifier for a question or a model. */
export const EvaluationNameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
)
/** A yes/no judgment. */
export interface NoulQuestion {
  readonly _tag: "Noul"
  readonly instructions: Description
  readonly criteria?: Readonly<Record<"true" | "false", Description>>
}
/** A judgment over explicitly described options. */
export interface ChoiceQuestion<K extends string = string> {
  readonly _tag: "Choice"
  readonly instructions: Description
  readonly criteria: Readonly<Record<K, Description>>
}
/** A judgment against ordered levels. */
export interface ScoreQuestion {
  readonly _tag: "Score"
  readonly instructions: Description
  readonly levels: readonly [Description, Description, ...Description[]]
}
/** One supported judgment. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion
/** Independent questions evaluated against the same state. */
export type QuestionMap = Readonly<Record<string, Question>>

const QuestionSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Noul"),
    instructions: DescriptionSchema,
    criteria: Schema.optional(Schema.Struct({ true: DescriptionSchema, false: DescriptionSchema })),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Choice"),
    instructions: DescriptionSchema,
    criteria: Schema.Record(EvaluationNameSchema, DescriptionSchema).check(
      Schema.makeFilter((value) => Object.keys(value).length >= 2),
    ),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Score"),
    instructions: DescriptionSchema,
    levels: Schema.Array(DescriptionSchema).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(10),
    ),
  }),
])
const QuestionsSchema = Schema.Record(
  EvaluationNameSchema,
  QuestionSchema,
).check(Schema.makeFilter((value) => Object.keys(value).length > 0))
const batchIdentity = Symbol("EvaluationBatch")

/** Validated definition retaining exact question keys and choices. */
export interface Batch<Q extends QuestionMap> {
  readonly questions: Q
  readonly [batchIdentity]: true
}

/** Define a yes/no question with optional descriptions for both outcomes. */
export const noul = (
  instructions: Description,
  criteria?: Readonly<Record<"true" | "false", Description>>,
): NoulQuestion => {
  const question: NoulQuestion = criteria === undefined
    ? { _tag: "Noul", instructions }
    : { _tag: "Noul", instructions, criteria }
  Schema.decodeUnknownSync(QuestionSchema)(question)
  return question
}
/** Define a choice and preserve its literal option names. */
export const choice = <const C extends Readonly<Record<string, Description>>>(
  instructions: Description,
  criteria: C,
): ChoiceQuestion<keyof C & string> => {
  const question = {
    _tag: "Choice",
    instructions,
    criteria,
  } satisfies ChoiceQuestion<keyof C & string>
  Schema.decodeUnknownSync(QuestionSchema)(question)
  return question
}
/** Define an ordered rubric of two to ten levels. */
export const score = (
  instructions: Description,
  levels: readonly [Description, Description, ...Description[]],
): ScoreQuestion => {
  const question: ScoreQuestion = { _tag: "Score", instructions, levels }
  Schema.decodeUnknownSync(QuestionSchema)(question)
  return question
}
/** Validate and snapshot independent questions before evaluating them. */
export const batch = <const Q extends QuestionMap>(questions: Q): Batch<Q> => {
  const parsed = Schema.decodeUnknownSync(QuestionsSchema)(
    structuredClone(questions),
  )
  // SAFETY: the parser preserves every input key, discriminator and option label.
  return { questions: Fn.cast<typeof parsed, Q>(parsed), [batchIdentity]: true }
}

/** Typed result for one question, including the full probability distribution. */
export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? { readonly _tag: "Noul"; readonly probability: number }
  : Q extends ChoiceQuestion<infer K>
    ? {
        readonly _tag: "Choice"
        readonly value: K
        readonly probabilities: Readonly<Record<K, number>>
        readonly confidence: number
      }
    : {
        readonly _tag: "Score"
        readonly value: number
        readonly probabilities: ReadonlyArray<number>
        readonly confidence: number
      }
/** Answers and content-free usage metadata for one evaluation. */
export interface Evaluation<Q extends QuestionMap> {
  readonly answers: { readonly [K in keyof Q]: AnswerFor<Q[K]> }
  readonly model: string
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
}

/** Caller input cannot be evaluated within the configured contract. */
export class EvaluationInputRejected extends Schema.TaggedError<EvaluationInputRejected>()(
  "EvaluationInputRejected",
  {
    reason: Schema.Literals([
      "invalid_state",
      "invalid_questions",
      "budget_exceeded",
    ]),
  },
) {}
/** TypeSafe rejected the request permanently. */
export class TypeSafeRequestRejected extends Schema.TaggedError<TypeSafeRequestRejected>()(
  "TypeSafeRequestRejected",
  {
    reason: Schema.Literals([
      "unauthorized",
      "forbidden",
      "invalid_request",
      "not_found",
    ]),
  },
) {}
/** A transient provider or transport failure prevented evaluation. */
export class TypeSafeUnavailable extends Schema.TaggedError<TypeSafeUnavailable>()(
  "TypeSafeUnavailable",
  {
    reason: Schema.Literals([
      "network",
      "timeout",
      "rate_limited",
      "overloaded",
      "server",
    ]),
  },
) {}
/** The provider response did not satisfy the requested question contract. */
export class TypeSafeInvalidResponse extends Schema.TaggedError<TypeSafeInvalidResponse>()(
  "TypeSafeInvalidResponse",
  {
    reason: Schema.Literals([
      "invalid_json",
      "invalid_shape",
      "question_mismatch",
      "invalid_choice",
      "invalid_distribution",
    ]),
  },
) {}
/** Configuration failed before any provider request. */
export class TypeSafeConfigurationInvalid extends Schema.TaggedError<TypeSafeConfigurationInvalid>()(
  "TypeSafeConfigurationInvalid",
  {},
) {}
/** Expected failures from evaluating one batch. */
export type EvaluationError =
  | EvaluationInputRejected
  | TypeSafeRequestRejected
  | TypeSafeUnavailable
  | TypeSafeInvalidResponse
/** Application-owned upper bounds; these are not advertised provider limits. */
export interface EvaluationLimits {
  readonly maximumQuestions: number
  readonly maximumStateCharacters: number
}
/** Effect service contract for reusable TypeSafe judgments. */
export interface EvaluationService {
  readonly limits: EvaluationLimits
  readonly evaluate: <const Q extends QuestionMap>(input: {
    readonly state: Description
    readonly questions: Batch<Q>
  }) => Effect.Effect<Evaluation<Q>, EvaluationError>
}
/** Explicit capability supplied only to callers using TypeSafe. */
export class TypeSafeService extends Context.Service<
  TypeSafeService,
  EvaluationService
>()("@popcomputer/structured-chat/TypeSafe") {}
